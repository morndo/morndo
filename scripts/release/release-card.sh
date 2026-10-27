#!/bin/sh
# Print the release card the owner reads before the tap that lets a release run use a key (release plan, decision 9):
# every change between two commits in the paths that reach the signing keys, install what a machine runs, or install
# what CI runs (npm ci reads package.json and package-lock.json) — .github/workflows/, .github/CODEOWNERS,
# scripts/release/, trust/, install.sh, apps/updater/, package.json, package-lock.json — and the release-settings
# check's own output when its arguments follow `--` (check-release-settings.sh needs an administrator token and never
# runs inside Actions; the run book pairs the two, and RELEASE_CARD_SETTINGS_CHECK names another check). The card only
# reads. Exit codes: 0 the card is complete and the settings check, when its arguments were given, passed; 1 the git
# side failed or the settings check failed (do not tap); 3 the card is incomplete — the settings check was named or
# asked for but did not run; 64 usage.
set -eu
LC_ALL=C
export LC_ALL

fail() { printf '%s\n' "release-card: $*" >&2; exit 1; }
usage() { printf '%s\n' "release-card: $*" >&2; exit 64; }

# release-card.sh <base> <head> [-- <check-release-settings.sh arguments>...]
have_settings=0
if [ $# -lt 2 ] || [ -z "$1" ] || [ -z "$2" ] || [ "$1" = "--" ] || [ "$2" = "--" ]; then
  usage "usage: release-card.sh <base> <head> [-- <check-release-settings.sh arguments>]"
fi
if [ $# -gt 2 ]; then
  if [ "$3" = "--" ] && [ $# -ge 4 ]; then
    have_settings=1
  else
    usage "usage: release-card.sh <base> <head> [-- <check-release-settings.sh arguments>]"
  fi
fi

command -v git >/dev/null 2>&1 || fail "git is not on PATH"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not inside a git repository"

# $0 may be relative, so find the script's own directory before the cd to the top of the work tree.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
check=${RELEASE_CARD_SETTINGS_CHECK:-$here/check-release-settings.sh}

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

if [ "$have_settings" = 1 ]; then
  shift 3
fi

# Everything is read from git before anything is printed, so a git that fails leaves no half-printed card. A directory
# pathspec covers what lies under it, a file pathspec exactly that file, so a lookalike (install.sh.bak) is not taken
# in. A plain merge is not listed (with a pathspec, git leaves out a merge whose watched paths equal one parent's),
# but a merge that itself changes a watched path is, since the owner must see that change.
files=$(git diff --name-status --no-renames "$base" "$head" -- .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/ package.json package-lock.json) || fail "git diff failed"
commits=$(git log --format='%H %s' "$base..$head" -- .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/ package.json package-lock.json) || fail "git log failed"

printf 'release card: %s..%s\n' "$base8" "$head8"

# The paths line names the watched paths this range touched, in the order above; when nothing changed it names the
# whole watch list, so the owner sees what the card kept an eye on. A change is "<status>\t<path>", and the tab in
# front of the path keeps a longer path (apps/updater/install.sh) from answering for a file pathspec.
tab=$(printf '\t')
involved=''
case $files in *"${tab}.github/workflows/"*) involved="$involved .github/workflows/" ;; esac
case $files in *"${tab}.github/CODEOWNERS"*) involved="$involved .github/CODEOWNERS" ;; esac
case $files in *"${tab}scripts/release/"*) involved="$involved scripts/release/" ;; esac
case $files in *"${tab}trust/"*) involved="$involved trust/" ;; esac
case $files in *"${tab}install.sh"*) involved="$involved install.sh" ;; esac
case $files in *"${tab}apps/updater/"*) involved="$involved apps/updater/" ;; esac
case $files in *"${tab}package.json"*) involved="$involved package.json" ;; esac
case $files in *"${tab}package-lock.json"*) involved="$involved package-lock.json" ;; esac
if [ -z "$involved" ]; then
  involved=' .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/ package.json package-lock.json'
fi
printf 'paths:%s\n' "$involved"

if [ -n "$files" ]; then
  # git already lists the paths in byte order, and a rename without rename detection is the delete beside the add.
  printf 'files:\n'
  printf '%s\n' "$files" | while read -r status path; do
    printf '  %s %s\n' "$status" "$path"
  done

  # Newest first. The sha is cut to eight characters, not --short (a cut is stable across git versions), and a
  # subject may hold bytes no phone should render, so every control byte is removed from it.
  printf 'commits:\n'
  printf '%s\n' "$commits" | while IFS= read -r line; do
    printf '  %s %s\n' "$(printf '%s' "$line" | cut -c1-8)" "$(printf '%s' "$line" | cut -d' ' -f2- | tr -d '\000-\037\177')"
  done
fi

# The settings section. plain: no arguments and no check named — the card is the plain diff card and claims nothing
# about settings. noargs: a check was named (RELEASE_CARD_SETTINGS_CHECK) but no arguments followed `--`, so the card
# is incomplete. missing: the check file is not there, incomplete as well. ran: its exit code decides the verdict.
check_mode=plain
check_st=0
if [ "$have_settings" != 1 ]; then
  printf 'settings: not run\n'
  if [ -n "${RELEASE_CARD_SETTINGS_CHECK:-}" ]; then
    check_mode=noargs
  fi
elif [ ! -f "$check" ]; then
  printf 'settings: not run\n'
  check_mode=missing
else
  check_mode=ran
  printf 'settings: sh %s\n' "$check $*"
  out=$(sh "$check" "$@" 2>&1) || check_st=$?
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | while IFS= read -r line; do printf '  %s\n' "$line"; done
  fi
fi

if [ -z "$files" ]; then
  printf 'release card: no change in the release-critical paths since %s\n' "$base8"
else
  count=$(( $(printf '%s\n' "$files" | wc -l) ))
  printf 'release card: %s file(s) changed in the release-critical paths since %s\n' "$count" "$base8"
fi

case $check_mode in
  ran)
    if [ "$check_st" -eq 0 ]; then
      printf 'release card: settings check ok\n'
      exit 0
    elif [ "$check_st" -eq 1 ]; then
      printf 'release card: SETTINGS CHECK FAILED (exit 1): do not tap\n'
      exit 1
    else
      printf 'release card: SETTINGS CHECK NOT RUN: it exited %s; this card is incomplete\n' "$check_st"
      exit 3
    fi
    ;;
  noargs)
    printf 'release card: SETTINGS CHECK NOT RUN: no settings arguments (release-card.sh <base> <head> -- --reviewer-id <id> --app-id <id> [...]); this card is incomplete\n'
    exit 3
    ;;
  missing)
    printf 'release card: SETTINGS CHECK NOT RUN: %s is not there; this card is incomplete\n' "$check"
    exit 3
    ;;
  plain)
    exit 0
    ;;
esac
