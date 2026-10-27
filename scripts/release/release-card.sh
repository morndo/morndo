#!/bin/sh
# Print the release card: every change, between two commits, in the paths that reach the signing keys or what a
# machine installs (.github/workflows/, .github/CODEOWNERS, scripts/release/, trust/, install.sh, apps/updater/).
# The owner reads it before the tap that lets a release run use a key (release plan, decision 9). The card only
# reads; it does not run the settings check (that needs an administrator token), and the run book pairs the two.
set -eu
LC_ALL=C
export LC_ALL
PATH=/usr/bin:/bin

fail() { printf '%s\n' "release-card: $*" >&2; exit 1; }
usage() { printf '%s\n' "release-card: $*" >&2; exit 64; }

if [ $# -ne 2 ] || [ -z "$1" ] || [ -z "$2" ]; then
  usage "usage: release-card.sh <base> <head>"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git repository"
# The pathspecs below are relative to the current directory, so from a subdirectory they would match nothing and the
# card would say nothing changed: read them from the top of the work tree.
cd "$(git rev-parse --show-toplevel)"

if ! base=$(git rev-parse --verify --quiet "$1^{commit}"); then
  fail "$1 does not resolve to a commit"
fi
if ! head=$(git rev-parse --verify --quiet "$2^{commit}"); then
  fail "$2 does not resolve to a commit"
fi
base8=$(printf '%s' "$base" | cut -c1-8)
head8=$(printf '%s' "$head" | cut -c1-8)
git merge-base --is-ancestor "$base" "$head" || fail "$base8 is not an ancestor of $head8"

# The release-critical paths. A directory pathspec covers what lies under it, a file pathspec exactly that file, so
# a lookalike (install.sh.bak) is not taken in. The card prints this list so the owner can see what it watched.
set -- .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/

printf 'release card: %s..%s\n' "$base8" "$head8"
printf 'paths: %s\n' "$*"

files=$(git diff --name-status --no-renames "$base" "$head" -- "$@")
if [ -z "$files" ]; then
  printf 'release card: no change in the release-critical paths since %s\n' "$base8"
  exit 0
fi

# git already lists the paths in byte order, and a rename without --no-renames detection is the delete beside the add.
printf 'files:\n'
printf '%s\n' "$files" | while read -r status path; do
  printf '  %s %s\n' "$status" "$path"
done

# Newest first, no merges. The sha is cut to eight characters, not --short (a cut is stable across git versions),
# and a subject may hold bytes no phone should render, so every control byte is removed from it.
printf 'commits:\n'
git log --no-merges --format='%H %s' "$base..$head" -- "$@" | while IFS= read -r line; do
  printf '  %s %s\n' "$(printf '%s' "$line" | cut -c1-8)" "$(printf '%s' "$line" | cut -d' ' -f2- | tr -d '\000-\037\177')"
done

count=$(( $(printf '%s\n' "$files" | wc -l) ))
printf 'release card: %s file(s) changed in the release-critical paths since %s\n' "$count" "$base8"
