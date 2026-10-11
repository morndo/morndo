#!/bin/sh
# Point this clone's hooks at scripts/git-hooks. Does not change git config.
set -eu
root=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-path hooks)
mkdir -p "$hooks"
link() {
  src=$root/scripts/git-hooks/$1
  dest=$hooks/$1
  if [ "$(readlink -f "$src")" = "$(readlink -f "$dest")" ]; then
    echo "installed $dest"
    return 0
  fi
  ln -sfn "$src" "$dest"
  echo "installed $dest"
}
link pre-push
link commit-msg
