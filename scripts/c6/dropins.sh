#!/bin/sh
# C6, the drop-ins that set ExecStart (T-318, P2). A unit's drop-in (<unit>.d/*.conf) wins over the unit file, and the
# machines have one (ship.conf) that resets ExecStart and sets it to the tree the release tool shipped. `morndo install`
# rewrites the unit, but leaves that drop-in alone, so the service would keep starting the old tree.
#
#   dropins.sh --list            every drop-in of the hub, fleet and node units that has an ExecStart= line: the files systemd
#                                itself reads for them (DropInPaths, wherever they sit) and the morndo-*.service.d folders
#                                under ~/.config/systemd/user (morndo-job-* units are left out, as backup.sh leaves them out)
#   dropins.sh <backup folder>   take the ExecStart= lines (and the lines a trailing backslash joins to them) out of those
#                                drop-ins, in place, and keep every other line (the PATH the engines need among them)
#
# The backup folder is the one backup.sh made: it must hold each such drop-in exactly as it is now (it copied the folders
# under ~/.config/systemd/user whole), else nothing is changed and the exit status is 3. A drop-in outside that folder is
# not in any backup: the exit status is 4, nothing is changed, and the files are named, to be dealt with by hand. restore.sh
# puts the original back. Run after the backup, with the units stopped, and before the install; again, it finds nothing to do.
# Exit status 2: wrong arguments, or a file or systemd could not be read (never read as "no ExecStart").
set -eu
umask 077

# The user unit folder is where systemd reads it: $XDG_CONFIG_HOME/systemd/user, else ~/.config/systemd/user. Paths are compared by
# their real location, so a HOME reached through a symlink, or a path systemd spells differently, still matches.
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
sc=${C6_SYSTEMCTL:-systemctl}
services="morndo-hub.service morndo-fleet.service morndo-node.service"

usage() {
  echo "usage: dropins.sh --list | dropins.sh <backup folder made by backup.sh>" >&2
  exit 2
}

[ $# -eq 1 ] || usage

# The one definition of what is looked for: ExecStart= at the start of a line (blanks allowed before it and before the =).
# Exit status 0: there is one; 1: there is none; 2: the file could not be read. Unreadable files are rejected before awk
# (awk's exit status on a missing file is not reliable across implementations).
has_execstart() {
  [ -f "$1" ] && [ -r "$1" ] || return 2
  awk '/^[ \t]*ExecStart[ \t]*=/ { found = 1 } END { exit found ? 0 : 1 }' "$1"
}

# A path's real location: its folder resolved, its own name kept (a drop-in that is itself a link is not followed).
realpath_of() {
  d=$(dirname -- "$1")
  b=$(basename -- "$1")
  r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$r" "$b"
}

# Every drop-in file that applies to our service units: systemd's own list, then the folders under the user unit folder. A
# failed question to systemd ends the script with status 2 (this runs in a command substitution, never on the left of a pipe).
files() {
  for u in $services; do
    out=$("$sc" --user show -p DropInPaths --value "$u") || { echo "dropins.sh: could not ask systemd about $u" >&2; exit 2; }
    # systemd separates the paths with a space and does not quote them; every path is absolute, so one starts at " /"
    printf '%s\n' "$out" | awk '{ gsub(/ \//, "\n/"); print }' || { echo "dropins.sh: could not read systemd's answer about $u" >&2; exit 2; }
  done
  for d in "$units"/morndo-*.service.d; do
    [ -d "$d" ] || continue
    case ${d##*/} in morndo-job-*) continue ;; esac
    for f in "$d"/*.conf; do
      if [ -f "$f" ]; then printf '%s\n' "$f"; fi
    done
  done
}

# Those of them that have an ExecStart= line, by real path.
candidates() {
  all=$(files)
  printf '%s\n' "$all" | while IFS= read -r f; do
    if [ -f "$f" ]; then realpath_of "$f" || true; fi
  done | sort -u | while IFS= read -r f; do
    [ -n "$f" ] || continue
    if has_execstart "$f"; then
      printf '%s\n' "$f"
    else
      rc=$?
      if [ "$rc" -ne 1 ]; then echo "dropins.sh: could not read $f" >&2; exit 2; fi
    fi
  done
}

units_real=$(cd -P -- "$units" 2>/dev/null && pwd -P) || units_real=$units
found=$(candidates)

if [ "$1" = "--list" ]; then
  if [ -n "$found" ]; then printf '%s\n' "$found"; fi
  exit 0
fi

bk=$1
[ -d "$bk/units" ] || { echo "dropins.sh: $bk is not a backup folder made by backup.sh (no units folder)" >&2; exit 2; }

if [ -z "$found" ]; then
  echo "dropins.sh: no drop-in sets ExecStart; nothing to do"
  exit 0
fi

# All or nothing: every one must be under ~/.config/systemd/user, and in the backup byte for byte, before the first is touched.
outside=
missing=
while IFS= read -r f; do
  case $f in
    "$units_real"/*)
      name=${f#"$units_real"/}
      if ! cmp -s "$f" "$bk/units/$name"; then missing="$missing $name"; fi ;;
    *) outside="$outside $f" ;;
  esac
done <<EOT
$found
EOT
if [ -n "$outside" ]; then
  echo "dropins.sh: these drop-ins set ExecStart but are not under $units_real, so no backup holds them; nothing was changed:$outside" >&2
  exit 4
fi
if [ -n "$missing" ]; then
  echo "dropins.sh: the backup does not hold these drop-ins exactly as they are, so nothing was changed:$missing" >&2
  exit 3
fi

lines() { awk 'END { print NR }' "$1"; }

while IFS= read -r f; do
  tmp="$f.c6-tmp"
  cp -p "$f" "$tmp" || { echo "dropins.sh: could not write beside $f" >&2; exit 2; }
  # Without the ExecStart= lines, and the lines a trailing backslash joins to them (systemd reads them as one line).
  if ! awk '
      skip { if ($0 ~ /^[ \t]*[#;]/) next; skip = ($0 ~ /\\$/); next }
      /^[ \t]*ExecStart[ \t]*=/ { skip = ($0 ~ /\\$/); next }
      { print }
    ' "$f" > "$tmp"; then
    rm -f -- "$tmp"
    echo "dropins.sh: could not rewrite $f; it is as it was" >&2
    exit 2
  fi
  # The copy must be shorter than the original and have no ExecStart= left; anything else is not put in its place.
  if has_execstart "$tmp" || [ "$(lines "$tmp")" -ge "$(lines "$f")" ]; then
    rm -f -- "$tmp"
    echo "dropins.sh: the rewrite of $f is not what was meant; it is as it was" >&2
    exit 2
  fi
  mv -f "$tmp" "$f"
  echo "ExecStart taken out of: $f"
done <<EOT
$found
EOT
