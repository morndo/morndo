#!/bin/sh
# Fetch one Node distribution and check it the way Node documents, against a keyring the caller
# already pinned by commit. Node README, "Verifying binaries" (v24.21.0): gpgv, then shasum --check.
# https://github.com/nodejs/node/blob/v24.21.0/README.md#verifying-binaries read 2026-10-13.
set -eu
version=${1:?version}
triple=${2:?triple}
dest=${3:?dest}
keyring=${4:?keyring}
name="node-v${version}-${triple}.tar.gz"
base="https://nodejs.org/dist/v${version}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/SHASUMS256.txt.asc" "$base/SHASUMS256.txt.asc"
curl -fsSL -o "$work/$name" "$base/$name"
gpgv --keyring="$keyring" --output "$work/SHASUMS256.txt" < "$work/SHASUMS256.txt.asc"
( cd "$work" && shasum --check --ignore-missing SHASUMS256.txt )
mkdir -p "$dest"
tar -xzf "$work/$name" -C "$dest" --strip-components=1
test -x "$dest/bin/node"
