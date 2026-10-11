#!/bin/sh
# Proves commit-traces and the commit-msg hook. Identity is set only on the
# git command, inside this throwaway repository.
set -eu

root=$(git rev-parse --show-toplevel)
checker=$root/scripts/git-hooks/commit-traces
hook=$root/scripts/git-hooks/commit-msg
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

msg=$scratch/msg
printf '%s\n' 'fix: clean note' > "$msg"
sh "$checker" message "$msg" || fail "clean message should exit 0"

printf '%s\n\n%s\n' 'fix: clean note' 'Co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>' > "$msg"
sh "$checker" message "$msg" || fail "dependabot trailer should exit 0"

bad_line() {
  label=$1
  body=$2
  printf '%s\n' "$body" > "$msg"
  set +e
  sh "$checker" message "$msg"
  code=$?
  set -e
  [ "$code" -eq 1 ] || fail "$label should exit 1, got $code"
}

bad_line "generated with" "$(printf '%s\n\n%s %s %s\n' 'fix: clean note' Generated with Example)"
bad_line "robot emoji" "$(printf 'fix: clean note %s\n' "$(printf '\360\237\244\226')")"
bad_line "assistant word" "fix: adjust the cursor blink"
bad_line "other bot trailer" "$(printf '%s\n\nCo-authored-by: %s <b@example.invalid>\n' 'fix: clean note' 'review[bot]')"

git init -q "$scratch/repo"
cd "$scratch/repo"
ln -sfn "$hook" .git/hooks/commit-msg
git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q --allow-empty -m 'fix: clean note' \
  || fail "hook should allow a clean message"
git -c user.name='dependabot[bot]' -c user.email='49699333+dependabot[bot]@users.noreply.github.com' \
  commit -q --allow-empty -m 'chore: bump a fixture' || fail "hook should allow dependabot[bot]"

set +e
git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q --allow-empty -m "$(printf 'fix: clean note\n\nGenerated with Example')"
code=$?
set -e
[ "$code" -ne 0 ] || fail "hook should reject a generated-with message"

parent=$(git rev-parse HEAD)
git -c user.name='claude[bot]' -c user.email=bot@users.noreply.github.com commit -q --allow-empty -m 'fix: clean note' \
  || fail "hook checks the message only; a bot author is a CI check"
tip=$(git rev-parse HEAD)
set +e
sh "$checker" range "$parent..$tip"
code=$?
set -e
[ "$code" -eq 1 ] || fail "bot author should exit 1, got $code"

git -c user.name='copilot-swe-agent' -c user.email=swe@users.noreply.github.com commit -q --allow-empty -m 'fix: clean note'
tip=$(git rev-parse HEAD)
set +e
sh "$checker" range "$parent..$tip"
code=$?
set -e
[ "$code" -eq 1 ] || fail "agent author should exit 1, got $code"

set +e
sh "$checker" range HEAD
code=$?
set -e
[ "$code" -eq 1 ] || fail "range including a bot author should exit 1, got $code"

mail_base=$(git rev-parse HEAD)
env GIT_AUTHOR_EMAIL=ada@example.invalid git -c user.name=Ada -c user.email=ada@users.noreply.github.com \
  commit -q --allow-empty -m 'fix: clean note'
tip=$(git rev-parse HEAD)
set +e
sh "$checker" range "$mail_base..$tip"
code=$?
set -e
[ "$code" -eq 1 ] || fail "author email should exit 1, got $code"
git reset -q --hard "$mail_base"
env GIT_COMMITTER_EMAIL=ada@example.invalid git -c user.name=Ada -c user.email=ada@users.noreply.github.com \
  commit -q --allow-empty -m 'fix: clean note'
tip=$(git rev-parse HEAD)
set +e
sh "$checker" range "$mail_base..$tip"
code=$?
set -e
[ "$code" -eq 1 ] || fail "committer email should exit 1, got $code"

echo "commit-traces proof ok"
