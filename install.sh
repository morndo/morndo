#!/bin/sh
# First-install bootstrap (docs/design/updates/README.md §10.3). The caller checks this file with
# ssh-keygen before running it. This script then checks the Manifest the same way, stops the
# download at the Manifest's size, checks the SHA-256, and only then runs that archive's bin/morndo.
# MORNDO_RELEASE_VERSION is stamped by the release job (scripts/release/stamp.ts). Unstamped, refuse.
set -eu

MORNDO_RELEASE_VERSION='0.0.0-unstamped'

usage() {
  echo "usage: sh install.sh --role control-plane|node [--channel stable|latest] --signers FILE" >&2
  exit 64
}

role=
channel=stable
signers=
while [ $# -gt 0 ]; do
  case $1 in
    --role) role=${2:?}; shift 2 ;;
    --channel) channel=${2:?}; shift 2 ;;
    --signers) signers=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done

[ "$role" = "control-plane" ] || [ "$role" = "node" ] || usage
[ "$channel" = "stable" ] || [ "$channel" = "latest" ] || usage
[ -n "$signers" ] || usage

if [ "$MORNDO_RELEASE_VERSION" = "0.0.0-unstamped" ]; then
  echo "install.sh is not stamped with a release version" >&2
  exit 78
fi
[ -f "$signers" ] || usage

os=$(uname -s)
arch=$(uname -m)
case "$os-$arch" in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) echo "unsupported platform $os-$arch" >&2; exit 78 ;;
esac

base=${MORNDO_RELEASE_BASE:-https://github.com/morndo/morndo/releases/download/v$MORNDO_RELEASE_VERSION}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/manifest.json" "$base/manifest.json"
curl -fsSL -o "$work/manifest.json.sig" "$base/manifest.json.sig"
ssh-keygen -Y verify -f "$signers" -I release@morndo.github.io -n release@morndo.github.io -s "$work/manifest.json.sig" < "$work/manifest.json"

# The Manifest is our canonical JSON, already verified above. One field per line, no shell evaluation.
awk -v want="$platform" '
  $1 == "\"version\":" && $2 ~ /^"/ && !seen_version { gsub(/[",]/, "", $2); print "version " $2; seen_version = 1 }
  $1 == "\"platform\":" { gsub(/[",]/, "", $2); plat = $2 }
  $1 == "\"name\":" { gsub(/[",]/, "", $2); name = $2 }
  $1 == "\"size\":" { gsub(/,/, "", $2); size = $2 }
  $1 == "\"sha256\":" && plat == want && !seen_art {
    gsub(/[",]/, "", $2); print "name " name; print "size " size; print "hash " $2; seen_art = 1
  }
' "$work/manifest.json" > "$work/pick"
version=
name=
size=
hash=
while read -r key value; do
  case $key in
    version) version=$value ;;
    name) name=$value ;;
    size) size=$value ;;
    hash) hash=$value ;;
  esac
done < "$work/pick"

[ "$version" = "$MORNDO_RELEASE_VERSION" ] || { echo "manifest version is not $MORNDO_RELEASE_VERSION" >&2; exit 65; }
[ -n "${name:-}" ] && [ -n "${size:-}" ] && [ -n "${hash:-}" ] || { echo "no artifact for $platform" >&2; exit 65; }

curl -fsSL --max-filesize "$size" -o "$work/archive.tar.gz" "$base/$name"
got=$(wc -c < "$work/archive.tar.gz" | tr -d " ")
[ "$got" = "$size" ] || { echo "archive size $got is not $size" >&2; exit 65; }
if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$work/archive.tar.gz" | awk '{print $1}')
else
  sum=$(shasum -a 256 "$work/archive.tar.gz" | awk '{print $1}')
fi
[ "$sum" = "$hash" ] || { echo "archive digest does not match the manifest" >&2; exit 65; }

# GNU tar 1.35 does not refuse a symlink target that climbs out
# (https://www.gnu.org/software/tar/manual/html_section/Security.html, read 2026-10-13).
# bsdtar secures member names, not every link target. Read the target from tar -tv and refuse it here.
tar -tvzf "$work/archive.tar.gz" > "$work/list"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  target=
  case $line in
    *" -> "*)
      target=${line#* -> }
      left=${line%% -> *}
      entry=${left##* }
      ;;
    *) entry=${line##* } ;;
  esac
  path=${entry#./}
  case $path in
    /*) echo "refusing archive path $entry" >&2; exit 65 ;;
  esac
  saved=$IFS
  IFS=/
  for part in $path; do
    if [ "$part" = ".." ]; then
      echo "refusing archive path $entry" >&2
      exit 65
    fi
  done
  if [ -n "$target" ]; then
    rel=${target#./}
    case $rel in
      /*) echo "refusing archive path $entry -> $target" >&2; exit 65 ;;
    esac
    depth=0
    IFS=/
    for part in $path; do
      [ -n "$part" ] || continue
      depth=$((depth + 1))
    done
    # The last segment is the link itself, not a directory.
    depth=$((depth - 1))
    for part in $rel; do
      if [ "$part" = ".." ]; then
        if [ "$depth" -le 0 ]; then
          echo "refusing archive path $entry -> $target" >&2
          exit 65
        fi
        depth=$((depth - 1))
      elif [ -n "$part" ] && [ "$part" != "." ]; then
        depth=$((depth + 1))
      fi
    done
  fi
  IFS=$saved
done < "$work/list"

mkdir -p "$work/tree"
tar -xzf "$work/archive.tar.gz" -C "$work/tree"
chmod 0555 "$work/tree/bin/morndo"
"$work/tree/bin/morndo" install --role "$role" --channel "$channel"
