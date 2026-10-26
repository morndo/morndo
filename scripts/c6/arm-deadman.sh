#!/bin/sh
# arm-deadman.sh <machine> <backup-dir> [--seconds N]: a user timer that runs <backup-dir>/restore.sh in 60 minutes
# (or N seconds, for a rehearsal). `touch <backup-dir>/ok` disarms it: restore.sh then exits at its first line.
set -eu

usage() { echo "usage: arm-deadman.sh <machine> <backup-dir> [--seconds N]" >&2; exit 2; }

[ $# -ge 2 ] || usage
machine=$1
dir=$2
shift 2
after=60min
while [ $# -gt 0 ]; do
  case $1 in
    --seconds)
      [ $# -ge 2 ] || usage
      case $2 in ''|*[!0-9]*) usage ;; esac
      after="${2}s"
      shift 2 ;;
    *) usage ;;
  esac
done

exec "${C6_SYSTEMD_RUN:-systemd-run}" --user "--unit=c6-deadman-$machine" "--on-active=$after" "$dir/restore.sh"
