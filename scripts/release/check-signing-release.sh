#!/bin/sh
# Run by the signing job before it signs: plain shell and system tools only, no node and no npm.
# The release key signs manifest.json and install.sh, so this checks them from the other side: the
# archives against the Manifest's sizes and digests, the file lists, SHA256SUMS, the set of files, and
# install.sh against the committed script with only the version stamped. Run from the repository root
# with dist/ holding the build artifacts and the unsigned files. VERSION and RELEASE_SHA come from the job.
set -eu
PATH=/usr/bin:/bin
: "${VERSION:?}"
: "${RELEASE_SHA:?}"

fail() {
  echo "refusing to sign: $1" >&2
  exit 1
}

cd dist
platforms="linux-x64 linux-arm64 darwin-arm64"

want="SHA256SUMS install.sh manifest.json"
for platform in $platforms; do
  want="$want files-$platform.json morndo-$VERSION-$platform.tar.gz"
done
have=$(ls -A | LC_ALL=C sort | tr '\n' ' ')
expected=$(printf '%s\n' $want | LC_ALL=C sort | tr '\n' ' ')
[ "$have" = "$expected" ] || fail "dist holds [$have], expected [$expected]"

[ "$(jq -r .version manifest.json)" = "$VERSION" ] || fail "manifest version is not $VERSION"
[ "$(jq -r .commit manifest.json)" = "$RELEASE_SHA" ] || fail "manifest commit is not $RELEASE_SHA"
[ "$(jq -r '.artifacts | length' manifest.json)" = 3 ] || fail "manifest does not list three artifacts"

for platform in $platforms; do
  name="morndo-$VERSION-$platform.tar.gz"
  row=$(jq -c --arg p "$platform" '.artifacts[] | select(.platform == $p)' manifest.json)
  [ -n "$row" ] || fail "manifest has no $platform artifact"
  [ "$(printf '%s' "$row" | jq -r .name)" = "$name" ] || fail "manifest names another archive for $platform"
  [ "$(printf '%s' "$row" | jq -r .size)" = "$(wc -c < "$name" | tr -d ' ')" ] || fail "$name is not the size the manifest says"
  [ "$(printf '%s' "$row" | jq -r .sha256)" = "$(sha256sum "$name" | cut -d' ' -f1)" ] || fail "$name is not the digest the manifest says"
  [ "$(printf '%s' "$row" | jq -r .filesSha256)" = "$(sha256sum "files-$platform.json" | cut -d' ' -f1)" ] || fail "files-$platform.json is not the digest the manifest says"
done

sha256sum -c SHA256SUMS > /dev/null || fail "SHA256SUMS does not match the files"
listed=$(cut -c67- SHA256SUMS | LC_ALL=C sort | tr '\n' ' ')
sums=$(printf '%s\n' install.sh manifest.json "morndo-$VERSION-linux-x64.tar.gz" "morndo-$VERSION-linux-arm64.tar.gz" "morndo-$VERSION-darwin-arm64.tar.gz" | LC_ALL=C sort | tr '\n' ' ')
[ "$listed" = "$sums" ] || fail "SHA256SUMS lists [$listed]"

# install.sh is the committed script with one line changed.
sed "s/^MORNDO_RELEASE_VERSION='0.0.0-unstamped'\$/MORNDO_RELEASE_VERSION='$VERSION'/" ../install.sh | cmp -s - install.sh || fail "install.sh is not the committed script stamped with $VERSION"

# Nothing signed yet.
[ ! -e manifest.json.sig ] && [ ! -e install.sh.sig ] || fail "a signature already exists"
echo "checked: archives, manifest, sums and install.sh agree"
