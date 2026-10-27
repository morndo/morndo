#!/bin/sh
# Before `morndo install` over a machine: backup.sh <dest> [--db name=path]... [--allow-unlisted] [--no-db]
# Copies the morndo-* user units (with their drop-in folders) and the ~/.local/bin/morndo* wrappers, records which units
# were active/enabled, takes an online copy of each database (the hub, fleet and node databases are found by
# themselves), and writes <dest>/restore.sh and <dest>/ROLLBACK.md. Refuses a <dest> that exists; a failure after the
# folder is made removes it again.
set -eu

usage() { echo "usage: backup.sh <dest> [--db name=path]... [--allow-unlisted] [--no-db]" >&2; exit 2; }

[ $# -ge 1 ] || usage
dest=$1
shift
dbs=""
allow=no
nodb=no
while [ $# -gt 0 ]; do
  case $1 in
    --db) [ $# -ge 2 ] || usage; dbs="$dbs
$2"; shift 2 ;;
    --allow-unlisted) allow=yes; shift ;;
    --no-db) nodb=yes; shift ;;
    *) usage ;;
  esac
done

if [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "backup.sh: $dest exists; use a new folder" >&2
  exit 1
fi
case $dest in /*) ;; *) dest=$PWD/$dest ;; esac

here=$(cd "$(dirname "$0")" && pwd)
units="$HOME/.config/systemd/user"
bin="$HOME/.local/bin"
sc=${C6_SYSTEMCTL:-systemctl}
NL='
'

# node first: nothing is written without it.
if [ -n "${C6_NODE:-}" ]; then
  [ -x "$C6_NODE" ] || { echo "backup.sh: C6_NODE=$C6_NODE is not executable" >&2; exit 1; }
  node=$C6_NODE
elif command -v node >/dev/null 2>&1; then
  node=$(command -v node)
else
  node=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)
  [ -n "$node" ] && [ -x "$node" ] || { echo "backup.sh: no node found (set C6_NODE)" >&2; exit 1; }
fi

# The databases: the ones named, the machine's three when present, and a refusal for any other we can see.
has_name() { printf '%s\n' "$dbs" | grep -q "^$1="; }
has_path() { printf '%s\n' "$dbs" | grep -qF "=$1"; }
for def in "hub=$HOME/.local/share/morndo/morndo.db" "fleet=$HOME/.local/share/morndo-fleet/fleet.db" "node=$HOME/.local/state/morndo-node/agent.db"; do
  if [ -f "${def#*=}" ] && ! has_name "${def%%=*}"; then dbs="$dbs$NL$def"; fi
done
if [ "$nodb" = no ]; then
  stray=""
  for root in "$HOME/.local/share" "$HOME/.local/state"; do
    for d in "$root"/morndo*; do
      [ -d "$d" ] || continue
      case ${d##*/} in morndo-update|morndo-releases) continue ;; esac
      found=$(find "$d" -type f -name '*.db' 2>/dev/null || true)
      oldIFS=$IFS; IFS=$NL
      for f in $found; do
        [ -n "$f" ] || continue
        case $f in */morndo-update/*|*/morndo-releases/*) continue ;; esac
        has_path "$f" || stray="$stray $f"
      done
      IFS=$oldIFS
    done
  done
  if [ -n "$stray" ] && [ "$allow" = no ]; then
    echo "backup.sh: databases found that this backup would not hold:$stray" >&2
    echo "backup.sh: name them with --db name=path, or pass --allow-unlisted" >&2
    exit 1
  fi
  if ! printf '%s' "$dbs" | grep -q '[^[:space:]]'; then
    echo "backup.sh: no database found; pass --db name=path, or --no-db if this machine has none" >&2
    exit 1
  fi
fi

oldIFS=$IFS
IFS=$NL
for spec in $dbs; do
  [ -n "$spec" ] || continue
  case $spec in
    ?*=?*) ;;
    *) echo "backup.sh: --db wants name=path, got: $spec" >&2; exit 2 ;;
  esac
  if [ ! -f "${spec#*=}" ]; then
    echo "backup.sh: no database at ${spec#*=}" >&2
    exit 1
  fi
done
IFS=$oldIFS

created=no
finished=no
trap 'if [ "$created" = yes ] && [ "$finished" != yes ]; then rm -rf "${dest:?}"; echo "backup.sh: failed; $dest removed" >&2; fi' EXIT
mkdir -p "$(dirname "$dest")"
mkdir "$dest"
created=yes
mkdir "$dest/units" "$dest/wrappers" "$dest/dbs"

printf 'host=%s\nhome=%s\n' "${C6_HOSTNAME:-$(uname -n)}" "$HOME" > "$dest/machine.txt"

for f in "$units"/morndo-*; do
  if [ -e "$f" ] || [ -L "$f" ]; then cp -a "$f" "$dest/units/"; fi
done
for f in "$bin"/morndo*; do
  if [ -f "$f" ] || [ -L "$f" ]; then cp -a "$f" "$dest/wrappers/"; fi
done

: > "$dest/state.txt"
for f in "$dest"/units/morndo-*.service "$dest"/units/morndo-*.timer; do
  [ -f "$f" ] || continue
  u=${f##*/}
  case $u in *@*) continue ;; esac
  if "$sc" --user is-active "$u" >/dev/null 2>&1; then a=yes; else a=no; fi
  if "$sc" --user is-enabled "$u" >/dev/null 2>&1; then e=yes; else e=no; fi
  printf '%s active=%s enabled=%s\n' "$u" "$a" "$e" >> "$dest/state.txt"
done

cp "$here/db-backup.ts" "$dest/db-backup.ts"
printf '%s\n' "$node" > "$dest/dbs/node-path.txt"
: > "$dest/dbs/paths.txt"
: > "$dest/dbs/schema.txt"
IFS=$NL
for spec in $dbs; do
  [ -n "$spec" ] || continue
  name=${spec%%=*}
  src=${spec#*=}
  sig=$("$node" --no-warnings "$dest/db-backup.ts" backup "$src" "$dest/dbs/$name.db")
  printf '%s=%s\n' "$name" "$src" >> "$dest/dbs/paths.txt"
  printf '%s=%s\n' "$name" "$sig" >> "$dest/dbs/schema.txt"
done
IFS=$oldIFS

cat > "$dest/restore.sh" <<'RESTORE'
#!/bin/sh
# Puts the machine's units, drop-ins and wrappers back as backup.sh found them.
#   --deadman    the unattended run (the dead-man's unit): exits 0 at once when the folder holds an `ok` file
#   --with-db    also put the databases back (loses writes since the backup); needed when the schema changed
#   --keep-data  put the old code back on the databases as they are, even when their schema changed
# Refuses another host (exit 3) and a changed schema (exit 4) before it touches anything.
set -eu
bk=$(cd "$(dirname "$0")" && pwd)
sc=${C6_SYSTEMCTL:-systemctl}
units="$HOME/.config/systemd/user"
bin="$HOME/.local/bin"

deadman=no
withdb=no
keep=no
for a in "$@"; do
  case $a in
    --deadman) deadman=yes ;;
    --with-db) withdb=yes ;;
    --keep-data) keep=yes ;;
    *) echo "usage: restore.sh [--deadman] [--with-db] [--keep-data]" >&2; exit 2 ;;
  esac
done

if [ -e "$bk/ok" ]; then
  if [ "$deadman" = yes ]; then exit 0; fi
  echo "restore.sh: an ok marker exists in $bk; it is ignored for a manual run, restoring" >&2
fi

rec_host=$(sed -n 's/^host=//p' "$bk/machine.txt" 2>/dev/null | head -n 1 || true)
rec_home=$(sed -n 's/^home=//p' "$bk/machine.txt" 2>/dev/null | head -n 1 || true)
cur_host=${C6_HOSTNAME:-$(uname -n)}
if [ "$rec_host" != "$cur_host" ] || [ "$rec_home" != "$HOME" ]; then
  echo "restore.sh: this backup was made on host '$rec_host' under HOME '$rec_home'; this is '$cur_host' under '$HOME'. Nothing changed." >&2
  exit 3
fi

node=${C6_NODE:-$(cat "$bk/dbs/node-path.txt" 2>/dev/null || echo node)}

# A changed schema: the old code on it may break; say so and stop, before anything is touched.
if [ "$withdb" = no ] && [ "$keep" = no ] && [ -s "$bk/dbs/schema.txt" ]; then
  changed=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%=*}
    want=${line#*=}
    path=$(sed -n "s/^$name=//p" "$bk/dbs/paths.txt" | head -n 1)
    [ -f "$path" ] || continue
    live=$("$node" --no-warnings "$bk/db-backup.ts" signature "$path" 2>/dev/null) || live=unreadable
    [ "$live" = "$want" ] || changed="$changed $name($path)"
  done < "$bk/dbs/schema.txt"
  if [ -n "$changed" ]; then
    echo "restore.sh: the schema of$changed changed since the backup; the old code may not run on it. Nothing changed." >&2
    echo "restore.sh: --with-db puts the old data back (loses the writes made since the backup); --keep-data restores the old code on the newer schema anyway." >&2
    exit 4
  fi
fi

# From the state recorded at backup time: services to restart, timers to enable.
services=""
timers=""
while read -r u a e; do
  [ -n "$u" ] || continue
  case $u in
    *.service) [ "$a" = "active=yes" ] && services="$services $u" ;;
    *.timer) [ "$e" = "enabled=yes" ] && timers="$timers $u" ;;
  esac
done < "$bk/state.txt"

if [ "$withdb" = yes ]; then
  for s in $services; do "$sc" --user stop "$s" || true; done
fi

# What the install added: units and drop-in folders of ours that the backup does not hold.
for f in "$units"/morndo-*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  if [ -e "$bk/units/$name" ] || [ -L "$bk/units/$name" ]; then continue; fi
  case $name in
    *.service|*.timer) "$sc" --user disable --now "$name" || true ;;
  esac
  rm -rf -- "${units:?}/${name:?}"
done

# What the backup held goes back whole (a folder is replaced, so a drop-in the install added leaves with it).
for f in "$bk"/units/*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  rm -rf -- "${units:?}/${name:?}"
  cp -a "$f" "$units/"
done
mkdir -p "$bin"
# Launcher links the install added (into morndo-releases/) that the backup does not hold; never a regular file.
for f in "$bin"/*; do
  [ -L "$f" ] || continue
  name=${f##*/}
  case $(readlink "$f") in *morndo-releases/*) ;; *) continue ;; esac
  if [ -e "$bk/wrappers/$name" ] || [ -L "$bk/wrappers/$name" ]; then continue; fi
  rm -f -- "${bin:?}/${name:?}"
done
for f in "$bk"/wrappers/*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  rm -f -- "${bin:?}/${name:?}"
  cp -a "$f" "$bin/"
done

"$sc" --user daemon-reload

if [ "$withdb" = yes ]; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%=*}
    path=${line#*=}
    rm -f -- "${path:?}-wal" "${path:?}-shm"
    cp -p "$bk/dbs/$name.db" "$path"
  done < "$bk/dbs/paths.txt"
fi

# Try every unit; one that fails does not stop the others.
failed=""
for s in $services; do
  if ! "$sc" --user restart "$s"; then failed="$failed $s"; fi
done
for t in $timers; do
  if ! "$sc" --user enable --now "$t"; then failed="$failed $t"; fi
done

# The dead-man's unit that ran this switches its own timer off (best effort).
if [ "$deadman" = yes ]; then
  for f in "$units"/c6-deadman-*.service; do
    [ -f "$f" ] || continue
    if grep -qF "ExecStart=$bk/restore.sh" "$f"; then
      n=${f##*/}
      "$sc" --user disable --now "${n%.service}.timer" >/dev/null 2>&1 || true
    fi
  done
fi

if [ -n "$failed" ]; then
  echo "restore.sh: these units did not start:$failed" >&2
  exit 1
fi
RESTORE
chmod 0755 "$dest/restore.sh"

cat > "$dest/ROLLBACK.md" <<ROLLBACK
# Rollback

This folder is the machine as it was before \`morndo install\`. It belongs to one host and one HOME: restore.sh and
arm-deadman.sh refuse any other (exit 3).

Put the units, drop-ins and wrappers back, reload, restart the services that were running and re-enable the timers
that were enabled (databases are not touched):

    sh $dest/restore.sh

A manual run ignores the \`ok\` file (a stale ok file does not silence it); it says so on stderr and restores.

Done and fine: \`touch $dest/ok\`, then take the dead-man's switch away:

    sh $here/arm-deadman.sh --disarm <machine>

The dead-man's unit runs \`restore.sh --deadman\`, which exits at once when the \`ok\` file exists.

When --with-db is needed: if ANY migration ran between the old build and the installed one, the schema signature
changed and restore.sh refuses (exit 4) rather than put old code on a newer schema. Then either put the old data back
as well (stops the services, copies $dest/dbs back, restarts; every write made since the backup is lost):

    sh $dest/restore.sh --with-db

or restore the old code on the newer schema anyway, if you know it can run there:

    sh $dest/restore.sh --keep-data

The dead-man's run (--deadman) also refuses on a changed schema, loudly: a failed unit is the alert.

Arm the dead-man's switch (a persistent user timer, 60 minutes; survives a reboot):

    sh $here/arm-deadman.sh <machine> $dest
ROLLBACK
finished=yes
echo "backup written to $dest"
