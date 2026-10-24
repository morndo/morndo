#!/bin/sh
# Run by the feed signing job before it signs: plain shell and system tools only, no node and no npm.
# Checks the two unsigned feeds in site/ against the feed branch as it stands and against the release:
# the numbers rise by one (a publish leaves stable as it was), the lists change only as they should,
# the key-set version is the shipped one, and the new entry names the published Manifest's size and digest.
# MODE is publish, resign, withdraw or promote. A publish, a withdrawal or a promotion needs VERSION.
# A withdrawal reads ALLOW_EMPTY_CHANNEL (true or false, default false) and refuses to sign when a channel
# offered something before and offers nothing afterwards, unless that value is true.
# GH may name another gh for a test.
set -eu
PATH=/usr/bin:/bin
: "${MODE:?}"
: "${REPOSITORY:?}"
GH=${GH:-/usr/bin/gh}
SITE=${SITE:-site}
TRUST=${TRUST:-trust}
MAX_AGE=${MAX_AGE:-86400}
PROMOTE_MIN_AGE=${PROMOTE_MIN_AGE:-604800}

fail() {
  echo "refusing to sign: $1" >&2
  exit 1
}

case $MODE in
  publish|withdraw|promote) : "${VERSION:?}" ;;
  resign) ;;
  *) fail "unknown mode $MODE" ;;
esac

if [ "$MODE" = withdraw ]; then
  ALLOW_EMPTY_CHANNEL=${ALLOW_EMPTY_CHANNEL:-false}
  case "$ALLOW_EMPTY_CHANNEL" in
    true|false) ;;
    *) fail "ALLOW_EMPTY_CHANNEL must be true or false" ;;
  esac
fi

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
  if [ "$MODE" = resign ] || [ "$MODE" = withdraw ] || [ "$MODE" = promote ] || [ "$channel" = latest ] || [ -z "$head" ]; then
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
    elif [ "$MODE" = withdraw ] || [ "$MODE" = promote ]; then
      [ "$(jq -r .keySetVersion "$new")" = "$(jq -r .keySetVersion "$prev")" ] || fail "$channel.json changed the key set"
    else
      [ "$(jq -r .keySetVersion "$new")" = "$(jq -r .keySetVersion "$prev")" ] || fail "a re-sign changed the key set"
    fi
  else
    if [ "$MODE" = withdraw ]; then
      fail "a withdrawal needs a feed branch"
    fi
    if [ "$MODE" = promote ]; then
      fail "a promotion needs a feed branch"
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
    if [ "$ALLOW_EMPTY_CHANNEL" != true ]; then
      before=$(jq -r '(.releases // [] | map(.version)) - (.withdrawn // []) | length' "$prev")
      after=$(jq -r '(.releases // [] | map(.version)) - (.withdrawn // []) | length' "$new")
      [ "$before" -eq 0 ] || [ "$after" -gt 0 ] || fail "withdrawing $VERSION would leave the $channel feed offering nothing; set allow_empty_channel to true to do it"
    fi
  elif [ "$MODE" = promote ]; then
    if [ "$channel" = latest ]; then
      jq -e --slurpfile p "$prev" '.releases == $p[0].releases and .withdrawn == $p[0].withdrawn' "$new" > /dev/null || fail "latest.json changed a list a promotion keeps"
    else
      jq -e --slurpfile p "$prev" --arg v "$VERSION" '($p[0].releases | map(.version) | index($v)) == null' "$new" > /dev/null || fail "$VERSION is already in the stable feed"
      jq -e --slurpfile latest "$work/latest.prev" --slurpfile stable "$prev" --arg v "$VERSION" '($latest[0].withdrawn | index($v)) == null and ($stable[0].withdrawn | index($v)) == null' "$new" > /dev/null || fail "$VERSION is withdrawn"
      jq -e --slurpfile latest "$work/latest.prev" --arg v "$VERSION" '($latest[0].releases | map(.version) | index($v)) != null' "$new" > /dev/null || fail "a Version latest never had"
      jq -e --slurpfile p "$prev" '.withdrawn == $p[0].withdrawn' "$new" > /dev/null || fail "stable.json changed its withdrawn list"
      jq -e --slurpfile latest "$work/latest.prev" --slurpfile was "$prev" --arg v "$VERSION" '
        ($latest[0].releases | map(select(.version == $v))) as $from
        | ($from | length) == 1
          and ((.releases | map(select(.version == $v))) == $from)
          and ((.releases | map(select(.version != $v))) == $was[0].releases)' "$new" > /dev/null || fail "stable.json is not the previous releases plus the one release latest lists"
      jq -e --arg v "$VERSION" '.releases[0].version == $v' "$new" > /dev/null || fail "stable.json does not list $VERSION first: stable only moves forward"
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

if [ "$MODE" = promote ]; then
  # First parent only, the whole chain to the root. The age is the date of the OLDEST commit in graph order whose
  # latest.json lists the version and verifies under the feed key. A back-dated committer date cannot jump the
  # queue, and a replayed older feed that does not list the version cannot end the walk early: a push can append
  # such replays, so stopping at the first commit that does not list the version would take a forged tip's date.
  sha=$head
  listed=
  first=1
  tab=$(printf '\t')
  while [ -n "$sha" ]; do
    line=$("$GH" api "/repos/$REPOSITORY/git/commits/$sha" --jq '[.committer.date, (.parents[0].sha // "")] | @tsv') || fail "cannot read the feed commit $sha"
    case $line in
      *"$tab"*) ;;
      *) fail "cannot read the feed commit $sha" ;;
    esac
    when=${line%%"$tab"*}
    parent=${line#*"$tab"}
    lists=0
    if "$GH" api -H 'Accept: application/vnd.github.raw+json' "/repos/$REPOSITORY/contents/latest.json?ref=$sha" > "$work/at.json" 2> "$work/at.err"; then
      if jq -e --arg v "$VERSION" '(.releases | map(.version) | index($v)) != null' "$work/at.json" > /dev/null 2>&1; then lists=1; fi
    elif ! grep -q 'HTTP 404' "$work/at.err"; then
      fail "cannot read latest.json at $sha"
    fi
    if [ "$lists" = 1 ]; then
      "$GH" api -H 'Accept: application/vnd.github.raw+json' "/repos/$REPOSITORY/contents/latest.json.sig?ref=$sha" > "$work/at.sig" 2> "$work/sig.err" || fail "cannot read latest.json.sig at $sha"
      /usr/bin/ssh-keygen -Y verify -f "$TRUST/feed_allowed_signers" -I feed@morndo.github.io -n feed@morndo.github.io -s "$work/at.sig" < "$work/at.json" > /dev/null 2>&1 ||
        fail "the feed branch commit $sha lists $VERSION in a latest.json that is not signed by the feed key"
      listed=$when
    elif [ "$first" = 1 ]; then
      break
    fi
    first=0
    sha=$parent
  done
  [ -n "$listed" ] || fail "cannot tell when $VERSION was first listed on latest"
  listed_s=$(date -d "$listed" +%s) || fail "cannot read when $VERSION was first listed"
  [ $((now - listed_s)) -ge "$PROMOTE_MIN_AGE" ] || fail "$VERSION has been on latest for too short a time (since $listed, when the feed commit first listed it); promotion needs 7 days"
fi
echo "checked: $MODE feeds follow the branch and the release"
