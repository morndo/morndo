#!/bin/sh
# The published job has no checkout. GH_REPO tells gh which repository to use
# (https://cli.github.com/manual/gh_help_environment, read 2026-10-13).
set -eu
: "${GH_REPO:?}"
: "${TAG:?}"
dest=${RUNNER_TEMP:?}/assets
mkdir -p "$dest"
gh release download "$TAG" --dir "$dest"
# Only the release attestation is checked here. Asset digests were checked on the draft
# with gh attestation verify. If this fails, the feed job does not run. The release is
# already public, so the summary names the manual withdrawal.
# https://cli.github.com/manual/gh_release_verify (read 2026-10-13)
# https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases (read 2026-10-13)
if ! gh release verify "$TAG"; then
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    cat >> "$GITHUB_STEP_SUMMARY" <<EOF
## Release attestation failed

The release for ${TAG} is already published and immutable, so this run cannot undo it or open the feed. Withdraw it by hand: delete that GitHub release.
EOF
  fi
  exit 1
fi
