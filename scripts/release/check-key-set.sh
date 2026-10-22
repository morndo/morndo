#!/bin/sh
# check-key-set.sh <allowed-signers-file> <dir>: the Key set is signed by the pinned root key, or the build stops.
# <dir>/keys.json must verify against <dir>/keys.json.sig with ssh-keygen, under the identity root@morndo.github.io
# and the namespace keys@morndo.github.io (trust/README.md, "Signing keys.json"), against the signer in the file the
# caller pins. The build runs it on the tree before any repository program runs, and again on the staged copy that
# ships. A missing or empty file, a changed keys.json, a signature by another key or in another namespace all fail.
# Plain shell and the system's ssh-keygen only: no node, no npm, nothing from the repository.
set -eu
PATH=/usr/bin:/bin
signers=${1:?usage: check-key-set.sh <allowed-signers-file> <dir>}
dir=${2:?usage: check-key-set.sh <allowed-signers-file> <dir>}
fail() { echo "check-key-set: $*" >&2; exit 1; }
test -s "$signers" || fail "no pinned root signer at $signers"
test -s "$dir/keys.json" || fail "$dir/keys.json is missing or empty"
test -s "$dir/keys.json.sig" || fail "$dir/keys.json.sig is missing or empty: the Key set ships signed or not at all"
ssh-keygen -Y verify -f "$signers" -I root@morndo.github.io -n keys@morndo.github.io -s "$dir/keys.json.sig" < "$dir/keys.json" >/dev/null 2>&1 ||
  fail "$dir/keys.json.sig does not verify against the pinned root signer"
echo "check-key-set: ok ($dir/keys.json is signed by the pinned root key)"
