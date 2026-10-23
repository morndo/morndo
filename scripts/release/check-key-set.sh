#!/bin/sh
# check-key-set.sh <allowed-signers-file> <dir> <min-version>: the Key set is signed by the pinned root key, is not older
# than the pinned minimum version and has not expired, or the build stops.
# <dir>/keys.json must verify against <dir>/keys.json.sig with ssh-keygen, under the identity root@morndo.github.io
# and the namespace keys@morndo.github.io (trust/README.md, "Signing keys.json"), against the signer in the file the
# caller pins. The build runs it on the tree before any repository program runs, and again on the staged copy that
# ships. A missing or empty file, a changed keys.json, a signature by another key or in another namespace all fail. So
# does a validly signed older set (a version below <min-version>, which the workflow pins next to the signer and raises
# with each rotation) and one past its expiresAt: replaying an old set would ship keys that were rotated out. The two
# fields are read from keys.json's canonical layout after the signature has verified; a layout it cannot read fails.
# Plain shell and the system's ssh-keygen only: no node, no npm, nothing from the repository.
set -eu
PATH=/usr/bin:/bin
signers=${1:?usage: check-key-set.sh <allowed-signers-file> <dir> <min-version>}
dir=${2:?usage: check-key-set.sh <allowed-signers-file> <dir> <min-version>}
min=${3:?usage: check-key-set.sh <allowed-signers-file> <dir> <min-version>}
fail() { echo "check-key-set: $*" >&2; exit 1; }
case $min in ''|*[!0-9]*|0*) fail "the pinned minimum version is not a positive whole number: '$min'" ;; esac
test -s "$signers" || fail "no pinned root signer at $signers"
test -s "$dir/keys.json" || fail "$dir/keys.json is missing or empty"
test -s "$dir/keys.json.sig" || fail "$dir/keys.json.sig is missing or empty: the Key set ships signed or not at all"
ssh-keygen -Y verify -f "$signers" -I root@morndo.github.io -n keys@morndo.github.io -s "$dir/keys.json.sig" < "$dir/keys.json" >/dev/null 2>&1 ||
  fail "$dir/keys.json.sig does not verify against the pinned root signer"
version=$(sed -n 's/^  "version": \([0-9][0-9]*\),\{0,1\}$/\1/p' "$dir/keys.json")
expires=$(sed -n 's/^  "expiresAt": "\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z\)",\{0,1\}$/\1/p' "$dir/keys.json")
case $version in ''|*[!0-9]*) fail "$dir/keys.json has no readable version" ;; esac
case $expires in '') fail "$dir/keys.json has no readable expiresAt" ;; esac
test "$version" -ge "$min" || fail "$dir/keys.json is version $version, below the pinned minimum $min: an older signed set is not shipped"
now=$(date -u +%Y%m%d%H%M%S)
expiry=$(printf '%s' "$expires" | tr -cd '0-9')
test "$expiry" -gt "$now" || fail "$dir/keys.json expired at $expires"
echo "check-key-set: ok ($dir/keys.json is version $version, valid until $expires, signed by the pinned root key)"
