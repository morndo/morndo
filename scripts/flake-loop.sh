#!/usr/bin/env bash
# Runs one Vitest selection many times, one fresh `vitest run` after another, optionally beside busy CPU loops, fsync
# writers and container network churn, and counts the runs that failed. A flaky test is reproduced when it fails here;
# its fix holds when the same selection under the same load passes every run.
#
#   scripts/flake-loop.sh [-n runs] [-c cpu-loops] [-i io-writers] [-d net-churners] [-b] [-o out-dir] -- <vitest args>
#   scripts/flake-loop.sh -n 50 -c 16 -- apps/node-agent/test/job-runtime.test.ts
#   scripts/flake-loop.sh -n 20 -c 8 -i 2 -- --project units apps/fleet/test/audit.test.ts -t "a row"
#   scripts/flake-loop.sh -n 20 -d 2 -- --project chromium apps/web/test/engines-role.test.ts
#
# It runs from the repository root, so test paths are relative to it, whatever the current directory.
# Every run is nice 10 and idle IO class (ionice -c3), so the box's other work goes first. An fsync then waits behind
# all other disk work, so a disk-bound test is slower here than under `npm test` or CI (best-effort class): times and
# counts are for idle class. -b runs vitest at the best-effort class instead (the load it adds stays idle class).
# -d needs docker and a local alpine:3 image (never pulled): each churner creates a docker network, runs one container
# on it and removes it again, so a bridge address comes and goes, as when other work on the box starts containers.
# Each run's output is kept in out-dir as run-<n>.txt (a temporary directory unless -o names one); the last line
# printed is the count, e.g. "fail 3/50".
set -u
usage() { sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0" >&2; exit 2; }
runs=10 cpu=0 io=0 net=0 out="" class=3
while getopts "n:c:i:d:bo:" opt; do
  case $opt in
    n) runs=$OPTARG ;;
    c) cpu=$OPTARG ;;
    i) io=$OPTARG ;;
    d) net=$OPTARG ;;
    b) class=2 ;;
    o) out=$(realpath -m "$OPTARG") ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || usage
cd "$(dirname "$(realpath "$0")")/.." || exit 2
[ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/flake-loop-XXXXXX")
mkdir -p "$out"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/flake-loop-io-XXXXXX")
pids=() churners=()
tag="flake-loop-$$"
# A churner ends after its current network, so none is left behind. One whose docker command hangs is killed with its
# process group after 30 s, and the label catches what it left.
stop() {
  touch "$scratch/stop"
  [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null
  for ((t = 0; t < 30; t++)); do
    live=0
    for p in "${churners[@]}"; do kill -0 "$p" 2>/dev/null && live=1; done
    [ $live -eq 0 ] && break
    sleep 1
  done
  for p in "${churners[@]}"; do kill -- "-$p" 2>/dev/null; done
  wait 2>/dev/null
  if [ "$net" -gt 0 ]; then
    timeout 30 docker ps -aq --filter "label=$tag" | xargs -r timeout 30 docker rm -f >/dev/null 2>&1
    timeout 30 docker network ls -q --filter "label=$tag" | xargs -r timeout 30 docker network rm >/dev/null 2>&1
  fi
  rm -rf "$scratch"
}
trap stop EXIT
trap 'exit 130' INT TERM
for ((k = 0; k < cpu; k++)); do nice -n 10 sh -c 'while :; do :; done' & pids+=($!); done
for ((k = 0; k < io; k++)); do
  nice -n 10 ionice -c3 sh -c "while :; do dd if=/dev/zero of='$scratch/w$k' bs=64k count=16 oflag=dsync 2>/dev/null; done" & pids+=($!)
done
# setsid: each churner leads a process group of its own, so stop() can end the docker command it is waiting on.
for ((k = 0; k < net; k++)); do
  setsid sh -c "i=0; while [ ! -e '$scratch/stop' ]; do n=$tag-$k-\$i; docker network create --label $tag \$n >/dev/null 2>&1; docker run --rm --pull never --label $tag --network \$n alpine:3 true >/dev/null 2>&1; docker network rm \$n >/dev/null 2>&1; i=\$((i + 1)); done" & churners+=($!)
done
failed=0
for ((r = 1; r <= runs; r++)); do
  start=$SECONDS
  if nice -n 10 ionice -c$class npx vitest run "$@" > "$out/run-$r.txt" 2>&1; then verdict=PASS; else verdict=FAIL; failed=$((failed + 1)); fi
  echo "run $r: $verdict ($((SECONDS - start)) s, load $(cut -d' ' -f1 /proc/loadavg))"
done
echo "out: $out"
echo "fail $failed/$runs"
[ "$failed" -eq 0 ]
