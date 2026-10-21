#!/bin/sh
# First-install bootstrap (docs/design/updates/README.md §10.3). The caller checks this file with
# ssh-keygen before running it. This script then checks the Manifest the same way, stops the
# download at the Manifest's size, checks the SHA-256, and only then runs that archive's bin/morndo.
# MORNDO_RELEASE_VERSION is stamped by the release job (scripts/release/stamp.ts). Unstamped, refuse.
set -eu

MORNDO_RELEASE_VERSION='0.0.0-unstamped'
# 'no' until the hub has an install command (a later change of the releases plan sets it to 'yes').
# Without it the hub treats `install` as an unknown command, creates its database and identity,
# prints help and exits 0, so this script would report success and install nothing.
MORNDO_HAS_INSTALL='no'

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
if [ "$MORNDO_HAS_INSTALL" != "yes" ]; then
  echo "morndo install is not in this release yet; nothing was downloaded or created" >&2
  exit 69
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

# Extract into an empty directory with tar's own checks, then judge the tree.
# Do not pass --absolute-names or -P: those turn the checks off.
# GNU tar 1.35 skips a member name that contains ".." and exits non-zero, and
# strips a leading "/". A symlink is still stored with the target from the
# archive (GNU tar NEWS 1.30 and 1.13.16; tar(1) --absolute-names,
# https://manpages.debian.org/bookworm/tar/tar.1.en.html, read 2026-10-13).
# bsdtar without -P removes a leading "/", refuses a pathname that contains
# "..", and refuses an entry that would retarget a directory through a symlink
# (https://man.freebsd.org/cgi/man.cgi?query=tar&sektion=1, FreeBSD 14.2, read 2026-10-13).
# The walk below is what refuses a symlink whose target climbs or is absolute.
set -f
mkdir "$work/extract"
if ! tar -xzf "$work/archive.tar.gz" -C "$work/extract"; then
  echo "refusing archive path" >&2
  exit 65
fi
# pwd -P is the physical directory. On macOS /var is a symlink to /private/var,
# and a logical pwd would not match a resolved link target.
extract_root=$(cd -P "$work/extract" && pwd -P)
# find -P does not follow symlinks, and set -f is on, so a "*" segment is not
# expanded. A link target is resolved with cd -P and pwd -P (POSIX), not
# realpath -m, which macOS and busybox reject.
# The check runs in this shell. find -exec + would turn an inner exit 65 into 1.
resolve() {
  dir=$1
  target=$2
  case $target in
    /*) cursor= ;;
    *) cursor=$(cd -P -- "$dir" && pwd -P) || return 1 ;;
  esac
  saved=$IFS
  IFS=/
  for part in $target; do
    if [ -z "$part" ] || [ "$part" = "." ]; then
      continue
    fi
    if [ "$part" = ".." ]; then
      cursor=${cursor%/*}
      [ -n "$cursor" ] || cursor=/
      continue
    fi
    if [ -z "$cursor" ] || [ "$cursor" = / ]; then
      next=/$part
    else
      next=$cursor/$part
    fi
    if [ -d "$next" ]; then
      cursor=$(cd -P -- "$next" && pwd -P) || return 1
    else
      cursor=$next
    fi
  done
  IFS=$saved
  printf "%s\n" "$cursor"
}
find -P "$extract_root" > "$work/paths"
while IFS= read -r path; do
  case "$path" in
    "$extract_root"|"$extract_root"/*) ;;
    *) echo "refusing archive path $path" >&2; exit 65 ;;
  esac
  case "$path" in
    *"
"*) echo "refusing archive path $path" >&2; exit 65 ;;
  esac
  if [ -L "$path" ]; then
    target=$(readlink "$path")
    case "$target" in
      *"
"*) echo "refusing archive path $path" >&2; exit 65 ;;
    esac
    dir=$(dirname "$path")
    resolved=$(resolve "$dir" "$target") || {
      echo "refusing archive path $path -> $target" >&2
      exit 65
    }
    case "$resolved" in
      "$extract_root"|"$extract_root"/*) ;;
      *) echo "refusing archive path $path -> $target" >&2; exit 65 ;;
    esac
  fi
done < "$work/paths"
mv "$work/extract" "$work/tree"
chmod 0555 "$work/tree/bin/morndo"
"$work/tree/bin/morndo" install --role "$role" --channel "$channel"
