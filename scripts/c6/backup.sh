#!/bin/sh
# Before `morndo install` over a machine: backup.sh <dest> [--db name=path]...
# Copies the morndo-* user units (with their drop-in folders) and the ~/.local/bin/morndo* wrappers, takes an online
# copy of each --db, and writes <dest>/restore.sh and <dest>/ROLLBACK.md. Refuses a <dest> that exists.
set -eu

usage() { echo "usage: backup.sh <dest> [--db name=path]..." >&2; exit 2; }

[ $# -ge 1 ] || usage
dest=$1
shift
dbs=""
while [ $# -gt 0 ]; do
  case $1 in
    --db) [ $# -ge 2 ] || usage; dbs="$dbs
$2"; shift 2 ;;
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

# Check every database before anything is written.
oldIFS=$IFS
IFS='
'
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

mkdir -p "$dest/units" "$dest/wrappers" "$dest/dbs"

for f in "$units"/morndo-*; do
  if [ -e "$f" ] || [ -L "$f" ]; then cp -a "$f" "$dest/units/"; fi
done
for f in "$bin"/morndo*; do
  if [ -f "$f" ] || [ -L "$f" ]; then cp -a "$f" "$dest/wrappers/"; fi
done

: > "$dest/dbs/paths.txt"
IFS='
'
for spec in $dbs; do
  [ -n "$spec" ] || continue
  name=${spec%%=*}
  src=${spec#*=}
  "${C6_NODE:-node}" --no-warnings "$here/db-backup.ts" "$src" "$dest/dbs/$name.db"
  printf '%s=%s\n' "$name" "$src" >> "$dest/dbs/paths.txt"
done
IFS=$oldIFS

cat > "$dest/restore.sh" <<'RESTORE'
#!/bin/sh
# Puts the machine's units, drop-ins and wrappers back as backup.sh found them. Does nothing when the folder holds
# an `ok` file. Never touches a database unless run with --with-db.
test -e "$(dirname "$0")/ok" && exit 0
set -eu
bk=$(cd "$(dirname "$0")" && pwd)
sc=${C6_SYSTEMCTL:-systemctl}
units="$HOME/.config/systemd/user"
bin="$HOME/.local/bin"

withdb=no
for a in "$@"; do
  case $a in
    --with-db) withdb=yes ;;
    *) echo "usage: restore.sh [--with-db]" >&2; exit 2 ;;
  esac
done

# The service units the backup holds: restarted at the end, stopped first when the databases go back.
services=""
for f in "$bk"/units/morndo-*.service; do
  [ -f "$f" ] || continue
  case ${f##*/} in *@*) continue ;; esac
  services="$services ${f##*/}"
done

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

for s in $services; do "$sc" --user restart "$s"; done
RESTORE
chmod 0755 "$dest/restore.sh"

cat > "$dest/ROLLBACK.md" <<ROLLBACK
# Rollback

This folder is the machine as it was before \`morndo install\`.

Put the units, drop-ins and wrappers back, reload and restart the services (databases are not touched):

    sh $dest/restore.sh

Do nothing at all (the dead-man's switch runs the same file; the \`ok\` file makes it exit at its first line):

    touch $dest/ok

Put the databases back as well (stops the services, copies $dest/dbs back, restarts):

    sh $dest/restore.sh --with-db

Arm the dead-man's switch for 60 minutes:

    sh $here/arm-deadman.sh <machine> $dest
ROLLBACK
echo "backup written to $dest"
