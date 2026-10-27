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

# The unit set: every loaded morndo unit in an active-like state (all types, template instances included), plus every
# unit file we copied. An instance running now has no file of its own (only its template) but is recorded active=yes.
active_now=$("$sc" --user list-units --state=active,activating,reloading,auto-restart --plain --no-legend 'morndo-*' 2>/dev/null | while read -r n _; do printf '%s\n' "$n"; done || true)
: > "$dest/state.txt"
seen=" "
record() {
  case $seen in *" $1 "*) return 0 ;; esac
  seen="$seen$1 "
  case " $(printf '%s' "$active_now" | tr '\n' ' ') " in *" $1 "*) a=yes ;; *) if "$sc" --user is-active "$1" >/dev/null 2>&1; then a=yes; else a=no; fi ;; esac
  if "$sc" --user is-enabled "$1" >/dev/null 2>&1; then e=yes; else e=no; fi
  printf '%s active=%s enabled=%s\n' "$1" "$a" "$e" >> "$dest/state.txt"
}
for f in "$dest"/units/morndo-*.service "$dest"/units/morndo-*.timer; do
  [ -f "$f" ] || continue
  case ${f##*/} in *@.service|*@.timer) continue ;; esac
  record "${f##*/}"
done
for u in $active_now; do
  case $u in *.service|*.timer) ;; *) continue ;; esac
  case $u in *@.service|*@.timer) continue ;; esac
  record "$u"
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
# Puts the machine's units, drop-ins and wrappers back as backup.sh found them, and every unit to its recorded state.
#   --deadman    the unattended run (the dead-man's unit): exits 0 at once when the folder holds an `ok` file. When the
#                schema of a database changed since the backup it stops the services, copies that database aside (aside-<time>/
#                in this folder, never deleted), puts the backed-up one back, and writes deadman-report.txt. Every dead-man
#                run that gets past the ok marker writes the report.
#   --with-db    also put the databases back (loses writes since the backup); needed when the schema changed
#   --keep-data  put the old code back on the databases as they are, even when their schema changed
# Refuses another host (exit 3) and, for a manual run, a changed schema (exit 4) before it touches anything.
# Every file and database is replaced by copy-then-rename (a temp beside it, checked, then renamed in); a database that could
# not be put back whole keeps its services stopped and is named. Every dead-man exit leaves a report line (exit 3: next to the folder).
# Any failure after that (a unit that does not reach its state, a copy that fails, a date or mkdir that fails) is carried on
# past: everything else is still done, the units are put back, and then the exit status is 1, a line "FAILED: ..." is on
# stderr (the journal for the dead-man's unit) and, for the dead-man, in deadman-report.txt. No `set -e` here on purpose.
set -u
bk=$(cd "$(dirname "$0")" && pwd)
sc=${C6_SYSTEMCTL:-systemctl}
units="$HOME/.config/systemd/user"
bin="$HOME/.local/bin"
NL='
'

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

# Every dead-man exit leaves a line in the journal (stderr) and in a report file.
if [ -e "$bk/ok" ]; then
  if [ "$deadman" = yes ]; then
    echo "restore.sh: ok marker present; nothing to do" >&2
    { echo "restore.sh --deadman ran at $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '(date failed)'): ok marker present; nothing to do"; } >> "$bk/deadman-report.txt" 2>/dev/null \
      || echo "restore.sh: could not append to $bk/deadman-report.txt" >&2
    exit 0
  fi
  echo "restore.sh: an ok marker exists in $bk; it is ignored for a manual run, restoring" >&2
fi

rec_host=$(sed -n 's/^host=//p' "$bk/machine.txt" 2>/dev/null | head -n 1 || true)
rec_home=$(sed -n 's/^home=//p' "$bk/machine.txt" 2>/dev/null | head -n 1 || true)
cur_host=${C6_HOSTNAME:-$(uname -n)}
if [ "$rec_host" != "$cur_host" ] || [ "$rec_home" != "$HOME" ]; then
  msg="this backup was made on host '$rec_host' under HOME '$rec_home'; this is '$cur_host' under '$HOME'. Nothing changed."
  echo "restore.sh: $msg" >&2
  if [ "$deadman" = yes ]; then
    # The folder is not this machine's, so the report goes NEXT TO it.
    rp="$bk.deadman-report.txt"
    if { echo "restore.sh --deadman ran at $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '(date failed)') for the backup in $bk."; echo "$msg"; } >> "$rp" 2>/dev/null; then
      echo "restore.sh: report written to $rp" >&2
    else
      echo "restore.sh: could not write the report $rp" >&2
    fi
  fi
  exit 3
fi

node=${C6_NODE:-$(cat "$bk/dbs/node-path.txt" 2>/dev/null || echo node)}
dbtool() { "$node" --no-warnings -- "$bk/db-backup.ts" "$@"; }

# The same path string arm-deadman.sh writes after ExecStart= (quoted and escaped for systemd when it has odd characters).
unit_path() {
  case $1 in
    *[!A-Za-z0-9_./+:@,=-]*) printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Every failure goes through here: said on stderr at once, kept for the report, and the exit status at the end is 1.
problems=""
problem() { problems="$problems$NL$1"; echo "restore.sh: FAILED: $1" >&2; }
try() { "$@" || problem "command failed: $*"; }

# Units that must not be started at the end: shell patterns, one per line (a database that was not put back, a unit file
# or wrapper that could not be copied back). apply_state leaves them stopped.
blocked=""
is_blocked() {
  _oif=$IFS; IFS=$NL
  for _g in $blocked; do
    IFS=$_oif
    [ -n "$_g" ] || continue
    case $1 in $_g) return 0 ;; esac
    IFS=$NL
  done
  IFS=$_oif
  return 1
}
block() { blocked="$blocked$NL$1"; }

# Which databases changed their schema since the backup (name=path lines).
changed=""
if [ -s "$bk/dbs/schema.txt" ] && { [ "$deadman" = yes ] || { [ "$withdb" = no ] && [ "$keep" = no ]; }; }; then
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name=${line%%=*}
    want=${line#*=}
    path=$(sed -n "s/^$name=//p" "$bk/dbs/paths.txt" | head -n 1)
    [ -f "$path" ] || continue
    live=$(dbtool signature "$path" 2>/dev/null) || live=unreadable
    [ "$live" = "$want" ] || changed="$changed$NL$name=$path"
  done < "$bk/dbs/schema.txt"
fi

# From the state recorded at backup time (state.txt): the services recorded active (template instances included).
start_list=""
while read -r u a e; do
  case $u in *.service) if [ "$a" = "active=yes" ]; then start_list="$start_list $u"; fi ;; esac
done < "$bk/state.txt"

stopped=no
stopfailed=no
applied=no

# ONE function puts every unit of the set (state.txt) into its recorded state, enabled or not and active or not:
#   service  enabled=yes -> enable, enabled=no -> disable;  active=yes -> restart, active=no -> stop
#   timer    enabled=yes -> enable --now, then restart (a running timer takes the restored schedule); enabled=no -> disable --now
# A unit that fails is named and the others still go on. A blocked unit (see is_blocked) is enabled/disabled as recorded but
# never started: a service on a database that was not put back, or whose unit file or wrapper could not be copied back.
unit_do() { # unit, then the systemctl arguments
  _u=$1; shift
  if ! "$sc" --user "$@" "$_u"; then problem "unit $_u did not reach its recorded state ($*)"; fi
}
apply_state() {
  applied=yes
  while read -r u a e; do
    [ -n "$u" ] || continue
    case $u in
      *.service)
        if [ "$e" = "enabled=yes" ]; then unit_do "$u" enable; else unit_do "$u" disable; fi
        if is_blocked "$u"; then echo "restore.sh: $u is left stopped (see the FAILED lines above)" >&2
        elif [ "$a" = "active=yes" ]; then unit_do "$u" restart; else unit_do "$u" stop; fi ;;
      *.timer)
        if is_blocked "$u"; then
          echo "restore.sh: $u is left stopped (see the FAILED lines above)" >&2
          if [ "$e" = "enabled=yes" ]; then unit_do "$u" enable; else unit_do "$u" disable; fi
        elif [ "$e" = "enabled=yes" ]; then unit_do "$u" enable --now; unit_do "$u" restart; else unit_do "$u" disable --now; fi ;;
    esac
  done < "$bk/state.txt"
}

# Before any database is touched (the aside copy, the --with-db copy) every morndo unit that is loaded and active-like NOW
# (active, activating, reloading, auto-restart; services, timers, sockets and paths, template instances included) is
# stopped, whatever was recorded, and so is every service recorded active. Timers first, so none fires in the window.
# apply_state puts the recorded state back at the end.
stop_running() {
  stopped=yes
  runlist=$("$sc" --user list-units --state=active,activating,reloading,auto-restart --plain --no-legend 'morndo-*' 2>/dev/null | while read -r n _; do printf '%s\n' "$n"; done) || runlist=""
  timers=""; others=""
  for s in $runlist; do
    case $s in
      *.timer) timers="$timers $s" ;;
      *.service|*.socket|*.path) others="$others $s" ;;
    esac
  done
  seen=" "
  for s in $timers $others $start_list; do
    case $seen in *" $s "*) continue ;; esac
    seen="$seen$s "
    if ! "$sc" --user stop "$s"; then stopfailed=yes; problem "unit $s would not stop before the database was touched"; fi
  done
}

# Whatever goes wrong once services are stopped, they are started again before this script ends.
finish() {
  if [ "$stopped" = yes ] && [ "$applied" = no ]; then
    echo "restore.sh: stopped before the end; starting the recorded units again" >&2
    apply_state || true
  fi
}
trap finish EXIT

# A database that could not be put back whole: its services stay stopped, and the line says which and what to do.
dbfail() { # name path why
  case $1 in
    hub|memory) _pat='morndo-hub*' ;;
    fleet) _pat='morndo-fleet*' ;;
    node) _pat='morndo-node*' ;;
    *) _pat='*' ;;
  esac
  block "$_pat"
  _svc=""
  while read -r _u _a _e; do
    case $_u in *.service) case $_u in $_pat) _svc="$_svc $_u" ;; esac ;; esac
  done < "$bk/state.txt"
  _svc=${_svc# }
  if [ "$_pat" = '*' ]; then _who="every morndo service stays stopped (unknown database name)"
  elif [ -z "$_svc" ]; then _who="the services $_pat stay stopped"
  else case $_svc in *" "*) _who="the services $_svc stay stopped" ;; *) _who="the service $_svc stays stopped" ;; esac; fi
  problem "database $1 was NOT put back ($3); $_who; copy $bk/dbs/$1.db to $2 by hand and start it"
}

# One database: copy the backup beside the live file, verify it, remove the -wal/-shm only now, then rename it over the live one.
# Returns 1 with $why set, the live file as it was before this call (or only its -wal/-shm gone, when the rename itself failed).
put_db() { # name path
  _src="$bk/dbs/$1.db"
  _tmp="$2.c6-restore.tmp"
  if [ ! -f "$_src" ]; then why="no backup copy at $_src"; return 1; fi
  rm -f -- "${_tmp:?}" "${_tmp:?}-wal" "${_tmp:?}-shm"
  if ! cp -p -- "$_src" "$_tmp"; then why="could not copy $_src to $_tmp"; rm -f -- "${_tmp:?}" "${_tmp:?}-wal" "${_tmp:?}-shm"; return 1; fi
  if [ -f "$2" ]; then chmod --reference="$2" "$_tmp" 2>/dev/null || true; fi   # best effort: keep the live file's mode
  if ! dbtool check "$_tmp" >/dev/null 2>&1; then why="the backup copy $_src fails PRAGMA quick_check"; rm -f -- "${_tmp:?}" "${_tmp:?}-wal" "${_tmp:?}-shm"; return 1; fi
  rm -f -- "${_tmp:?}-wal" "${_tmp:?}-shm"
  if ! rm -f -- "${2:?}-wal" "${2:?}-shm" || [ -e "$2-wal" ] || [ -e "$2-shm" ]; then why="could not remove $2-wal / -shm"; rm -f -- "${_tmp:?}"; return 1; fi
  if ! mv -f -- "$_tmp" "$2"; then why="could not rename $_tmp over $2"; rm -f -- "${_tmp:?}"; return 1; fi
  return 0
}

# One file, link or folder, replaced by copy-then-rename: a temp beside it, then renamed in. A folder is swapped (the new one
# renamed in, the old one removed after). A failure removes the temp and leaves the old one whole.
put() { # src dst
  _t="$2.c6-restore.tmp"
  _o="$2.c6-old.tmp"
  rm -rf -- "${_t:?}" "${_o:?}"
  if ! cp -a -- "$1" "$_t"; then rm -rf -- "${_t:?}"; return 1; fi
  if { [ -d "$_t" ] && [ ! -L "$_t" ]; } || { [ -d "$2" ] && [ ! -L "$2" ]; }; then
    if [ -e "$2" ] || [ -L "$2" ]; then
      if ! mv -- "$2" "$_o"; then rm -rf -- "${_t:?}"; return 1; fi
      if ! mv -- "$_t" "$2"; then mv -- "$_o" "$2"; rm -rf -- "${_t:?}"; return 1; fi
      rm -rf -- "${_o:?}"
      return 0
    fi
  fi
  if ! mv -f -- "$_t" "$2"; then rm -rf -- "${_t:?}"; return 1; fi
  return 0
}

# restore_dbs: the databases to put back (name=path lines), or "all".
restore_dbs=""
aside=""
report=""
if [ -n "$changed" ]; then
  if [ "$deadman" = no ]; then
    names=$(printf '%s\n' "$changed" | sed -n 's/^\([^=]*\)=\(.*\)$/ \1(\2)/p' | tr -d '\n')
    echo "restore.sh: the schema of$names changed since the backup; the old code may not run on it. Nothing changed." >&2
    echo "restore.sh: --with-db puts the old data back (loses the writes made since the backup); --keep-data restores the old code on the newer schema anyway." >&2
    exit 4
  fi
  # The dead-man: stop the units, then keep a consistent online copy of each changed database before it is touched.
  stop_running
  ts=$(date -u +%Y%m%dT%H%M%SZ) || ts=""
  if [ -z "$ts" ]; then ts="nodate-$$"; problem "date failed; the aside folder is named $ts instead of by time"; fi
  aside="$bk/aside-$ts"
  asideok=yes
  mkdir -p "$aside" || { asideok=no; problem "could not make the aside folder $aside"; }
  oldIFS=$IFS; IFS=$NL
  for spec in $changed; do
    [ -n "$spec" ] || continue
    name=${spec%%=*}
    path=${spec#*=}
    if [ "$asideok" = yes ] && dbtool backup "$path" "$aside/$name.db" >/dev/null; then
      restore_dbs="$restore_dbs$NL$spec"
      report="$report${NL}database $name ($path) changed its schema; copied to $aside/$name.db, then the backed-up one was put back"
    else
      dbfail "$name" "$path" "its schema changed and the copy to $aside/$name.db failed, so it was left as it is"
    fi
  done
  IFS=$oldIFS
elif [ "$withdb" = yes ]; then
  restore_dbs=all
  stop_running
fi

# What the install added: units and drop-in folders of ours that the backup does not hold.
for f in "$units"/morndo-*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  if [ -e "$bk/units/$name" ] || [ -L "$bk/units/$name" ]; then continue; fi
  case $name in
    *.service|*.timer) "$sc" --user disable --now "$name" || problem "unit $name (added by the install) could not be disabled and stopped" ;;
  esac
  try rm -rf -- "${units:?}/${name:?}"
done

# What the backup held goes back whole, each by copy-then-rename (a folder is swapped, so a drop-in the install added leaves
# with it). One that cannot be put back stays as it is, is named, and its service is not started.
for f in "$bk"/units/*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  if ! put "$f" "$units/$name"; then
    problem "unit file $name could not be copied back (the old one is kept whole); the service it belongs to is not started"
    base=${name%.d}
    case $base in *@.service|*@.timer) block "${base%.*}*${base##*.}" ;; *) block "$base" ;; esac
  fi
done
try mkdir -p "$bin"
# Launcher links the install added (into morndo-releases/) that the backup does not hold; never a regular file.
for f in "$bin"/*; do
  [ -L "$f" ] || continue
  name=${f##*/}
  case $(readlink "$f") in *morndo-releases/*) ;; *) continue ;; esac
  if [ -e "$bk/wrappers/$name" ] || [ -L "$bk/wrappers/$name" ]; then continue; fi
  try rm -f -- "${bin:?}/${name:?}"
done
for f in "$bk"/wrappers/*; do
  if [ -e "$f" ] || [ -L "$f" ]; then :; else continue; fi
  name=${f##*/}
  if ! put "$f" "$bin/$name"; then
    problem "wrapper $name could not be copied back (the old one is kept whole); the services $name.service, $name@*, $name-* are not started"
    block "$name.*"; block "$name@*"; block "$name-*"
  fi
done

try "$sc" --user daemon-reload

if [ -n "$restore_dbs" ]; then
  if [ "$restore_dbs" = all ]; then restore_dbs=$(cat "$bk/dbs/paths.txt"); fi
  oldIFS=$IFS; IFS=$NL
  for line in $restore_dbs; do
    [ -n "$line" ] || continue
    name=${line%%=*}
    path=${line#*=}
    why=""
    if [ "$stopfailed" = yes ]; then
      dbfail "$name" "$path" "a unit would not stop, and a database is never overwritten under a running service"
    elif ! put_db "$name" "$path"; then
      dbfail "$name" "$path" "$why"
    fi
  done
  IFS=$oldIFS
fi

apply_state

# The dead-man's unit that ran this switches its own timer off (best effort).
if [ "$deadman" = yes ]; then
  want=$(unit_path "$bk/restore.sh")
  for f in "$units"/c6-deadman-*.service; do
    [ -f "$f" ] || continue
    if grep -qF "ExecStart=$want --deadman" "$f"; then
      n=${f##*/}
      "$sc" --user disable --now "${n%.service}.timer" >/dev/null 2>&1 || true
    fi
  done
fi

report_body() {
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ) || now="(date failed)"
  echo "restore.sh --deadman ran on $now for the backup in $bk."
  echo "It put the units, drop-ins and wrappers back, and every unit to its recorded state."
  if [ -n "$aside" ]; then
    echo "The schema of at least one database changed since the backup, so it stopped the units, kept a copy of each"
    echo "changed database (nothing deletes them) in $aside, put the backed-up database back for those databases only,"
    echo "and started the units. Writes made since the backup are only in the copies."
  else
    echo "The schema of no database changed since the backup; the databases were not touched."
  fi
  printf '%s\n' "$report" | sed '/^$/d'
  printf '%s\n' "$problems" | sed -e '/^$/d' -e 's/^/FAILED: /'
}

if [ "$deadman" = yes ]; then
  if ! report_body > "$bk/deadman-report.txt"; then problem "could not write $bk/deadman-report.txt; its text follows on stderr"; fi
  echo "restore.sh: the dead-man ran; see $bk/deadman-report.txt${aside:+ (copies in $aside)}" >&2
  report_body | sed 's/^/restore.sh: deadman-report.txt: /' >&2
fi

if [ -n "$problems" ]; then
  echo "restore.sh: FAILED: ended with problems (listed above); exit 1" >&2
  exit 1
fi
exit 0
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

When --with-db is needed: if ANY migration ran between the old build and the installed one (a changed table or index,
a changed PRAGMA user_version, or a changed row of the _morndo_schema compat-floor table; rows of other tables, even
one named like a migration lock, do not count), the schema signature changed and a manual restore.sh
refuses (exit 4) rather than put old code on a newer schema. Then either put the old data back as well (stops the
services, copies $dest/dbs back, starts the units again; every write made since the backup is lost):

    sh $dest/restore.sh --with-db

or restore the old code on the newer schema anyway, if you know it can run there:

    sh $dest/restore.sh --keep-data

The dead-man's run (--deadman) does not refuse on a changed schema, because nobody is there to choose. Before it touches
any database it stops every loaded morndo unit in an active-like state (active, activating, reloading, auto-restart;
services, timers, sockets and paths, template instances included; timers first, so none fires while it works), whatever
was recorded, and every service recorded active. For each database whose schema changed it then copies the live database
into \`$dest/aside-<UTC time>/<name>.db\` (no script ever deletes that folder; the writes made since the backup live only
there), then behaves like --with-db for those databases: puts the backed-up database back and starts the units.
Databases whose schema did not change are not touched and not copied.

Every file is replaced by copy-then-rename: written under a temp name beside the old one (\`<name>.c6-restore.tmp\`), then
renamed over it; a drop-in folder is copied beside and swapped. Nothing is removed first, so a failure leaves the old
file whole and removes the temp. A database copy is also checked with PRAGMA quick_check, and its -wal/-shm are removed
only right before the rename. If a database could not be put back whole (no copy, a copy that fails the check, a rename
that fails, a changed database whose aside copy failed, a service that would not stop) the services that use it are NOT
started: hub and memory: morndo-hub*, fleet: morndo-fleet*, node: morndo-node*, any other name: every service. The run
exits non-zero and says on stderr (and in deadman-report.txt) which database and what to do: copy
$dest/dbs/<name>.db to the live path by hand, then start the service. A unit file or wrapper that could not be copied back
is named the same way and its service is not started.

Every dead-man exit leaves a line in the service journal and in a report file: a run past the \`ok\` check writes
\`$dest/deadman-report.txt\` and prints it; the \`ok\` marker writes "ok marker present; nothing to do" to the journal and
appends it to that report; a run on another host or HOME (exit 3) writes \`$dest.deadman-report.txt\` next to this folder
and prints its path. If anything failed (a unit that did not reach its state, a copy, a date or mkdir that failed, a
report that could not be written) the units are still put back, every failure is a line \`FAILED: ...\` in the journal and
in the report, and the exit status is non-zero. The same non-zero exit holds for a manual run.

Every unit of the recorded set (state.txt; a template instance that ran at backup time is in it) goes back to its recorded state, by one routine: a service that was enabled is enabled and one
that was disabled is disabled (also when the install enabled it); an active service is restarted, an inactive one is
stopped; a timer that was enabled is enabled with \`--now\` and then restarted (so a running timer takes the restored
schedule), one that was disabled is disabled with \`--now\`. A unit the install added is stopped and disabled.

Arm the dead-man's switch (a persistent user timer, 60 minutes; survives a reboot):

    sh $here/arm-deadman.sh <machine> $dest

Arming again moves the time (the timer is restarted). It refuses while \`$dest/ok\` exists: remove it (\`rm $dest/ok\`) first.
ROLLBACK
finished=yes
echo "backup written to $dest"
