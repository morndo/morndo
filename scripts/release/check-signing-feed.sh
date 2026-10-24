#!/bin/sh
# Run by the feed signing job before it signs: plain shell and system tools only, no node and no npm.
# Checks the two unsigned feeds in site/ against the feed branch as it stands and against the release:
# the numbers rise by one (a publish leaves stable as it was), the lists change only as they should,
# the key-set version is the shipped one, and the new entry names the published Manifest's size and digest.
# MODE is publish, resign or withdraw. A publish or a withdrawal also needs VERSION. GH may name another gh for a test.
set -eu
PATH=/usr/bin:/bin
: "${MODE:?}"
: "${REPOSITORY:?}"
GH=${GH:-/usr/bin/gh}
SITE=${SITE:-site}
TRUST=${TRUST:-trust}
MAX_AGE=${MAX_AGE:-86400}

fail() {
  echo "refusing to sign: $1" >&2
  exit 1
}

case $MODE in
  publish|withdraw) : "${VERSION:?}" ;;
  resign) ;;
  *) fail "unknown mode $MODE" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
now=$(date +%s)
[ ! -e "$SITE/latest.json.sig" ] && [ ! -e "$SITE/stable.json.sig" ] || fail "a signature already exists"

# No branch is a 404 and nothing else: any other error stops the signing, it is not a first feed.
if head=$("$GH" api "/repos/$REPOSITORY/git/ref/heads/feed" --jq .object.sha 2> "$work/head.err"); then
  :
elif grep -q 'HTTP 404' "$work/head.err"; then
  head=
else
  fail "cannot read the feed branch: $(cat "$work/head.err")"
fi
# A missing branch is a first feed only if no feed is deployed. A deleted branch with a deployed feed would
# restart the number at 1 and drop the withdrawals, so that stops here (Pages serves the last good feed).
if [ -z "$head" ] && [ "$MODE" = publish ]; then
  CURL=${CURL:-/usr/bin/curl}
  if site=$("$GH" api "/repos/$REPOSITORY/pages" --jq .html_url 2> "$work/pages.err"); then
    code=$("$CURL" -s -o "$work/deployed.json" -w '%{http_code}' "${site%/}/latest.json") || fail "cannot read the deployed feed"
    case $code in
      404) ;;
      200) fail "a feed is deployed but the feed branch is missing; restore the branch, do not start a new feed" ;;
      *) fail "the deployed feed answered HTTP $code" ;;
    esac
  elif ! grep -q 'HTTP 404' "$work/pages.err"; then
    fail "cannot read the Pages site: $(cat "$work/pages.err")"
  fi
fi

if [ "$MODE" = publish ]; then
  keys_version=$(jq -er .version "$TRUST/keys.json") || fail "no key-set version in $TRUST/keys.json"
fi

for channel in latest stable; do
  new="$SITE/$channel.json"
  [ -f "$new" ] || fail "$new is missing"
  jq -e --arg ch "$channel" '.schema == 1 and .channel == $ch and ((.expiresAt | fromdateiso8601) - (.issuedAt | fromdateiso8601) == 1209600)' "$new" > /dev/null || fail "$channel.json is not a 14-day $channel feed"
  # Only a feed written now is fresh. A publish carries stable.json over as it was, hours or days old.
  if [ "$MODE" = resign ] || [ "$MODE" = withdraw ] || [ "$channel" = latest ] || [ -z "$head" ]; then
    issued=$(jq -r '.issuedAt | fromdateiso8601' "$new")
    delta=$((issued - now))
    # The feed environment may hold the job for an approval, so a feed prepared up to MAX_AGE ago (a day) is fresh.
    # One dated ahead of this machine by more than an hour is not.
    [ "$delta" -le 3600 ] && [ "$delta" -ge $((0 - MAX_AGE)) ] || fail "$channel.json was issued ${delta}s from now"
  fi
  jq -e '(.seq | type == "number" and . == floor and . >= 1) and (.keySetVersion | type == "number" and . == floor and . >= 1)' "$new" > /dev/null || fail "$channel.json: seq and keySetVersion must be whole numbers of at least 1"
  seq=$(jq -r .seq "$new")
  prev="$work/$channel.prev"
  if [ -n "$head" ]; then
    "$GH" api -H 'Accept: application/vnd.github.raw+json' "/repos/$REPOSITORY/contents/$channel.json?ref=$head" > "$prev" || fail "cannot read $channel.json at $head"
    jq -e '(.seq | type == "number" and . == floor and . >= 1)' "$prev" > /dev/null || fail "the deployed $channel.json has no whole-number seq"
    pseq=$(jq -r .seq "$prev")
    if [ "$MODE" = publish ] && [ "$channel" = stable ]; then
      cmp -s "$prev" "$new" || fail "a publish changed stable.json"
      # Carried over as it was, but not past its expiry: signing it again would hand out a dead feed.
      jq -e --argjson now "$now" '(.expiresAt | fromdateiso8601) > $now' "$new" > /dev/null || fail "the carried-over stable.json has expired; re-sign the feeds first"
    else
      [ "$seq" = $((pseq + 1)) ] || fail "$channel.json is number $seq, expected $((pseq + 1))"
    fi
    if [ "$MODE" = publish ]; then
      [ "$(jq -r .keySetVersion "$new")" = "$keys_version" ] || fail "$channel.json names another key set than $TRUST/keys.json"
    elif [ "$MODE" = withdraw ]; then
      [ "$(jq -r .keySetVersion "$new")" = "$(jq -r .keySetVersion "$prev")" ] || fail "$channel.json changed the key set"
    else
      [ "$(jq -r .keySetVersion "$new")" = "$(jq -r .keySetVersion "$prev")" ] || fail "a re-sign changed the key set"
    fi
  else
    if [ "$MODE" = withdraw ]; then
      fail "a withdrawal needs a feed branch"
    fi
    [ "$MODE" = publish ] || fail "a re-sign needs a feed branch"
    [ "$seq" = 1 ] || fail "$channel.json starts at $seq, not 1"
    [ "$(jq -r .keySetVersion "$new")" = "$keys_version" ] || fail "$channel.json names another key set than $TRUST/keys.json"
    printf 'null' > "$prev"
  fi
  if [ "$MODE" = withdraw ]; then
    jq -e --slurpfile p "$prev" '.releases == ($p[0].releases // [])' "$new" > /dev/null || fail "$channel.json changed a release"
    jq -e --slurpfile p "$prev" --arg v "$VERSION" '($p[0].withdrawn // [] | index($v)) == null' "$new" > /dev/null || fail "$VERSION is already withdrawn in the $channel feed"
    jq -e --slurpfile p "$prev" --arg v "$VERSION" '.withdrawn == (($p[0].withdrawn // []) + [$v])' "$new" > /dev/null || fail "$channel.json withdrawn list is not the previous list plus the version"
    if [ "$channel" = latest ]; then
      jq -e --slurpfile p "$prev" --arg v "$VERSION" '($p[0].releases // [] | map(.version) | index($v)) != null' "$new" > /dev/null || fail "the latest feed does not list $VERSION"
    fi
  elif [ "$MODE" = resign ] || [ "$channel" = latest ]; then
    # Entries that were already published are carried over whole (version, URL, size, digest), not by version.
    jq -e --slurpfile p "$prev" --arg v "${VERSION:-}" --arg mode "$MODE" '
      ($p[0].releases // []) as $old
      | (if $mode == "publish"
          then (($old | map(.version) | index($v)) == null)
            and ([.releases[] | select(.version == $v)] | length == 1)
            and ((.releases | map(select(.version != $v)) | sort_by(.version)) == ($old | sort_by(.version)))
          else (.releases == $old) end)
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
