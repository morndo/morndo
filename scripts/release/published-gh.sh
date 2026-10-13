#!/bin/sh
# The published job has no checkout. GH_REPO tells gh which repository to use
# (https://cli.github.com/manual/gh_help_environment, read 2026-10-13).
set -eu
: "${GH_REPO:?}"
: "${TAG:?}"
dest=${RUNNER_TEMP:?}/assets
mkdir -p "$dest"
gh release download "$TAG" --dir "$dest"
for f in "$dest"/morndo-*.tar.gz "$dest/manifest.json" "$dest/install.sh" "$dest/SHA256SUMS"; do
  gh release verify-asset "$TAG" "$f"
done
gh release verify "$TAG"
