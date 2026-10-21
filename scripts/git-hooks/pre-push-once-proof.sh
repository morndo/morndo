#!/bin/sh
# Proves the pre-push hook reads a push once. Two pushed refs share commits:
# each commit is read once (one diff-tree --stdin list with no sha twice, one
# rev-list of the union, one gitleaks scan), and the searches are one pass over
# the added lines, not one per line: the count of grep runs does not follow the
# number of lines. A home path in a commit both refs share still fails.
# Runs in scratch repositories only; it needs no history of its own.
set -eu

root=$(git rev-parse --show-toplevel)
hook="$root/scripts/git-hooks/pre-push"
real_git=$(command -v git)
real_grep=$(command -v grep)
real_gitleaks=$(command -v gitleaks)
scratch=$(mktemp -d)
trap 'rm -rf "${scratch:?}"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
commit_ok() { git -c user.name=Ada -c user.email=ada@users.noreply.github.com commit -q "$@"; }

# Shims that write down what the hook runs, then run the real program.
log="$scratch/log"
mkdir -p "$log" "$scratch/bin"
cat > "$scratch/bin/git" <<EOF
#!/bin/sh
case "\$1" in
  rev-list) echo "\$*" >> "$log/revlist" ;;
  diff-tree)
    case " \$* " in
      *" --stdin "*) tee -a "$log/shas" | "$real_git" "\$@"; exit \$? ;;
    esac
    ;;
esac
exec "$real_git" "\$@"
EOF
cat > "$scratch/bin/grep" <<EOF
#!/bin/sh
echo x >> "$log/grep"
exec "$real_grep" "\$@"
EOF
cat > "$scratch/bin/gitleaks" <<EOF
#!/bin/sh
case "\$1" in detect) echo "\$*" >> "$log/gitleaks" ;; esac
exec "$real_gitleaks" "\$@"
EOF
chmod +x "$scratch/bin/git" "$scratch/bin/grep" "$scratch/bin/gitleaks"

zero=0000000000000000000000000000000000000000
repo="$scratch/repo"
git init -q "$repo"
cp "$root/.gitleaks.toml" "$repo/.gitleaks.toml"
cd "$repo"
git checkout -q -b main
printf 'base\n' > base.txt
git add .gitleaks.toml base.txt
commit_ok -m 'chore: base'

# Branch a: three commits of a hundred lines each. Branch b: starts at a's tip,
# so it shares those three commits and the base, and adds two of its own.
git checkout -q -b a
for n in 1 2 3; do
  i=1
  while [ "$i" -le 100 ]; do printf 'note %s line %s\n' "$n" "$i"; i=$((i + 1)); done > "a$n.txt"
  git add "a$n.txt"
  commit_ok -m "feat: a$n"
done
git checkout -q -b b
for n in 1 2; do
  i=1
  while [ "$i" -le 100 ]; do printf 'more %s line %s\n' "$n" "$i"; i=$((i + 1)); done > "b$n.txt"
  git add "b$n.txt"
  commit_ok -m "feat: b$n"
done
a=$(git rev-parse a)
b=$(git rev-parse b)

push() {
  rm -rf "${log:?}"/*
  : > "$log/shas"; : > "$log/revlist"; : > "$log/grep"; : > "$log/gitleaks"
  printf '%s %s %s %s\n%s %s %s %s\n' refs/heads/a "$a" refs/heads/a "$zero" refs/heads/b "$b" refs/heads/b "$zero" \
    | PATH="$scratch/bin:$PATH" sh "$hook" "$scratch/nowhere.git"
}

set +e
push > "$scratch/out" 2>&1
code=$?
set -e
[ "$code" -eq 0 ] || { cat "$scratch/out" >&2; fail "two clean refs should exit 0, got $code"; }

# gitleaks is given a clean selection: it says nothing of a malformed argument.
"$real_grep" -q 'ERR' "$scratch/out" && { cat "$scratch/out" >&2; fail "gitleaks printed an error"; }
# Six commits in the union: the base, a1 to a3, b1 and b2. Each is read once.
total=$(wc -l < "$log/shas" | tr -d ' ')
unique=$(sort -u "$log/shas" | wc -l | tr -d ' ')
[ "$total" -eq 6 ] || fail "the union is six commits, diff-tree was given $total"
[ "$unique" -eq "$total" ] || fail "a commit was given to diff-tree more than once ($unique of $total)"
# One rev-list of the union beside commit-traces' own, one gitleaks scan of it.
parents=$("$real_grep" -c -e '--parents' "$log/revlist" || true)
[ "$parents" -eq 1 ] || fail "the hook lists the push with one rev-list --parents, it ran $parents"
"$real_grep" -q -e "$a" -e "$b" "$log/revlist" || fail "the rev-list names the pushed tips"
leaks=$(wc -l < "$log/gitleaks" | tr -d ' ')
[ "$leaks" -eq 1 ] || fail "gitleaks scans the union once, it ran $leaks times"
"$real_grep" -q -F "$a" "$log/gitleaks" && "$real_grep" -q -F "$b" "$log/gitleaks" || fail "gitleaks is given both tips"
# Six hundred added lines, and the searches stay few: a run per line would be 600.
greps=$(wc -l < "$log/grep" | tr -d ' ')
[ "$greps" -lt 60 ] || fail "$greps greps for 600 added lines: the searches follow the lines"

# A home path in a commit both refs share still fails, once.
git checkout -q a
printf '/%s/%s/notes\n' home example-user > planted-note.txt
git add planted-note.txt
commit_ok -m 'feat: planted'
git checkout -q -b c
git checkout -q a
a=$(git rev-parse a)
b=$(git rev-parse c)
set +e
push > "$scratch/out" 2>&1
code=$?
set -e
[ "$code" -eq 1 ] || fail "a planted path in a shared commit should exit 1, got $code"
"$real_grep" -q 'planted-note.txt' "$scratch/out" || fail "the hook names the planted file"

echo "pre-push once proof: ok"
