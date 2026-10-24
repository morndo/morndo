#!/bin/sh
# Build a local release-bench tree from one commit plus the known overlay, or audit a tree already built.
# Nothing is published. The only signer material read is the public root line the caller passes in.
set -eu
LC_ALL=C
export LC_ALL
PATH=/usr/bin:/bin

fail() { printf '%s\n' "bench-overlay: $*" >&2; exit 1; }
usage() { printf '%s\n' "bench-overlay: $*" >&2; exit 64; }

base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
standin_src=$base/bench-overlay/release-please-standin.yml
removed_list=$base/bench-overlay/removed-tests.txt

mode=build
commit=
version=
trust=
signer=
out=
repo=
have_version=0
have_trust=0
have_signer=0
have_out=0

if [ $# -lt 1 ]; then
  usage "missing arguments"
fi

if [ "$1" = "--audit" ]; then
  mode=audit
  shift
  if [ $# -lt 1 ] || [ -z "$1" ] || [ "${1#--}" != "$1" ]; then
    usage "missing commit"
  fi
  commit=$1
  shift
  if [ $# -lt 1 ] || [ -z "$1" ] || [ "${1#--}" != "$1" ]; then
    usage "missing out directory"
  fi
  out=$1
  shift
else
  if [ -z "$1" ] || [ "${1#--}" != "$1" ]; then
    usage "missing commit"
  fi
  commit=$1
  shift
fi

while [ $# -gt 0 ]; do
  case $1 in
    --version)
      [ "$mode" = build ] || usage "unknown argument: --version"
      [ $# -ge 2 ] || usage "missing argument: --version"
      [ "$have_version" -eq 0 ] || usage "duplicate argument: --version"
      have_version=1
      version=$2
      shift 2
      ;;
    --trust)
      [ "$mode" = build ] || usage "unknown argument: --trust"
      [ $# -ge 2 ] || usage "missing argument: --trust"
      [ -n "$2" ] || usage "missing argument: --trust"
      [ "$have_trust" -eq 0 ] || usage "duplicate argument: --trust"
      have_trust=1
      trust=$2
      shift 2
      ;;
    --root-signer)
      [ "$mode" = build ] || usage "unknown argument: --root-signer"
      [ $# -ge 2 ] || usage "missing argument: --root-signer"
      [ -n "$2" ] || usage "missing argument: --root-signer"
      [ "$have_signer" -eq 0 ] || usage "duplicate argument: --root-signer"
      have_signer=1
      signer=$2
      shift 2
      ;;
    --out)
      [ "$mode" = build ] || usage "unknown argument: --out"
      [ $# -ge 2 ] || usage "missing argument: --out"
      [ -n "$2" ] || usage "missing argument: --out"
      [ "$have_out" -eq 0 ] || usage "duplicate argument: --out"
      have_out=1
      out=$2
      shift 2
      ;;
    --repo)
      [ $# -ge 2 ] || usage "missing argument: --repo"
      [ -n "$2" ] || usage "missing argument: --repo"
      [ -z "$repo" ] || usage "duplicate argument: --repo"
      repo=$2
      shift 2
      ;;
    *)
      usage "unknown argument: $1"
      ;;
  esac
done

if [ "$mode" = build ]; then
  [ "$have_version" -eq 1 ] || usage "missing argument: --version"
  [ "$have_trust" -eq 1 ] || usage "missing argument: --trust"
  [ "$have_signer" -eq 1 ] || usage "missing argument: --root-signer"
  [ "$have_out" -eq 1 ] || usage "missing argument: --out"
fi

if [ -z "$repo" ]; then
  repo=$base
  while [ "$repo" != "/" ] && [ ! -e "$repo/.git" ]; do
    repo=$(dirname -- "$repo")
  done
  [ -e "$repo/.git" ] || fail "cannot find the repository the script lives in"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

phys() {
  (CDPATH= cd -- "$1" && pwd -P)
}

if [ "$mode" = build ]; then
  if ! printf '%s\n' "$version" | awk 'NR == 1 && $0 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/ { good = 1 } NR > 1 { good = 0 } END { exit good ? 0 : 1 }'; then
    fail "version is not x.y.z"
  fi

  if [ ! -d "$trust" ] || [ -L "$trust" ]; then
    fail "--trust is not a directory"
  fi
  ls -A "$trust" > "$work/trust-names"
  for name in keys.json keys.json.sig release_allowed_signers feed_allowed_signers; do
    if ! grep -q -x -F "$name" "$work/trust-names"; then
      fail "--trust is missing $name"
    fi
    f=$trust/$name
    if [ -L "$f" ] || [ ! -f "$f" ]; then
      fail "--trust $name is not a regular file"
    fi
    if [ ! -s "$f" ]; then
      fail "--trust $name is empty"
    fi
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case $name in
      keys.json|keys.json.sig|release_allowed_signers|feed_allowed_signers) ;;
      *) fail "--trust has an extra file $name" ;;
    esac
  done < "$work/trust-names"
  # The bench is public: nothing private may travel into it, whichever file it hides in.
  for f in "$trust"/* "$signer"; do
    if [ -f "$f" ] && grep -q 'PRIVATE KEY' "$f"; then
      fail "private key material in ${f##*/}: the bench takes public files only"
    fi
  done

  if ! line=$(awk 'NR == 1 { line = $0 } NR > 1 { bad = 1 } END { if (bad || NR != 1) exit 1; printf "%s", line }' "$signer"); then
    fail "the root signer file must hold exactly one line"
  fi
  if ! printf '%s\n' "$line" | grep -q -E -x 'root@morndo\.github\.io namespaces="keys@morndo\.github\.io" ssh-ed25519 [A-Za-z0-9+/=]+'; then
    fail "the root signer line is not the pinned root form"
  fi

  out_parent=$(dirname -- "$out")
  out_base=$(basename -- "$out")
  if [ ! -d "$out_parent" ]; then
    fail "--out is not an empty directory"
  fi
  parent_phys=$(phys "$out_parent")
  out_phys=$parent_phys/$out_base
  top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || fail "the source is not a git work tree"
  top=$(phys "$top")
  case $out_phys in
    "$top"|"$top"/*) fail "--out lies inside the source repository" ;;
  esac
  if [ -e "$out" ]; then
    if [ -d "$out" ] && [ ! -L "$out" ]; then
      real=$(phys "$out")
      case $real in
        "$top"|"$top"/*) fail "--out lies inside the source repository" ;;
      esac
      if [ -n "$(ls -A "$out")" ]; then
        fail "--out is not an empty directory"
      fi
    else
      fail "--out is not an empty directory"
    fi
  fi
fi

sha=$(git -C "$repo" rev-parse --verify "${commit}^{commit}" 2>/dev/null) || fail "commit does not resolve"

git -C "$repo" archive --format=tar -o "$work/src.tar" "$sha"
mkdir "$work/src"
tar -C "$work/src" -xf "$work/src.tar"
src=$work/src

if [ "$mode" = build ]; then
  for name in keys.json keys.json.sig release_allowed_signers feed_allowed_signers; do
    srcf=$src/trust/$name
    if [ ! -f "$srcf" ] || [ -L "$srcf" ] || [ ! -s "$srcf" ]; then
      fail "source trust is missing $name"
    fi
    if cmp -s "$srcf" "$trust/$name"; then
      fail "trust/$name is identical to the source"
    fi
  done

  yml=$src/.github/workflows/release.yml
  [ -f "$yml" ] || fail "release.yml: the release-please marker must occur exactly once"
  n=$(grep -c -x -F "  release-please:" "$yml" || true)
  [ -n "$n" ] || n=0
  [ "$n" -eq 1 ] || fail "release.yml: the release-please marker must occur exactly once"
  n=$(grep -c -x -F "  build:" "$yml" || true)
  [ -n "$n" ] || n=0
  [ "$n" -eq 1 ] || fail "release.yml: the build marker must occur exactly once"
  n=$(grep -c -E '^  ROOT_ALLOWED_SIGNER: ' "$yml" || true)
  [ -n "$n" ] || n=0
  [ "$n" -eq 1 ] || fail "release.yml: the ROOT_ALLOWED_SIGNER line must occur exactly once"
  rp=$(grep -n -x -F "  release-please:" "$yml")
  bd=$(grep -n -x -F "  build:" "$yml")
  rp_n=${rp%%:*}
  bd_n=${bd%%:*}
  if [ "$rp_n" -ge "$bd_n" ]; then
    fail "release.yml: the release-please marker must occur exactly once"
  fi

  old=$(awk '
    BEGIN { q = sprintf("%c", 39) }
    {
      prefix = "  ROOT_ALLOWED_SIGNER: " q
      suffix = q " #gitleaks:allow"
      if (index($0, prefix) != 1) next
      rest = substr($0, length(prefix) + 1)
      if (length(rest) >= length(suffix) && substr(rest, length(rest) - length(suffix) + 1) == suffix)
        print substr(rest, 1, length(rest) - length(suffix))
    }
  ' "$yml")
  [ -n "$old" ] || fail "release.yml: the root signer line cannot be read"
  if [ "$old" = "$line" ]; then
    fail "the root signer is the source's own"
  fi

  for name in feed.yml withdraw.yml promote.yml; do
    if [ ! -f "$src/.github/workflows/$name" ]; then
      fail "$name is missing: the candidate is not ready for a rehearsal"
    fi
  done

  feed=$src/scripts/release/feed.ts
  age=$src/scripts/release/check-signing-feed.sh
  [ -f "$feed" ] || fail "scripts/release/feed.ts: the promotion wait line must occur exactly once"
  n=$(grep -c -x -F "export const PROMOTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;" "$feed" || true)
  [ -n "$n" ] || n=0
  [ "$n" -eq 1 ] || fail "scripts/release/feed.ts: the promotion wait line must occur exactly once"
  [ -f "$age" ] || fail "scripts/release/check-signing-feed.sh: the promotion wait line must occur exactly once"
  n=$(grep -c -x -F 'PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-604800}' "$age" || true)
  [ -n "$n" ] || n=0
  [ "$n" -eq 1 ] || fail "scripts/release/check-signing-feed.sh: the promotion wait line must occur exactly once"

  min=$(sed -n 's/^  KEY_SET_MIN_VERSION: "\([0-9][0-9]*\)"$/\1/p' "$yml")
  min_n=$(printf '%s\n' "$min" | grep -c . || true)
  [ -n "$min_n" ] || min_n=0
  [ "$min_n" -eq 1 ] || fail "release.yml: KEY_SET_MIN_VERSION must occur exactly once"

  checker=$src/scripts/release/check-key-set.sh
  [ -f "$checker" ] || fail "the trust set was refused: source has no check-key-set.sh"
  if ! sh "$checker" "$signer" "$trust" "$min" >"$work/ck.out" 2>"$work/ck.err"; then
    detail=$(awk 'NR == 1 { printf "%s", $0 }' "$work/ck.err")
    fail "the trust set was refused: $detail"
  fi

  mkdir "$work/dst"
  tar -C "$work/dst" -xf "$work/src.tar"
  dst=$work/dst

  for name in keys.json keys.json.sig release_allowed_signers feed_allowed_signers; do
    cp "$trust/$name" "$dst/trust/$name"
  done

  sed "s/__VERSION__/$version/g" "$standin_src" > "$work/standin.yml"
  if grep -q '__VERSION__' "$work/standin.yml"; then
    fail "the stand-in still has a version placeholder"
  fi
  STANDIN=$work/standin.yml awk '
    BEGIN { standin = ENVIRON["STANDIN"] }
    $0 == "  release-please:" {
      while ((getline line < standin) > 0) print line
      close(standin)
      skip = 1
      next
    }
    $0 == "  build:" { skip = 0 }
    skip { next }
    { print }
  ' "$dst/.github/workflows/release.yml" > "$work/release.yml"
  SIGNER="$line" awk '
    BEGIN {
      signer = ENVIRON["SIGNER"]
      q = sprintf("%c", 39)
    }
    /^  ROOT_ALLOWED_SIGNER: / {
      print "  ROOT_ALLOWED_SIGNER: " q signer q " #gitleaks:allow"
      next
    }
    { print }
  ' "$work/release.yml" > "$dst/.github/workflows/release.yml"

  awk '
    $0 == "export const PROMOTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;" {
      print "export const PROMOTION_WAIT_MS = 20 * 60 * 1000;"
      next
    }
    { print }
  ' "$dst/scripts/release/feed.ts" > "$work/feed.ts"
  mv "$work/feed.ts" "$dst/scripts/release/feed.ts"
  awk '
    $0 == "PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-604800}" {
      print "PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-1200}"
      next
    }
    { print }
  ' "$dst/scripts/release/check-signing-feed.sh" > "$work/age.sh"
  mv "$work/age.sh" "$dst/scripts/release/check-signing-feed.sh"

  wf=$dst/.github/workflows
  for f in "$wf"/*; do
    [ -e "$f" ] || continue
    name=$(basename -- "$f")
    case $name in
      release.yml|feed.yml|withdraw.yml|promote.yml) ;;
      *) rm -f "$f" ;;
    esac
  done

  while IFS= read -r path || [ -n "$path" ]; do
    [ -n "$path" ] || continue
    if [ -f "$dst/$path" ] && [ ! -L "$dst/$path" ]; then
      rm -f "$dst/$path"
    fi
  done < "$removed_list"

  cat > "$dst/BENCH.md" <<EOF
This repository is a test bench and not a product.
Source commit: $sha
Version: $version
The four trust files are replaced with a bench key set signed by the given root.
The release-please job is replaced by a stand-in that cuts this version.
The pinned root signer is replaced with the bench root signer.
Workflows other than release, feed, withdraw and promote are removed.
The promotion wait is 20 minutes in the feed and in the signing check.
Tests named for removal are removed.
The 14-day Feed lifetime is unchanged.
EOF
else
  if [ ! -d "$out" ] || [ -L "$out" ]; then
    fail "--out is not a directory"
  fi
  dst=$out
fi

is_changed_ok() {
  case $1 in
    trust/keys.json|trust/keys.json.sig|trust/release_allowed_signers|trust/feed_allowed_signers|.github/workflows/release.yml|scripts/release/feed.ts|scripts/release/check-signing-feed.sh)
      return 0 ;;
  esac
  return 1
}

is_removed_ok() {
  case $1 in
    .github/workflows/release.yml|.github/workflows/feed.yml|.github/workflows/withdraw.yml|.github/workflows/promote.yml)
      return 1 ;;
    .github/workflows/*)
      return 0 ;;
  esac
  if grep -q -x -F "$1" "$removed_list"; then
    return 0
  fi
  return 1
}

: > "$work/changed"
: > "$work/removed"
: > "$work/added"
: > "$work/bad"
st=0
diff -rq "$src" "$dst" > "$work/rq" || st=$?
if [ "$st" -ne 0 ] && [ "$st" -ne 1 ]; then
  fail "cannot compare the trees"
fi

files_prefix="Files $src/"
files_and=" and $dst/"
only_src="Only in $src: "
only_src_sub="Only in $src/"
only_dst="Only in $dst: "
only_dst_sub="Only in $dst/"
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  kind=
  path=
  case $line in
    "$files_prefix"*)
      rest=${line#"$files_prefix"}
      path=${rest%%"$files_and"*}
      kind=changed
      ;;
    "$only_src"*)
      path=${line#"$only_src"}
      kind=removed
      ;;
    "$only_src_sub"*)
      rest=${line#"$only_src_sub"}
      dir=${rest%%: *}
      path=$dir/${rest#*: }
      kind=removed
      ;;
    "$only_dst"*)
      path=${line#"$only_dst"}
      kind=added
      ;;
    "$only_dst_sub"*)
      rest=${line#"$only_dst_sub"}
      dir=${rest%%: *}
      path=$dir/${rest#*: }
      kind=added
      ;;
    *)
      kind=bad
      path=$line
      ;;
  esac
  case $kind in
    changed)
      if is_changed_ok "$path"; then
        printf '%s\n' "$path" >> "$work/changed"
      else
        printf '%s\n' "$path" >> "$work/bad"
      fi
      ;;
    removed)
      if is_removed_ok "$path"; then
        printf '%s\n' "$path" >> "$work/removed"
      else
        printf '%s\n' "$path" >> "$work/bad"
      fi
      ;;
    added)
      if [ "$path" = "BENCH.md" ]; then
        printf '%s\n' "$path" >> "$work/added"
      else
        printf '%s\n' "$path" >> "$work/bad"
      fi
      ;;
    *)
      printf '%s\n' "$path" >> "$work/bad"
      ;;
  esac
done < "$work/rq"

differ() {
  printf '%s\n' "bench-overlay: $1 differs from the source outside the overlay" >&2
  diff -u "$2" "$3" >&2 || true
  exit 1
}

norm_swap() {
  FROM="$2" TO="$3" awk '
    BEGIN { from = ENVIRON["FROM"]; to = ENVIRON["TO"] }
    $0 == from { print to; next }
    { print }
  ' "$1" > "$4"
}

root_form_ok() {
  printf '%s\n' "$1" | awk '
    BEGIN { q = sprintf("%c", 39) }
    NR == 1 { line = $0 }
    END {
      if (NR != 1) exit 1
      pre = "  ROOT_ALLOWED_SIGNER: " q "root@morndo.github.io namespaces=\"keys@morndo.github.io\" ssh-ed25519 "
      suf = q " #gitleaks:allow"
      if (index(line, pre) != 1) exit 1
      rest = substr(line, length(pre) + 1)
      if (length(rest) <= length(suf)) exit 1
      if (substr(rest, length(rest) - length(suf) + 1) != suf) exit 1
      body = substr(rest, 1, length(rest) - length(suf))
      if (body !~ /^[A-Za-z0-9+\/=]+$/) exit 1
      exit 0
    }
  '
}

audit_swapped() {
  path=$1
  src_line=$2
  dst_line=$3
  if [ ! -f "$src/$path" ] || [ -L "$src/$path" ] || [ ! -f "$dst/$path" ] || [ -L "$dst/$path" ]; then
    return 0
  fi
  src_n=$(grep -c -x -F "$src_line" "$src/$path" || true)
  [ -n "$src_n" ] || src_n=0
  dst_n=$(grep -c -x -F "$dst_line" "$dst/$path" || true)
  [ -n "$dst_n" ] || dst_n=0
  norm_swap "$src/$path" "$src_line" '@@WAIT@@' "$work/norm-src"
  norm_swap "$dst/$path" "$dst_line" '@@WAIT@@' "$work/norm-dst"
  if [ "$src_n" -ne 1 ] || [ "$dst_n" -ne 1 ] || ! cmp -s "$work/norm-src" "$work/norm-dst"; then
    differ "$path" "$work/norm-src" "$work/norm-dst"
  fi
}

audit_release() {
  path=.github/workflows/release.yml
  srcf=$src/$path
  dstf=$dst/$path
  if [ ! -f "$srcf" ] || [ -L "$srcf" ] || [ ! -f "$dstf" ] || [ -L "$dstf" ]; then
    return 0
  fi
  standin_first=$(awk 'NR == 1 { print; exit }' "$standin_src")
  START="$standin_first" awk '
    BEGIN { start = ENVIRON["START"] }
    $0 == start { p = 1 }
    $0 == "  build:" { if (p) { p = 0; next } }
    p { print }
  ' "$dstf" > "$work/dst-block"
  # stand-in comparison: the tree block must match the data file, version for version
  standin_ok=0
  if STANDIN="$standin_src" BLOCK="$work/dst-block" awk '
    BEGIN {
      standin = ENVIRON["STANDIN"]
      block = ENVIRON["BLOCK"]
      i = 0
      while ((getline line < standin) > 0) {
        i++
        s[i] = line
      }
      close(standin)
      j = 0
      while ((getline line < block) > 0) {
        j++
        while (match(line, /[0-9]+\.[0-9]+\.[0-9]+/)) {
          line = substr(line, 1, RSTART - 1) "__VERSION__" substr(line, RSTART + RLENGTH)
        }
        if (j > i || line != s[j]) exit 1
      }
      if (j != i) exit 1
      exit 0
    }
  '; then
    standin_ok=1
  fi
  awk '
    $0 == "  release-please:" && !done { print "@@STANDIN@@"; skip = 1; done = 1; next }
    $0 == "  build:" { skip = 0 }
    skip { next }
    { print }
  ' "$srcf" > "$work/norm-src-pre"
  if [ "$standin_ok" -eq 1 ]; then
    START="$standin_first" awk '
      BEGIN { start = ENVIRON["START"] }
      $0 == start && !done { print "@@STANDIN@@"; skip = 1; done = 1; next }
      $0 == "  build:" { skip = 0 }
      skip { next }
      { print }
    ' "$dstf" > "$work/norm-dst-pre"
  else
    cp "$dstf" "$work/norm-dst-pre"
  fi
  src_root_n=$(grep -c -E '^  ROOT_ALLOWED_SIGNER: ' "$srcf" || true)
  [ -n "$src_root_n" ] || src_root_n=0
  dst_root_n=$(grep -c -E '^  ROOT_ALLOWED_SIGNER: ' "$dstf" || true)
  [ -n "$dst_root_n" ] || dst_root_n=0
  src_root=$(awk '/^  ROOT_ALLOWED_SIGNER: / { print; exit }' "$srcf")
  dst_root=$(awk '/^  ROOT_ALLOWED_SIGNER: / { print; exit }' "$dstf")
  # root line form, and it must not be the source line
  accept_root=0
  if [ "$dst_root_n" -eq 1 ] && [ "$src_root_n" -eq 1 ] && [ "$dst_root" != "$src_root" ] && root_form_ok "$dst_root"; then
    accept_root=1
  fi
  if [ "$src_root_n" -eq 1 ]; then
    awk '
      /^  ROOT_ALLOWED_SIGNER: / && !done { print "@@ROOT@@"; done = 1; next }
      { print }
    ' "$work/norm-src-pre" > "$work/norm-src"
  else
    cp "$work/norm-src-pre" "$work/norm-src"
  fi
  if [ "$accept_root" -eq 1 ]; then
    awk '
      /^  ROOT_ALLOWED_SIGNER: / && !done { print "@@ROOT@@"; done = 1; next }
      { print }
    ' "$work/norm-dst-pre" > "$work/norm-dst"
  else
    cp "$work/norm-dst-pre" "$work/norm-dst"
  fi
  if [ "$standin_ok" -ne 1 ] || [ "$accept_root" -ne 1 ] || ! cmp -s "$work/norm-src" "$work/norm-dst"; then
    differ "$path" "$work/norm-src" "$work/norm-dst"
  fi
}

# private key scan: a file may not gain PRIVATE KEY lines over the source
: > "$work/privbad"
if grep -rl 'PRIVATE KEY' "$dst" > "$work/privlist"; then
  while IFS= read -r abs || [ -n "$abs" ]; do
    [ -n "$abs" ] || continue
    rel=${abs#"$dst/"}
    dst_n=$(grep -c 'PRIVATE KEY' "$abs" || true)
    [ -n "$dst_n" ] || dst_n=0
    src_n=0
    if [ -f "$src/$rel" ] && [ ! -L "$src/$rel" ]; then
      src_n=$(grep -c 'PRIVATE KEY' "$src/$rel" || true)
      [ -n "$src_n" ] || src_n=0
    fi
    case $rel in
      trust/keys.json|trust/keys.json.sig|trust/release_allowed_signers|trust/feed_allowed_signers)
        src_n=0
        ;;
    esac
    allowed=$src_n
    if [ "$dst_n" -gt "$allowed" ]; then
      printf '%s\n' "private key material in $rel" >> "$work/privbad"
    fi
  done < "$work/privlist"
fi

# unchanged trust files are not a diff, so compare them on purpose
: > "$work/trustbad"
for name in keys.json keys.json.sig release_allowed_signers feed_allowed_signers; do
  if [ -f "$src/trust/$name" ] && [ ! -L "$src/trust/$name" ] && [ -f "$dst/trust/$name" ] && [ ! -L "$dst/trust/$name" ] && cmp -s "$src/trust/$name" "$dst/trust/$name"; then
    printf '%s\n' "trust/$name is still the source's" >> "$work/trustbad"
  fi
done

if [ -s "$work/bad" ] || [ -s "$work/privbad" ] || [ -s "$work/trustbad" ]; then
  if [ -s "$work/bad" ]; then
    while IFS= read -r item; do
      printf '%s\n' "bench-overlay: $item is not an allowed difference" >&2
    done < "$work/bad"
  fi
  if [ -s "$work/privbad" ]; then
    while IFS= read -r item; do
      printf '%s\n' "bench-overlay: $item" >&2
    done < "$work/privbad"
  fi
  if [ -s "$work/trustbad" ]; then
    while IFS= read -r item; do
      printf '%s\n' "bench-overlay: $item" >&2
    done < "$work/trustbad"
  fi
  exit 1
fi

audit_release
audit_swapped "scripts/release/feed.ts" \
  "export const PROMOTION_WAIT_MS = 7 * 24 * 60 * 60 * 1000;" \
  "export const PROMOTION_WAIT_MS = 20 * 60 * 1000;"
audit_swapped "scripts/release/check-signing-feed.sh" \
  'PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-604800}' \
  'PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-1200}'

if [ "$mode" = build ]; then
  if [ ! -e "$out" ]; then
    mkdir "$out"
  fi
  tar -C "$dst" -cf "$work/out.tar" .
  tar -C "$out" -xf "$work/out.tar"
  dst=$out
fi

{
  if [ -s "$work/added" ]; then
    while IFS= read -r path; do printf 'added %s\n' "$path"; done < "$work/added"
  fi
  if [ -s "$work/changed" ]; then
    while IFS= read -r path; do printf 'changed %s\n' "$path"; done < "$work/changed"
  fi
  if [ -s "$work/removed" ]; then
    while IFS= read -r path; do printf 'removed %s\n' "$path"; done < "$work/removed"
  fi
} | sort

if [ -s "$work/changed" ]; then
  sort "$work/changed" | while IFS= read -r path; do
    case $path in
      .github/workflows/*|scripts/release/*) printf '%s\n' "$path" ;;
    esac
  done > "$work/diffpaths"
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    st=0
    diff -u "$src/$path" "$dst/$path" || st=$?
    if [ "$st" -ne 0 ] && [ "$st" -ne 1 ]; then
      fail "cannot diff $path"
    fi
  done < "$work/diffpaths"
fi

printf '%s\n' "bench-overlay: ok $out"
