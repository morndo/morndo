#!/bin/sh
# arm-deadman.sh <machine> <backup-dir> [--seconds N]: a persistent user timer (a file under ~/.config/systemd/user, so a
# reboot or a restart of the user manager keeps it) that runs <backup-dir>/restore.sh --deadman in 60 minutes (or N
# seconds, for a rehearsal), and refuses while <backup-dir>/ok exists. arm-deadman.sh --disarm <machine> removes it. The ok step is `touch <backup-dir>/ok`, then
# --disarm (the marker makes a firing that still happens exit at once).
set -eu

usage() { echo "usage: arm-deadman.sh <machine> <backup-dir> [--seconds N] | arm-deadman.sh --disarm <machine>" >&2; exit 2; }

sc=${C6_SYSTEMCTL:-systemctl}
units="$HOME/.config/systemd/user"

# The path as systemd reads it in ExecStart: a path with anything beyond plain characters is put in double quotes, with a
# backslash and a double quote backslash-escaped, % doubled (a specifier) and $ doubled (variable expansion). A plain path
# is written as it is. restore.sh builds the same string to find the unit that belongs to its backup.
unit_path() {
  case $1 in
    *[!A-Za-z0-9_./+:@,=-]*) printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')" ;;
    *) printf '%s' "$1" ;;
  esac
}

checkname() { case $1 in ''|*[!A-Za-z0-9_.-]*) echo "arm-deadman.sh: bad machine name: $1" >&2; exit 2 ;; esac; }

if [ $# -ge 1 ] && [ "$1" = "--disarm" ]; then
  [ $# -eq 2 ] || usage
  machine=$2
  checkname "$machine"
  "$sc" --user disable --now "c6-deadman-$machine.timer" || true
  rm -f -- "${units:?}/c6-deadman-$machine.timer" "${units:?}/c6-deadman-$machine.service"
  "$sc" --user daemon-reload
  exit 0
fi

[ $# -ge 2 ] || usage
machine=$1
dir=$2
shift 2
checkname "$machine"
secs=3600
while [ $# -gt 0 ]; do
  case $1 in
    --seconds)
      [ $# -ge 2 ] || usage
      case $2 in ''|*[!0-9]*) usage ;; esac
      secs=$2
      shift 2 ;;
    *) usage ;;
  esac
done

[ -d "$dir" ] || { echo "arm-deadman.sh: no folder $dir" >&2; exit 1; }
dir=$(cd "$dir" && pwd)
if [ ! -f "$dir/restore.sh" ] || [ ! -x "$dir/restore.sh" ]; then
  echo "arm-deadman.sh: $dir/restore.sh is missing or not executable" >&2
  exit 1
fi

rec_host=$(sed -n 's/^host=//p' "$dir/machine.txt" 2>/dev/null | head -n 1 || true)
rec_home=$(sed -n 's/^home=//p' "$dir/machine.txt" 2>/dev/null | head -n 1 || true)
cur_host=${C6_HOSTNAME:-$(uname -n)}
if [ "$rec_host" != "$cur_host" ] || [ "$rec_home" != "$HOME" ]; then
  echo "arm-deadman.sh: this backup was made on host '$rec_host' under HOME '$rec_home'; this is '$cur_host' under '$HOME'" >&2
  exit 3
fi

if [ -e "$dir/ok" ]; then
  echo "arm-deadman.sh: $dir/ok exists (the backup was signed off); nothing armed. Remove it to arm: rm $dir/ok" >&2
  exit 1
fi

now=${C6_NOW:-$(date +%s)}
when=$(date -d "@$((now + secs))" '+%Y-%m-%d %H:%M:%S')

execpath=$(unit_path "$dir/restore.sh")
mkdir -p "$units"
cat > "$units/c6-deadman-$machine.service" <<UNIT
[Unit]
Description=C6 dead-man's switch for $machine: put the machine back as backup.sh found it

[Service]
Type=oneshot
ExecStart=$execpath --deadman
UNIT
cat > "$units/c6-deadman-$machine.timer" <<UNIT
[Unit]
Description=C6 dead-man's switch for $machine

[Timer]
OnCalendar=$when
Persistent=true

[Install]
WantedBy=timers.target
UNIT
"$sc" --user daemon-reload
"$sc" --user enable --now "c6-deadman-$machine.timer"
# A re-arm: the timer is already running with the old OnCalendar; a restart applies the new one.
"$sc" --user restart "c6-deadman-$machine.timer"
echo "dead-man's switch for $machine armed for $when (local time)"
