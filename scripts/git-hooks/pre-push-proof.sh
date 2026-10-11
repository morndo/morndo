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
git commit -q -m 'clean proof'
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
git commit -q -m 'planted proof'
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
git commit -q -m 'first clean'
tip=$(git rev-parse HEAD)
set +e
printf '%s %s %s %s\n' refs/heads/main "$tip" refs/heads/main "$zero" | sh "$root/$hook"
code=$?
set -e
[ "$code" -eq 0 ] || fail "first push of a clean tree should exit 0, got $code"
printf '/%s/%s/notes\n' home example-user > planted-note.txt
git add planted-note.txt
git commit -q -m 'first planted'
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

echo "pre-push proof ok"
