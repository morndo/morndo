#!/bin/sh
# Run by the feed signing job before it signs: plain shell and system tools only, no node and no npm.
# Checks the two unsigned feeds in site/ against the feed branch as it stands and against the release:
# the numbers rise by one (a publish leaves stable as it was), the lists change only as they should,
# the key-set version is the shipped one, and the new entry names the published Manifest's size and digest.
# MODE is publish or resign. A publish also needs VERSION. GH may name another gh for a test.
set -eu
PATH=/usr/bin:/bin
: "${MODE:?}"
: "${REPOSITORY:?}"
GH=${GH:-/usr/bin/gh}
SITE=${SITE:-site}
TRUST=${TRUST:-trust}

fail() {
  echo "refusing to sign: $1" >&2
  exit 1
}

case $MODE in
  publish) : "${VERSION:?}" ;;
  resign) ;;
  *) fail "unknown mode $MODE" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
now=$(date +%s)
[ ! -e "$SITE/latest.json.sig" ] && [ ! -e "$SITE/stable.json.sig" ] || fail "a signature already exists"

head=$("$GH" api "/repos/$REPOSITORY/git/ref/heads/feed" --jq .object.sha 2>/dev/null) || head=
if [ "$MODE" = publish ]; then
  keys_version=$(jq -er .version "$TRUST/keys.json") || fail "no key-set version in $TRUST/keys.json"
fi

for channel in latest stable; do
  new="$SITE/$channel.json"
  [ -f "$new" ] || fail "$new is missing"
  jq -e --arg ch "$channel" '.schema == 1 and .channel == $ch and ((.expiresAt | fromdateiso8601) - (.issuedAt | fromdateiso8601) == 1209600)' "$new" > /dev/null || fail "$channel.json is not a 14-day $channel feed"
  issued=$(jq -r '.issuedAt | fromdateiso8601' "$new")
  delta=$((issued - now))
  [ "$delta" -le 3600 ] && [ "$delta" -ge -3600 ] || fail "$channel.json was issued ${delta}s from now"
  seq=$(jq -r .seq "$new")
  prev="$work/$channel.prev"
  if [ -n "$head" ]; then
    "$GH" api -H 'Accept: application/vnd.github.raw+json' "/repos/$REPOSITORY/contents/$channel.json?ref=$head" > "$prev" || fail "cannot read $channel.json at $head"
    pseq=$(jq -r .seq "$prev")
    if [ "$MODE" = publish ] && [ "$channel" = stable ]; then
      cmp -s "$prev" "$new" || fail "a publish changed stable.json"
    else
      [ "$seq" = $((pseq + 1)) ] || fail "$channel.json is number $seq, expected $((pseq + 1))"
    fi
    if [ "$MODE" = publish ]; then
      [ "$(jq -r .keySetVersion "$new")" = "$keys_version" ] || fail "$channel.json names another key set than $TRUST/keys.json"
    else
      [ "$(jq -r .keySetVersion "$new")" = "$(jq -r .keySetVersion "$prev")" ] || fail "a re-sign changed the key set"
    fi
  else
    [ "$MODE" = publish ] || fail "a re-sign needs a feed branch"
    [ "$seq" = 1 ] || fail "$channel.json starts at $seq, not 1"
    [ "$(jq -r .keySetVersion "$new")" = "$keys_version" ] || fail "$channel.json names another key set than $TRUST/keys.json"
    printf 'null' > "$prev"
  fi
  if [ "$MODE" = resign ] || [ "$channel" = latest ]; then
    jq -e --slurpfile p "$prev" --arg v "${VERSION:-}" --arg mode "$MODE" '
      ($p[0].releases // []) as $old
      | (if $mode == "publish" then (([.releases[].version] | sort) == ((($old | map(.version)) + [$v]) | sort)) else (.releases == $old) end)
        and (.withdrawn == ($p[0].withdrawn // []))' "$new" > /dev/null || fail "$channel.json changes more than the release list should"
  fi
done

if [ "$MODE" = publish ]; then
  jq -e '.releases == [] and .withdrawn == []' "$SITE/stable.json" > /dev/null || [ -n "$head" ] || fail "a first stable feed must be empty"
  "$GH" release download "v$VERSION" --repo "$REPOSITORY" --pattern manifest.json --dir "$work" || fail "cannot download the manifest of v$VERSION"
  entry=$(jq -c --arg v "$VERSION" '.releases[] | select(.version == $v)' "$SITE/latest.json")
  [ -n "$entry" ] || fail "latest.json has no entry for $VERSION"
  [ "$(printf '%s' "$entry" | jq -r .manifest)" = "https://github.com/$REPOSITORY/releases/download/v$VERSION/manifest.json" ] || fail "the entry names another manifest URL"
  [ "$(printf '%s' "$entry" | jq -r .manifestSize)" = "$(wc -c < "$work/manifest.json" | tr -d ' ')" ] || fail "the entry's manifest size is not the published one"
  [ "$(printf '%s' "$entry" | jq -r .manifestSha256)" = "$(sha256sum "$work/manifest.json" | cut -d' ' -f1)" ] || fail "the entry's manifest digest is not the published one"
fi
echo "checked: $MODE feeds follow the branch and the release"
