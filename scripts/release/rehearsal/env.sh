#!/bin/sh
# env.sh <feed-url> -- the rehearsal's feed step (docs/plans/2026-10-27-c4-resume.md, section 3), run as the
# worker inside a rehearsal machine (it refuses to run anywhere else: the host name must be under
# rehearsal.test, for this step writes the user manager's environment, and on the host that manager is the
# host's own). The updater reads its feed address only from MORNDO_UPDATE_FEED
# (apps/updater/src/cli.ts:417) and, as a systemd user unit, from the user manager's environment; without it a
# rehearsal machine would quietly read production's feed. So the address must be an https:// URL of plain
# characters (no space, quote, $, backslash or newline: it is written into files and commands as it stands) and
# must not be production's, with or without the trailing slash the updater adds, and must be https://<host>/<path>/
# in lower case, with no port, escape, empty, . or .. segment (other spellings can name production's host too),
# and must be the bench's own, https://morndo.github.io/morndo-release-test/ — no other feed is read; then it is written, with that
# slash, to ~/.config/environment.d/morndo-rehearsal.conf (the manager reads that file at login) and handed to
# the running manager with systemctl --user set-environment, and show-environment must carry the exact line, or
# the step stops: a manager that lacks the address would let the updater read production's feed. Nothing but the
# conf file is written, and a variable's value is printed only as the feed address itself. systemctl comes from
# the PATH this script is given.
set -eu
LC_ALL=C
export LC_ALL

name=rehearsal-env

fail() { # fail <message>: the message on stderr, status 1
  printf '%s: %s\n' "$name" "$*" >&2
  exit 1
}

if [ $# -ne 1 ]; then
  printf '%s: usage: env.sh <feed-url>\n' "$name" >&2
  exit 64
fi

url=$1

# A rehearsal machine only: the step below writes this user's manager environment, and on any other box that
# user is the host's own. The host name must have a label under rehearsal.test, so the bare domain and names
# that merely end in something else fail alike.
host=$(uname -n)
case $host in
  ?*.rehearsal.test) ;;
  *) fail "this is not a rehearsal machine (its host name $host is not under rehearsal.test); run it inside one" ;;
esac

case $url in
  https://*) ;;
  *) fail "the feed address must be an https:// URL" ;;
esac

case $url in
  *[!A-Za-z0-9._~:/%-]*) fail "the feed address holds a character it may not" ;;
esac

# The updater treats the address as a directory and adds the missing slash itself; compare against production
# only after doing the same, so the unslashed form is caught too.
case $url in
  */) ;;
  *) url=$url/ ;;
esac

# The updater treats the value as a URL base, so spellings other than the one below can still name production:
# an upper-case host, a :443 port, a trailing dot, percent-escapes, an empty or . or .. path segment. The shape
# check admits only https://<host>/<path>/ in lower case; anything else stops before the comparison below.
if ! printf '%s\n' "$url" | grep -Eqx 'https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(/[a-z0-9_~-][a-z0-9._~-]*)*/'; then
  fail "the feed address must be https://<host>/<path>/ in lower case, with no port, escape, empty, . or .. segment"
fi

[ "$url" != "https://morndo.github.io/morndo/" ] ||
  fail "that is production's feed; a rehearsal machine never reads it"

# The bench's Pages feed and nothing else: the rehearsal's results are only its own while the feed it reads is
# the one repository the rehearsal is allowed to touch.
[ "$url" = "https://morndo.github.io/morndo-release-test/" ] ||
  fail "the feed address must be the bench's own, https://morndo.github.io/morndo-release-test/"

conf_dir=$HOME/.config/environment.d
mkdir -p "$conf_dir"
printf 'MORNDO_UPDATE_FEED=%s\n' "$url" >"$conf_dir/morndo-rehearsal.conf"

systemctl --user set-environment "MORNDO_UPDATE_FEED=$url" ||
  fail "systemctl --user set-environment failed"

systemctl --user show-environment |
  grep -Fxq "MORNDO_UPDATE_FEED=$url" ||
  fail "the user manager does not carry MORNDO_UPDATE_FEED=$url; stop: the updater would read production's feed"

printf '%s: ok (the user manager carries MORNDO_UPDATE_FEED=%s)\n' "$name" "$url"
