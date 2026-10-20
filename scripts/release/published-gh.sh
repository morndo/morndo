#!/bin/sh
# The job checks out the release SHA so this script is in the tree. GH_REPO tells
# gh which repository to use
# (https://cli.github.com/manual/gh_help_environment, read 2026-10-13).
set -eu
: "${GH_REPO:?}"
: "${TAG:?}"
: "${RUNNER_TEMP:?}"
# The published release's own attestation, then every asset against it (gh release verify-asset,
# which needs the immutable release's attestation, so it can only run once the release is public).
# If either fails, the feed job does not run. The release is already public, so the summary names
# the manual withdrawal.
# https://cli.github.com/manual/gh_release_verify (read 2026-10-13)
# https://cli.github.com/manual/gh_release_verify-asset (read 2026-10-20)
# https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases (read 2026-10-13)
withdraw() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## Release attestation failed

The release for ${TAG} is already published and immutable, so this run cannot undo it or open the feed. Withdraw it by hand: delete that GitHub release.
EOF
  fi
  exit 1
}
gh release verify "$TAG" || withdraw
assets="$RUNNER_TEMP/assets"
rm -rf "$assets"
mkdir -p "$assets"
gh release download "$TAG" --dir "$assets" || withdraw
found=0
for file in "$assets"/*; do
  [ -f "$file" ] || continue
  found=1
  gh release verify-asset "$TAG" "$file" || withdraw
done
[ "$found" = 1 ] || withdraw
