#!/bin/sh
# check-release-settings.sh [--repo <owner/name>] [--workflows <dir>] [--no-org-secrets]: proves, read-only, the
# GitHub settings a release depends on; it never changes a setting (GitHub API GETs through gh api only) and never
# prints a secret value (secret NAMES only). The environments release, feed, promote and withdraw must each have a
# required reviewer with Prevent self-review on and allow deployments from the branch main only; github-pages must
# allow main only too (it serves documents the clients verify, so it needs no reviewer); every environment the
# workflows name must already exist, because a workflow that names a missing one creates it with no reviewer and no
# branch rule; a tag ruleset must hold refs/tags/v* with only the release App (an Integration) as its bypass, so
# nobody else, administrators included, can create or move a release tag; RELEASE_SSH_KEY must be a secret of the
# environment release only and FEED_SSH_KEY of feed only; and no repository or organisation secret may look like a
# signing key, because a repository secret is readable by any workflow from any branch (the release App's own key is
# printed as KNOWN, the exposure of decision 10, until it moves into an environment limited to main). Every problem
# is one FAIL line on stdout, and the exit status is 1 when there was one; INFO and KNOWN lines never fail. The check
# runs before every release and every Monday, on a machine with an administrator token, never inside Actions (the
# Actions token cannot read environment secrets, rulesets or reviewers). gh and jq come from the caller's PATH, which
# the administrator's machine provides. Endpoints and response shapes, read 2026-10-23:
# https://docs.github.com/en/rest/deployments/environments,
# https://docs.github.com/en/rest/deployments/branch-policies,
# https://docs.github.com/en/rest/repos/rules and https://docs.github.com/en/rest/actions/secrets.
set -eu

problems=0
fail() { printf 'FAIL: %s\n' "$*"; problems=$((problems + 1)); }
info() { printf 'INFO: %s\n' "$*"; }
known() { printf 'KNOWN: %s\n' "$*"; }

usage='usage: check-release-settings.sh [--repo <owner/name>] [--workflows <dir>] [--no-org-secrets]'
repo=morndo/morndo
workflows=.github/workflows
org_secrets=1
while [ $# -gt 0 ]; do
  case $1 in
    --repo) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; repo=$2; shift 2 ;;
    --workflows) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; workflows=$2; shift 2 ;;
    --no-org-secrets) org_secrets=0; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
case $repo in
  */*) ;;
  *) echo "$usage: --repo must be <owner/name>" >&2; exit 2 ;;
esac
owner=${repo%/*}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# fetch <name> <endpoint>: the endpoint's JSON body in $tmp/<name>, or a FAIL line and status 1. A check that cannot
# read its endpoint is a failure, never a silent pass. --paginate is a no-op on the single-page detail endpoints.
fetch() {
  if gh api --paginate "$2" >"$tmp/$1" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp/$1"
  fail "cannot read $2"
  return 1
}

have_envs=0
if fetch environments "repos/$repo/environments"; then have_envs=1; fi

exists() { # exists <environment>: true when the environments list names it
  [ "$have_envs" = 1 ] && jq -e --arg n "$1" '([.environments[]? | select(.name == $n)] | length) > 0' "$tmp/environments" >/dev/null
}

# The environments release, feed, promote and withdraw hold a key or move a release, so each needs the reviewer and
# the branch main only; github-pages serves documents the clients verify, so it needs no reviewer (and is not failed
# for having one). A missing environment is reported once and nothing else is checked for it; when the list itself
# could not be read, the environments are not reported missing on top of that.
for name in release feed promote withdraw github-pages; do
  [ "$have_envs" = 1 ] || continue
  if ! exists "$name"; then
    fail "environment $name does not exist"
    continue
  fi
  if [ "$name" != "github-pages" ]; then
    reviewers=$(jq -r --arg n "$name" \
      '[.environments[] | select(.name == $n) | .protection_rules[]? | select(.type == "required_reviewers")][0].reviewers // [] | length' "$tmp/environments")
    [ "$reviewers" -gt 0 ] || fail "environment $name has no required reviewer"
    self=$(jq -r --arg n "$name" \
      '[.environments[] | select(.name == $n) | .protection_rules[]? | select(.type == "required_reviewers")][0].prevent_self_review // false' "$tmp/environments")
    [ "$self" = true ] || fail "environment $name: Prevent self-review is off"
  fi
  custom=$(jq -r --arg n "$name" \
    '[.environments[] | select(.name == $n)][0].deployment_branch_policy.custom_branch_policies // false' "$tmp/environments")
  if [ "$custom" != true ]; then
    fail "environment $name allows all protected branches; it must allow the branch main only"
  elif fetch "policy-$name" "repos/$repo/environments/$name/deployment-branch-policies"; then
    allows=$(jq -r 'if ([.branch_policies[]?] | length) == 0 then "nothing" else ([.branch_policies[] | "\(.name) (\(.type))"] | join(", ")) end' "$tmp/policy-$name")
    [ "$allows" = "main (branch)" ] || fail "environment $name allows $allows; it must allow the branch main only"
  fi
done

# Every environment a workflow names must already exist. A workflow names one with `environment: <name>` on a line,
# or `environment:` with a `name:` entry on the lines below it; a name given as a ${{ ... }} expression is skipped,
# because the check cannot know what it resolves to. A workflow file that names no environment checks nothing.
if [ "$have_envs" = 1 ]; then
  jq -r '.environments[]?.name' "$tmp/environments" >"$tmp/env-names"
  found=0
  for file in "$workflows"/*.yml; do
    [ -f "$file" ] || continue
    found=1
    awk '
      BEGIN { block = 0 }
      /^[ \t]*environment:/ {
        line = $0
        sub(/^[ \t]*environment:[ \t]*/, "", line)
        depth = match($0, /[^ \t]/)
        block = 0
        if (line == "") { block = 1; next }
        if (line !~ /\$\{\{/) print line
        next
      }
      block && $0 !~ /^[ \t]*$/ { if (match($0, /[^ \t]/) <= depth) block = 0 }
      block && /^[ \t]*name:/ {
        line = $0
        sub(/^[ \t]*name:[ \t]*/, "", line)
        block = 0
        if (line !~ /\$\{\{/) print line
      }' "$file" | sort -u >"$tmp/workflow-envs"
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      case $name in
        \"*\") name=${name#\"}; name=${name%\"} ;;
      esac
      case $name in
        \'*\') name=${name#\'}; name=${name%\'} ;;
      esac
      case $name in
        '${'*) continue ;;
      esac
      if ! grep -qxF -- "$name" "$tmp/env-names"; then
        fail "workflow ${file##*/} names environment $name, which does not exist (a workflow creates a missing environment with no reviewer and no branch rule)"
      fi
    done <"$tmp/workflow-envs"
  done
  [ "$found" = 1 ] || fail "no workflow files found in $workflows"
fi

have_rulesets=0
if fetch rulesets "repos/$repo/rulesets"; then have_rulesets=1; fi

tag_ruleset_problems() { # <ruleset file>: one line per unmet condition of the tag ruleset on v*
  jq -r '
    (if .enforcement == "active" then empty else "is not active" end),
    (if ((.conditions.ref_name.include // []) == ["refs/tags/v*"]) and (((.conditions.ref_name.exclude // []) | length) == 0)
       then empty else "does not cover exactly refs/tags/v*" end),
    (if ((.rules // []) | map(.type) | index("creation")) != null then empty else "lacks a creation rule" end),
    (if ((.rules // []) | map(.type) | index("update")) != null then empty else "lacks an update rule" end),
    (if ((.rules // []) | map(.type) | index("deletion")) != null then empty else "lacks a deletion rule" end),
    (if ((.bypass_actors // []) | length) == 1
       then (if .bypass_actors[0].actor_type == "Integration" then empty
             else "has a bypass actor that is not the release App (an Integration)" end)
       else "must have exactly one bypass actor, the release App (an Integration)" end)' "$1"
}

if [ "$have_rulesets" = 1 ]; then
  # The branch rulesets' bypass actors, printed for the owner to read: the account the lanes run as is a repository
  # administrator and bypasses the review rule (decision 9), so he decides knowing who else can.
  for id in $(jq -r '.[]? | select(.target == "branch") | .id' "$tmp/rulesets"); do
    if fetch "ruleset-$id" "repos/$repo/rulesets/$id"; then
      name=$(jq -r '.name // "?"' "$tmp/ruleset-$id")
      for actor in $(jq -r '.bypass_actors[]? | "\(.actor_type):\(.actor_id):\(.bypass_mode)"' "$tmp/ruleset-$id"); do
        info "main ruleset $name bypass: $actor"
      done
    fi
  done
  tag_ids=$(jq -r '[.[]? | select(.target == "tag") | .id] | join(" ")' "$tmp/rulesets")
  if [ -z "$tag_ids" ]; then
    fail "no tag ruleset on v*"
  else
    # One tag ruleset that meets every condition is enough, so a failing one's lines are held until no ruleset
    # passes: a passing ruleset beside a disabled one is the required state, not a problem.
    tag_ok=0
    for id in $tag_ids; do
      if fetch "ruleset-$id" "repos/$repo/rulesets/$id"; then
        tag_ruleset_problems "$tmp/ruleset-$id" >"$tmp/tag-$id.problems"
        if [ ! -s "$tmp/tag-$id.problems" ]; then
          tag_ok=1
          bypass=$(jq -r '.bypass_actors[0] | "\(.actor_type):\(.actor_id)"' "$tmp/ruleset-$id")
          info "tag ruleset bypass: $bypass (only the release App may create or move refs/tags/v*)"
        fi
      fi
    done
    if [ "$tag_ok" = 0 ]; then
      for id in $tag_ids; do
        [ -s "$tmp/tag-$id.problems" ] || continue
        name=$(jq -r '.name // "?"' "$tmp/ruleset-$id")
        while IFS= read -r line; do fail "tag ruleset '$name' $line"; done <"$tmp/tag-$id.problems"
      done
    fi
  fi
fi

# Where the keys live, by name only (never a value). The environment secrets of an environment that already failed
# the existence check are not fetched: its 404 would report the same problem twice.
have_repo_secrets=0
if fetch repo-secrets "repos/$repo/actions/secrets"; then have_repo_secrets=1; fi
for name in release feed promote withdraw github-pages; do
  if exists "$name"; then
    fetch "secrets-$name" "repos/$repo/environments/$name/secrets" || :
  fi
done

places() { # places <secret name>: where the name was found, "environment <env>" for each, then "repository"
  found=""
  for env in release feed promote withdraw github-pages; do
    if [ -f "$tmp/secrets-$env" ] && jq -e --arg k "$1" '([.secrets[]?.name] | index($k)) != null' "$tmp/secrets-$env" >/dev/null; then
      entry="environment $env"
      if [ -n "$found" ]; then found="$found, $entry"; else found="$entry"; fi
    fi
  done
  if [ -f "$tmp/repo-secrets" ] && jq -e --arg k "$1" '([.secrets[]?.name] | index($k)) != null' "$tmp/repo-secrets" >/dev/null; then
    if [ -n "$found" ]; then found="$found, repository"; else found="repository"; fi
  fi
  printf '%s' "$found"
}

check_place() { # check_place <secret> <environment>: the secret is a secret of exactly that environment
  where=$(places "$1")
  if [ "$where" != "environment $2" ]; then
    fail "$1 must be a secret of environment $2 only (found in: ${where:-nowhere})"
  fi
}
if [ "$have_envs" = 1 ]; then
  check_place RELEASE_SSH_KEY release
  check_place FEED_SSH_KEY feed
fi

signing_shaped() { # signing_shaped <secret name>: a name that looks like it holds key material
  case $(printf '%s' "$1" | tr '[:upper:]' '[:lower:]') in
    *ssh_key*|*signing*|*private_key*) return 0 ;;
  esac
  return 1
}

if [ "$have_repo_secrets" = 1 ]; then
  for name in $(jq -r '.secrets[]?.name' "$tmp/repo-secrets"); do
    if [ "$name" = RELEASE_APP_PRIVATE_KEY ]; then
      known "RELEASE_APP_PRIVATE_KEY and RELEASE_APP_ID are repository secrets (decision 10: move them to an environment limited to main)"
      continue
    fi
    if signing_shaped "$name"; then
      fail "repository secret $name looks like a signing key (a repository secret is readable by any workflow from any branch)"
    fi
  done
fi

if [ "$org_secrets" = 1 ]; then
  if gh api --paginate "orgs/$owner/actions/secrets" >"$tmp/org-secrets" 2>/dev/null; then
    for name in $(jq -r '.secrets[]?.name' "$tmp/org-secrets"); do
      if signing_shaped "$name"; then
        fail "organisation secret $name looks like a signing key (an organisation secret is readable by every workflow of $owner)"
      fi
    done
  else
    fail "cannot read organisation secrets (needs admin:org); rerun with an admin token, or with --no-org-secrets to leave them unchecked"
  fi
else
  info "NOT CHECKED: organisation secrets"
fi

if [ "$problems" -gt 0 ]; then
  printf 'check-release-settings: %d problem(s)\n' "$problems"
  exit 1
fi
echo "check-release-settings: ok ($repo: release, feed, promote and withdraw have a reviewer and allow the branch main only, github-pages allows main only, the tag ruleset holds refs/tags/v*, the signing keys are secrets of the environments that use them)"
