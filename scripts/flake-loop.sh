#!/usr/bin/env bash
# Runs one Vitest selection many times, one fresh `vitest run` after another, optionally beside busy CPU loops, fsync
# writers and container network churn, and counts the runs that failed. A flaky test is reproduced when it fails here;
# its fix holds when the same selection under the same load passes every run. Everything runs at nice 10, idle IO
# class, so the box's other work goes first.
#
#   scripts/flake-loop.sh [-n runs] [-c cpu-loops] [-i io-writers] [-d net-churners] [-o out-dir] -- <vitest run arguments>
#   scripts/flake-loop.sh -n 50 -c 16 -- apps/node-agent/test/job-runtime.test.ts
#   scripts/flake-loop.sh -n 20 -c 8 -i 2 -- --project units apps/fleet/test/audit.test.ts -t "a row"
#   scripts/flake-loop.sh -n 20 -d 2 -- --project chromium apps/web/test/engines-role.test.ts
#
# -d needs docker and a local alpine:3 image (never pulled): each churner creates a docker network, runs one container
# on it and removes it again, so a bridge address comes and goes, as when other work on the box starts containers.
# Each run's output is kept in out-dir as run-<n>.txt (a temporary directory unless -o names one); the last line
# printed is the count, e.g. "fail 3/50".
set -u
runs=10 cpu=0 io=0 net=0 out=""
while getopts "n:c:i:d:o:" opt; do
  case $opt in
    n) runs=$OPTARG ;;
    c) cpu=$OPTARG ;;
    i) io=$OPTARG ;;
    d) net=$OPTARG ;;
    o) out=$OPTARG ;;
    *) sed -n '2,17p' "$0" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { sed -n '2,17p' "$0" >&2; exit 2; }
[ -n "$out" ] || out=$(mktemp -d "${TMPDIR:-/tmp}/flake-loop-XXXXXX")
mkdir -p "$out"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/flake-loop-io-XXXXXX")
pids=()
tag="flake-loop-$$"
# A churner ends after its current network, so none is left behind; the label catches one that was.
stop() {
  touch "$scratch/stop"
  [ ${#pids[@]} -gt 0 ] && kill "${pids[@]}" 2>/dev/null
  wait 2>/dev/null
  if [ "$net" -gt 0 ]; then
    docker ps -aq --filter "label=$tag" | xargs -r docker rm -f >/dev/null 2>&1
    docker network ls -q --filter "label=$tag" | xargs -r docker network rm >/dev/null 2>&1
  fi
  rm -rf "$scratch"
}
trap stop EXIT
trap 'exit 130' INT TERM
for ((k = 0; k < cpu; k++)); do nice -n 10 sh -c 'while :; do :; done' & pids+=($!); done
for ((k = 0; k < io; k++)); do
  nice -n 10 ionice -c3 sh -c "while :; do dd if=/dev/zero of='$scratch/w$k' bs=64k count=16 oflag=dsync 2>/dev/null; done" & pids+=($!)
done
for ((k = 0; k < net; k++)); do
  sh -c "i=0; while [ ! -e '$scratch/stop' ]; do n=$tag-$k-\$i; docker network create --label $tag \$n >/dev/null 2>&1; docker run --rm --pull never --label $tag --network \$n alpine:3 true >/dev/null 2>&1; docker network rm \$n >/dev/null 2>&1; i=\$((i + 1)); done" &
done
failed=0
for ((r = 1; r <= runs; r++)); do
  start=$SECONDS
  if nice -n 10 ionice -c3 npx vitest run "$@" > "$out/run-$r.txt" 2>&1; then verdict=PASS; else verdict=FAIL; failed=$((failed + 1)); fi
  echo "run $r: $verdict ($((SECONDS - start)) s, load $(cut -d' ' -f1 /proc/loadavg))"
done
echo "out: $out"
echo "fail $failed/$runs"
[ "$failed" -eq 0 ]
