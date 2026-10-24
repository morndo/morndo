#!/bin/sh
# check-release-settings.sh --reviewer-id <id> --app-id <id> [--repo <owner/name>] [--no-org-secrets]: proves,
# read-only, the GitHub settings a release depends on; it never changes a setting (GitHub API GETs through gh api
# only) and never prints a secret value (secret NAMES only). The environments release, feed, promote and withdraw
# must each have exactly one required reviewer, the second account, named by its id (--reviewer-id: a team, the
# maintainer account or a second reviewer fails), Prevent self-review on, administrator bypass off (can_admins_bypass
# false: the account the lanes run as is a repository administrator, and with the bypass on it could skip the
# reviewer), and deployments from the branch main only; github-pages must allow main only too (it serves documents the
# clients verify, so it needs no reviewer). The workflows are read from main through the API, not from a checkout, and
# every environment they name must already exist, because a workflow that names a missing one creates it with no
# reviewer and no branch rule. A tag ruleset must hold refs/tags/v* with only the release App, by its id (--app-id),
# as its bypass actor, so nobody else, administrators included, can create or move a release tag. A key secret is a
# secret a job uses in one of the four environments (a `secrets.NAME` of that job in the workflows on main, not a name
# pattern): it must be a secret of that environment and of no other, and neither a repository nor an organisation
# secret, because a repository secret is readable by any workflow from any branch. The release App's own two secrets,
# used by a job with no environment, are printed as KNOWN (the exposure of decision 10, until they move into an
# environment limited to main); any other secret such a job uses is printed as INFO. Every problem is one FAIL line on
# stdout, and the exit status is 1 when there was one, 2 for a usage error; INFO and KNOWN lines never fail. The check
# runs before every release and every Monday, on a machine with an administrator token, never inside Actions (the
# Actions token cannot read environment secrets, rulesets or reviewers). gh, jq and awk come from the caller's PATH,
# which the administrator's machine provides. Endpoints and response shapes, read 2026-10-24:
# https://docs.github.com/en/rest/deployments/environments,
# https://docs.github.com/en/rest/deployments/branch-policies,
# https://docs.github.com/en/rest/repos/rules, https://docs.github.com/en/rest/actions/secrets and
# https://docs.github.com/en/rest/repos/contents (the raw media type). can_admins_bypass is in the live response of
# the environments endpoints (read 2026-10-24) but not in the REST description.
set -eu

problems=0
fail() { printf 'FAIL: %s\n' "$*"; problems=$((problems + 1)); }
info() { printf 'INFO: %s\n' "$*"; }
known() { printf 'KNOWN: %s\n' "$*"; }

usage='usage: check-release-settings.sh --reviewer-id <id> --app-id <id> [--repo <owner/name>] [--no-org-secrets]'
repo=morndo/morndo
reviewer_id=
app_id=
org_secrets=1
number() { case $1 in ''|*[!0-9]*) return 1 ;; esac; }
while [ $# -gt 0 ]; do
  case $1 in
    --repo) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; repo=$2; shift 2 ;;
    --reviewer-id) [ $# -ge 2 ] && number "$2" || { echo "$usage" >&2; exit 2; }; reviewer_id=$2; shift 2 ;;
    --app-id) [ $# -ge 2 ] && number "$2" || { echo "$usage" >&2; exit 2; }; app_id=$2; shift 2 ;;
    --no-org-secrets) org_secrets=0; shift ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
[ -n "$reviewer_id" ] && [ -n "$app_id" ] || { echo "$usage" >&2; exit 2; }
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

# The environments release, feed, promote and withdraw hold a key or move a release, so each needs the one reviewer,
# administrator bypass off and the branch main only; github-pages serves documents the clients verify, so it needs
# no reviewer (and is not failed for having one, or for the bypass). A missing environment is reported once and
# nothing else is checked for it; when the list itself could not be read, the environments are not reported missing
# on top of that.
for name in release feed promote withdraw github-pages; do
  [ "$have_envs" = 1 ] || continue
  if ! exists "$name"; then
    fail "environment $name does not exist"
    continue
  fi
  if [ "$name" != "github-pages" ]; then
    count=$(jq -r --arg n "$name" \
      '[.environments[] | select(.name == $n) | .protection_rules[]? | select(.type == "required_reviewers")][0].reviewers // [] | length' "$tmp/environments")
    if [ "$count" -eq 0 ]; then
      fail "environment $name has no required reviewer"
    else
      found=$(jq -r --arg n "$name" \
        '[.environments[] | select(.name == $n) | .protection_rules[]? | select(.type == "required_reviewers")][0].reviewers | map("\(.type):\(.reviewer.id)") | join(", ")' "$tmp/environments")
      [ "$found" = "User:$reviewer_id" ] || fail "environment $name reviewers must be exactly User:$reviewer_id, found $found"
    fi
    self=$(jq -r --arg n "$name" \
      '[.environments[] | select(.name == $n) | .protection_rules[]? | select(.type == "required_reviewers")][0].prevent_self_review // false' "$tmp/environments")
    [ "$self" = true ] || fail "environment $name: Prevent self-review is off"
    bypass=$(jq -r --arg n "$name" \
      '[.environments[] | select(.name == $n)][0].can_admins_bypass | if . == null then "missing" else tostring end' "$tmp/environments")
    [ "$bypass" = false ] || fail "environment $name lets repository administrators bypass its protection rules (can_admins_bypass is $bypass); turn it off"
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

# The workflows on main, as the contents API serves them: the directory listing, then every .yml or .yaml file as raw
# text. What is on main is what runs with the keys, so a checkout's own files are never read, and a workflow change
# that is not merged yet is not checked. Each file is turned into tab-separated facts by one awk pass:
#   env <file> <job> <environment>             a job that names an environment (a ${{ }} name is skipped: the check
#                                              cannot know what it resolves to)
#   secret <file> <job> <environment|-> <name> a secret NAME the job uses as ${{ secrets.NAME }} (GITHUB_TOKEN is the
#                                              run's own and is skipped; a comment line is not a use)
# A job is a key two spaces in under `jobs:`; its environment is `environment: <name>` on one line, `environment:`
# with a `name:` entry below it, or a flow mapping `environment: { name: <name>, ... }` on one line or over several.
: >"$tmp/facts"
have_workflows=0
if fetch workflow-list "repos/$repo/contents/.github/workflows?ref=main"; then
  jq -r '.[]? | select(.type == "file") | select(.name | test("\\.ya?ml$")) | .path' "$tmp/workflow-list" | sort >"$tmp/workflow-paths"
  if [ ! -s "$tmp/workflow-paths" ]; then
    fail "no workflow files found on main"
  else
    have_workflows=1
    while IFS= read -r path; do
      if gh api "repos/$repo/contents/$path?ref=main" -H "Accept: application/vnd.github.raw+json" >"$tmp/workflow-file" 2>/dev/null; then
        awk -v file="${path##*/}" '
          function flush(   s) {
            if (job != "") {
              if (env != "") printf "env\t%s\t%s\t%s\n", file, job, env
              for (s in secs) printf "secret\t%s\t%s\t%s\t%s\n", file, job, (env == "" ? "-" : env), s
            }
            delete secs; env = ""; block = 0; flow = 0
          }
          function clean(v) { sub(/[ \t]+#.*$/, "", v); sub(/^[ \t]+/, "", v); sub(/[ \t]+$/, "", v); return v }
          # the name in a flow mapping, `{ name: x, url: y }`, on one line or over several: the first `name:` key
          function flowname(t,   n) {
            if (match(t, /[ \t{,]name:[ \t]*[^,}]*/)) {
              n = substr(t, RSTART + 1, RLENGTH - 1); sub(/^name:[ \t]*/, "", n); n = clean(n)
              if (n != "" && n !~ /\$\{\{/) env = n
            }
          }
          BEGIN { job = "(workflow)"; injobs = 0 }
          /^[ \t]*#/ { next }
          /^jobs:[ \t]*$/ { flush(); job = ""; injobs = 1; next }
          injobs && /^[^ \t]/ { flush(); job = ""; injobs = 0; next }
          injobs && /^  [A-Za-z0-9_-]+:[ \t]*(#.*)?$/ { flush(); job = $1; sub(/:$/, "", job); next }
          injobs && /^    environment:/ {
            v = $0; sub(/^    environment:[ \t]*/, "", v); v = clean(v)
            block = (v == ""); flow = (v ~ /^\{/)
            if (flow) flowname(v)
            else if (v != "" && v !~ /\$\{\{/) env = v
            next
          }
          injobs && flow && /^    [^ \t]/ { flow = 0 }
          injobs && flow { flowname($0) }
          injobs && block && /^      name:/ {
            v = $0; sub(/^      name:[ \t]*/, "", v); v = clean(v)
            if (v !~ /\$\{\{/) env = v
            block = 0
            next
          }
          injobs && block && /^    [^ \t]/ { block = 0 }
          {
            line = $0
            while (match(line, /secrets\.[A-Za-z_][A-Za-z0-9_]*/)) {
              n = substr(line, RSTART + 8, RLENGTH - 8)
              line = substr(line, RSTART + RLENGTH)
              if (n != "GITHUB_TOKEN") secs[n] = 1
            }
          }
          END { flush() }' "$tmp/workflow-file" >>"$tmp/facts"
      else
        fail "cannot read repos/$repo/contents/$path?ref=main"
      fi
    done <"$tmp/workflow-paths"
  fi
fi

# Every environment a workflow names must already exist.
if [ "$have_envs" = 1 ] && [ "$have_workflows" = 1 ]; then
  jq -r '.environments[]?.name' "$tmp/environments" >"$tmp/env-names"
  awk -F'\t' '$1 == "env" { print $2 "\t" $4 }' "$tmp/facts" | sort -u | while IFS="$(printf '\t')" read -r file name; do
    case $name in
      \"*\") name=${name#\"}; name=${name%\"} ;;
      \'*\') name=${name#\'}; name=${name%\'} ;;
    esac
    grep -qxF -- "$name" "$tmp/env-names" ||
      echo "workflow $file names environment $name, which does not exist (a workflow creates a missing environment with no reviewer and no branch rule)"
  done >"$tmp/unknown-envs"
  while IFS= read -r line; do fail "$line"; done <"$tmp/unknown-envs"
fi

have_rulesets=0
if fetch rulesets "repos/$repo/rulesets"; then have_rulesets=1; fi

tag_ruleset_problems() { # <ruleset file>: one line per unmet condition of the tag ruleset on v*
  jq -r --argjson app "$app_id" '
    (if .enforcement == "active" then empty else "is not active" end),
    (if ((.conditions.ref_name.include // []) == ["refs/tags/v*"]) and (((.conditions.ref_name.exclude // []) | length) == 0)
       then empty else "does not cover exactly refs/tags/v*" end),
    (if ((.rules // []) | map(.type) | index("creation")) != null then empty else "lacks a creation rule" end),
    (if ((.rules // []) | map(.type) | index("update")) != null then empty else "lacks an update rule" end),
    (if ((.rules // []) | map(.type) | index("deletion")) != null then empty else "lacks a deletion rule" end),
    (if ((.bypass_actors // []) | length) == 1
       then (if .bypass_actors[0].actor_type == "Integration" and .bypass_actors[0].actor_id == $app then empty
             else "has a bypass actor that is not the release App (Integration:\($app)); found \(.bypass_actors[0].actor_type):\(.bypass_actors[0].actor_id)" end)
       else "must have exactly one bypass actor, the release App (Integration:\($app))" end)' "$1"
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
          info "tag ruleset bypass: Integration:$app_id (only the release App may create or move refs/tags/v*)"
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

# Where the secrets live, by name only (never a value). The environment secrets of an environment that already failed
# the existence check are not fetched: its 404 would report the same problem twice. Organisation secrets need an
# administrator token (admin:org); --no-org-secrets leaves them out and says so.
if fetch repo-secrets "repos/$repo/actions/secrets"; then :; fi
for name in release feed promote withdraw github-pages; do
  if exists "$name"; then
    fetch "secrets-$name" "repos/$repo/environments/$name/secrets" || :
  fi
done
if [ "$org_secrets" = 1 ]; then
  if ! gh api --paginate "orgs/$owner/actions/secrets" >"$tmp/org-secrets" 2>/dev/null; then
    rm -f "$tmp/org-secrets"
    fail "cannot read organisation secrets (needs admin:org); rerun with an admin token, or with --no-org-secrets to leave them unchecked"
  fi
else
  info "NOT CHECKED: organisation secrets"
fi

has_name() { # has_name <file> <secret name>: the secrets list in <file> holds the name
  [ -f "$1" ] && jq -e --arg k "$2" '([.secrets[]?.name] | index($k)) != null' "$1" >/dev/null
}
places() { # places <secret name>: where the name was found, "environment <env>" for each, then repository, organisation
  found=""
  for env in release feed promote withdraw github-pages; do
    if has_name "$tmp/secrets-$env" "$1"; then found="${found:+$found, }environment $env"; fi
  done
  if has_name "$tmp/repo-secrets" "$1"; then found="${found:+$found, }repository"; fi
  if has_name "$tmp/org-secrets" "$1"; then found="${found:+$found, }organisation"; fi
  printf '%s' "$found"
}

# A key secret is one a job uses in release, feed, promote or withdraw. It must be a secret of exactly that
# environment: not of another, not a repository secret, not an organisation secret.
awk -F'\t' '$1 == "secret" && ($4 == "release" || $4 == "feed" || $4 == "promote" || $4 == "withdraw") { print $5 "\t" $4 "\t" $2 "\t" $3 }' "$tmp/facts" |
  sort -t "$(printf '\t')" -k1,1 -k2,2 -k3,3 -k4,4 >"$tmp/key-uses"
if [ -s "$tmp/key-uses" ] && [ "$have_envs" = 1 ]; then
  cut -f1 "$tmp/key-uses" | sort -u | while IFS= read -r key; do
    uses=$(awk -F'\t' -v k="$key" '$1 == k' "$tmp/key-uses")
    environments=$(printf '%s\n' "$uses" | cut -f2 | sort -u)
    first=$(printf '%s\n' "$uses" | head -n 1)
    environment=$(printf '%s' "$first" | cut -f2)
    file=$(printf '%s' "$first" | cut -f3)
    job=$(printf '%s' "$first" | cut -f4)
    if [ "$(printf '%s\n' "$environments" | wc -l)" -gt 1 ]; then
      echo "FAIL: $key is used in more than one of release, feed, promote and withdraw ($(printf '%s' "$environments" | tr '\n' ' ' | sed 's/ $//; s/ /, /g')); a key belongs to exactly one environment"
      continue
    fi
    where=$(places "$key")
    [ "$where" = "environment $environment" ] ||
      echo "FAIL: $key (used by job $job of $file in environment $environment) must be a secret of environment $environment only (found in: ${where:-nowhere})"
  done >"$tmp/key-failures"
  while IFS= read -r line; do printf '%s\n' "$line"; problems=$((problems + 1)); done <"$tmp/key-failures"
fi

# The release App's two secrets are used by a job with no environment, so they are repository secrets by necessity:
# the known exposure of decision 10. Any other secret such a job uses is only reported.
awk -F'\t' '$1 == "secret" && $4 == "-" { print $5 "\t" $3 "\t" $2 }' "$tmp/facts" | sort -t "$(printf '\t')" -k1,1 -u >"$tmp/open-uses"
app_known=0
while IFS="$(printf '\t')" read -r name job file; do
  case $name in
    RELEASE_APP_ID|RELEASE_APP_PRIVATE_KEY) app_known=1 ;;
    *) info "job $job of $file uses repository secret $name (no environment)" ;;
  esac
done <"$tmp/open-uses"
if [ "$app_known" = 1 ]; then
  known "RELEASE_APP_PRIVATE_KEY and RELEASE_APP_ID are repository secrets (decision 10: move them to an environment limited to main)"
fi

# Every repository and organisation secret no workflow on main uses is listed, so a stray one (a key kept as a backup,
# say) is seen: not judged by its name, but not silent. A secret a workflow uses is not listed, whatever the job.
awk -F'\t' '$1 == "secret" { print $5 }' "$tmp/facts" | sort -u >"$tmp/used-secrets"
if [ "$have_workflows" = 1 ]; then
  for kind in repository organisation; do
    if [ "$kind" = repository ]; then list="$tmp/repo-secrets"; else list="$tmp/org-secrets"; fi
    [ -f "$list" ] || continue
    for name in $(jq -r '.secrets[]?.name' "$list"); do
      grep -qxF -- "$name" "$tmp/used-secrets" || info "$kind secret $name is used by no workflow on main"
    done
  done
fi

if [ "$problems" -gt 0 ]; then
  printf 'check-release-settings: %d problem(s)\n' "$problems"
  exit 1
fi
echo "check-release-settings: ok ($repo: release, feed, promote and withdraw have the one reviewer, no administrator bypass and allow the branch main only, github-pages allows main only, the tag ruleset holds refs/tags/v* for the release App, the signing keys are secrets of the environments that use them)"
