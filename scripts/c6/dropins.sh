#!/bin/sh
# C6, the drop-ins that set ExecStart (T-318, P2). A unit's drop-in (<unit>.d/*.conf) wins over the unit file, and the
# machines have one (ship.conf) that resets ExecStart and sets it to the tree the release tool shipped. `morndo install`
# rewrites the unit, but leaves that drop-in alone, so the service would keep starting the old tree.
#
#   dropins.sh --list            the drop-ins of our units (morndo-*.service.d/*.conf) that have an ExecStart= line
#   dropins.sh <backup folder>   take the ExecStart= lines out of those drop-ins, in place, and keep every other line
#                                (the PATH the engines need among them)
#
# The backup folder is the one backup.sh made: it must hold each such drop-in exactly as it is now (it copied the drop-in
# folders whole), else nothing is changed and the exit status is 3. restore.sh puts the original back. Run after the
# backup and before the install; running it again finds nothing to do.
set -eu
umask 077

units="$HOME/.config/systemd/user"

usage() {
  echo "usage: dropins.sh --list | dropins.sh <backup folder made by backup.sh>" >&2
  exit 2
}

[ $# -eq 1 ] || usage

list() {
  for d in "$units"/morndo-*.service.d; do
    [ -d "$d" ] || continue
    for f in "$d"/*.conf; do
      [ -f "$f" ] || continue
      if grep -q '^[[:space:]]*ExecStart[[:space:]]*=' "$f"; then printf '%s\n' "$f"; fi
    done
  done
}

if [ "$1" = "--list" ]; then
  list
  exit 0
fi

bk=$1
[ -d "$bk/units" ] || { echo "dropins.sh: $bk is not a backup folder made by backup.sh (no units folder)" >&2; exit 2; }

found=$(list)
if [ -z "$found" ]; then
  echo "dropins.sh: no drop-in sets ExecStart; nothing to do"
  exit 0
fi

# All or nothing: every drop-in must be in the backup, byte for byte, before the first one is touched.
missing=
while IFS= read -r f; do
  name=${f#"$units"/}
  if ! cmp -s "$f" "$bk/units/$name"; then missing="$missing $name"; fi
done <<EOT
$found
EOT
if [ -n "$missing" ]; then
  echo "dropins.sh: the backup does not hold these drop-ins exactly as they are, so nothing was changed:$missing" >&2
  exit 3
fi

while IFS= read -r f; do
  tmp="$f.c6-tmp"
  cp -p "$f" "$tmp"
  # An ExecStart= line, and the lines a trailing backslash joins to it (systemd reads them as one line).
  awk '
    skip { skip = ($0 ~ /\\$/); next }
    /^[ \t]*ExecStart[ \t]*=/ { skip = ($0 ~ /\\$/); next }
    { print }
  ' "$f" > "$tmp"
  mv -f "$tmp" "$f"
  echo "ExecStart taken out of: $f"
done <<EOT
$found
EOT
