#!/bin/sh
# Proves the pre-push hook: a clean tree passes; a made-up home path fails;
# a marker this script writes into its own leak-patterns file fails; a
# committed home path fails in a throwaway clone, and a clean commit passes.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
hook=scripts/git-hooks/pre-push
plant="$root/.leak-proof-plant"
gitdir=$(git rev-parse --git-dir)
extra="$gitdir/info/leak-patterns"
scratch=
saved=
if [ -f "$extra" ]; then
  saved=$(mktemp)
  cp "$extra" "$saved"
fi

cleanup() {
  if [ -f apps/fleet/test/client-api.test.ts.proof-bak ]; then
    mv apps/fleet/test/client-api.test.ts.proof-bak apps/fleet/test/client-api.test.ts
  fi
  rm -f "$plant"
  if [ -n "$scratch" ]; then
    rm -rf "$scratch"
  fi
  if [ -n "$saved" ]; then
    mkdir -p "$gitdir/info"
    cp "$saved" "$extra"
    rm -f "$saved"
  else
    rm -f "$extra"
  fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
commit_ok() { git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q "$@"; }

sh "$hook" </dev/null || fail "hook should exit 0 on the current tree"

# Built at runtime so this script does not itself contain a home path.
printf '/%s/%s/notes\n' home example-user > "$plant"
set +e
sh "$hook" </dev/null
code=$?
set -e
rm -f "$plant"
[ "$code" -eq 1 ] || fail "planted home path should exit 1, got $code"

# Built at runtime so this script does not itself contain a key header.
printf '%s%s%s\n' '-----BEGIN ' 'PRIVATE KEY' '-----' > "$plant"
set +e
sh "$hook" </dev/null
code=$?
set -e
rm -f "$plant"
[ "$code" -eq 1 ] || fail "planted private key should exit 1, got $code"

# An allowlisted file still fails when a different match is added.
sample=apps/fleet/test/client-api.test.ts
cp "$sample" "$sample.proof-bak"
printf '\n/%s/%s/notes\n' home example-user >> "$sample"
set +e
sh "$hook" </dev/null
code=$?
set -e
mv "$sample.proof-bak" "$sample"
[ "$code" -eq 1 ] || fail "different match in an allowlisted file should exit 1, got $code"

mkdir -p "$gitdir/info"
printf '%s\n' 'zz-private-marker' > "$extra"
printf '%s\n' 'note zz-private-marker' > "$plant"
set +e
sh "$hook" </dev/null
code=$?
set -e
rm -f "$plant" "$extra"
[ "$code" -eq 1 ] || fail "local pattern should exit 1, got $code"

# Throwaway clone: the hook must see a committed path, not only a dirty file.
# A first push (no remote refs) scans the whole tree.
zero=0000000000000000000000000000000000000000
scratch=$(mktemp -d)
git clone --quiet --local "$root" "$scratch/clone"
git -C "$scratch/clone" checkout -q --detach

cd "$scratch/clone"
printf 'ok\n' > clean-note.txt
git add clean-note.txt
commit_ok -m 'clean proof'
parent=$(git rev-parse HEAD~1)
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/proof "$tip" refs/heads/proof "$parent" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "clean commit should exit 0, got $code"
set +e
printf '%s %s %s %s\n' refs/heads/proof "$tip" refs/heads/proof "$zero" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "clean new branch should exit 0, got $code"

printf '/%s/%s/notes\n' home example-user > planted-note.txt
git add planted-note.txt
commit_ok -m 'planted proof'
parent=$(git rev-parse HEAD~1)
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/proof "$tip" refs/heads/proof "$parent" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "planted commit should exit 1, got $code"
set +e
printf '%s %s %s %s\n' refs/heads/proof "$tip" refs/heads/proof "$zero" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "planted new branch should exit 1, got $code"
cd "$root"

git init -q "$scratch/first"
cp "$root/.gitleaks.toml" "$scratch/first/.gitleaks.toml"
cd "$scratch/first"
printf 'ok\n' > readme.txt
git add readme.txt .gitleaks.toml
commit_ok -m 'first clean'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$zero" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "first push of a clean tree should exit 0, got $code"
printf '/%s/%s/notes\n' home example-user > planted-note.txt
git add planted-note.txt
commit_ok -m 'first planted'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$zero" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "first push of a planted tree should exit 1, got $code"
cd "$root"

# First push of this tree: drop remote-tracking refs so the hook scans every file.
git clone --quiet --local "$root" "$scratch/tree"
git -C "$scratch/tree" remote remove origin
tip=$(git -C "$scratch/tree" rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$zero" | (cd "$scratch/tree" && sh "$root/$hook")
code=$?
set -e
[ "$code" -eq 0 ] || fail "first push of this tree should exit 0, got $code"

# A later edit of a test must not fail on a key header that was already there.
# A new header in a test file is a fixture. The same header outside a test,
# or a home path in a test, still fails. The path is not on the allowlist.
git init -q "$scratch/touch"
cp "$root/.gitleaks.toml" "$scratch/touch/.gitleaks.toml"
cd "$scratch/touch"
printf 'ok\n' > readme.txt
git add readme.txt .gitleaks.toml
commit_ok -m 'touch base'
mkdir -p pkg/test
{
  printf 'export const label = "old";\n'
  printf '%s%s%s\n' '-----BEGIN ' 'PRIVATE KEY' '-----'
} > pkg/test/old-marker.test.ts
git add pkg/test/old-marker.test.ts
commit_ok -m 'old marker'
base=$(git rev-parse HEAD)
printf '\nexport const touched = true;\n' >> pkg/test/old-marker.test.ts
git add pkg/test/old-marker.test.ts
commit_ok -m 'touch the test'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "edit beside an old test header should exit 0, got $code"
git reset -q --hard "$base"
{
  printf 'export const label = "new";\n'
  printf '%s%s%s\n' '-----BEGIN ' 'PRIVATE KEY' '-----'
} > pkg/test/fresh.test.ts
git add pkg/test/fresh.test.ts
commit_ok -m 'fresh fixture'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "new test header should exit 0, got $code"
git reset -q --hard "$base"
mkdir -p pkg/src
printf '%s%s%s\n' '-----BEGIN ' 'PRIVATE KEY' '-----' > pkg/src/app.ts
git add pkg/src/app.ts
commit_ok -m 'source marker'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "header outside a test should exit 1, got $code"
git reset -q --hard "$base"
printf '/%s/%s/notes\n' home example-user > pkg/test/home.test.ts
git add pkg/test/home.test.ts
commit_ok -m 'home in a test'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "home path in a test should exit 1, got $code"
cd "$root"

# A line that starts with '++' is content, not a diff header. The home path
# after it still fails, as does the same path without that line.
git init -q "$scratch/hunk"
cp "$root/.gitleaks.toml" "$scratch/hunk/.gitleaks.toml"
cd "$scratch/hunk"
printf 'keep\n' > a.md
git add a.md .gitleaks.toml
commit_ok -m 'hunk base'
base=$(git rev-parse HEAD)
printf 'keep\n++ counter\n/%s/%s/notes\n' home realperson > a.md
git add a.md
commit_ok -m 'plus plus then a path'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "path after a plus-plus line should exit 1, got $code"
git reset -q --hard "$base"
printf 'keep\n/%s/%s/notes\n' home realperson > a.md
git add a.md
commit_ok -m 'path alone'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "path without a plus-plus line should exit 1, got $code"
cd "$root"

# The first match on a line being allowlisted must not hide a later one.
git init -q "$scratch/line"
cp "$root/.gitleaks.toml" "$scratch/line/.gitleaks.toml"
cd "$scratch/line"
mkdir -p apps/fleet/test
printf 'base\n' > apps/fleet/test/client-api.test.ts
git add apps/fleet/test/client-api.test.ts .gitleaks.toml
commit_ok -m 'line base'
base=$(git rev-parse HEAD)
printf 'see /%s/%s/ and /%s/%s/\n' home u home realname >> apps/fleet/test/client-api.test.ts
git add apps/fleet/test/client-api.test.ts
commit_ok -m 'two paths'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "second path on an allowlisted line should exit 1, got $code"
git reset -q --hard "$base"
mkdir -p "$(git rev-parse --git-dir)/info"
marker=$(printf '%s-%s-%s' zz private marker)
printf '%s\n' "$marker" > "$(git rev-parse --git-dir)/info/leak-patterns"
printf '/%s/%s/ %s\n' home u "$marker" >> apps/fleet/test/client-api.test.ts
git add apps/fleet/test/client-api.test.ts
commit_ok -m 'path and a local pattern'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "local pattern beside an allowlisted path should exit 1, got $code"
cd "$root"

# An unreadable untracked file, and a git grep that cannot read the tree, abort.
git init -q "$scratch/closed"
cp "$root/.gitleaks.toml" "$scratch/closed/.gitleaks.toml"
cd "$scratch/closed"
printf 'ok\n' > readme.txt
git add readme.txt .gitleaks.toml
commit_ok -m 'closed base'
printf 'hidden\n' > hidden.txt
chmod 000 hidden.txt
set +e
out=$(sh "$root/$hook" </dev/null 2>&1)
code=$?
set -e
chmod 644 hidden.txt
[ "$code" -eq 1 ] || fail "unreadable file should exit 1, got $code"
printf '%s\n' "$out" | grep -q 'pattern search failed' || fail "unreadable file should say the search failed"
rm -f hidden.txt
printf 'x\n' > extra.txt
git add extra.txt
commit_ok -m 'missing tree'
bad=$(git rev-parse HEAD)
tree=$(git rev-parse "$bad^{tree}")
git reset -q --hard HEAD~1
rm -f ".git/objects/${tree%${tree#??}}/${tree#??}"
set +e
out=$(printf '%s %s %s %s\n' refs/heads/main "$bad" refs/heads/main "$zero" | sh "$root/$hook" 2>&1)
code=$?
set -e
[ "$code" -eq 1 ] || fail "unreadable tree should exit 1, got $code"
printf '%s\n' "$out" | grep -q 'pattern search failed' || fail "unreadable tree should say the search failed"
cd "$root"

# Author and committer must both be a noreply address. Identity is set on the command.
git init -q "$scratch/mail"
cp "$root/.gitleaks.toml" "$scratch/mail/.gitleaks.toml"
cd "$scratch/mail"
printf 'ok\n' > readme.txt
git add readme.txt .gitleaks.toml
commit_ok -m 'mail base'
base=$(git rev-parse HEAD)
git -c user.name='dependabot[bot]' -c user.email='49699333+dependabot[bot]@users.noreply.github.com' commit -q --allow-empty -m 'chore: bump a fixture'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "bot noreply address should exit 0, got $code"
git reset -q --hard "$base"
env GIT_AUTHOR_EMAIL=ada@example.invalid git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q --allow-empty -m 'author mail'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "author email should exit 1, got $code"
git reset -q --hard "$base"
env GIT_COMMITTER_EMAIL=ada@example.invalid git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q --allow-empty -m 'committer mail'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$base" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 1 ] || fail "committer email should exit 1, got $code"
cd "$root"

echo "pre-push proof ok"
