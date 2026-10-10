#!/bin/sh
# Point this clone's hooks at scripts/git-hooks. Does not change git config.
set -eu
root=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-path hooks)
mkdir -p "$hooks"
ln -sfn "$root/scripts/git-hooks/pre-push" "$hooks/pre-push"
echo "installed $hooks/pre-push"
