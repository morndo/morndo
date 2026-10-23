# Release settings: the one-time setup, and the check that proves it

A release signs with two keys that live as environment secrets; the reviewers, the main-only branch rules and the tag
ruleset are what keep a pushed tag or an edited workflow from reaching a key unattended. Every command on this page is
run by hand, once, by the owner, from the Mac or any machine whose `gh` holds a token with administrator rights to the
repository: no workflow and no script of this repository changes a setting, and
`scripts/release/check-release-settings.sh` only reads.

## What the check requires

`sh scripts/release/check-release-settings.sh [--repo <owner/name>] [--workflows <dir>] [--no-org-secrets]` prints one
`FAIL:` line per problem and exits 1, and `check-release-settings: ok (...)` and exits 0 when there is none;
`INFO:` and `KNOWN:` lines never fail. It checks, read-only and printing secret names only, never values:

| What | Requirement |
| --- | --- |
| `release`, `feed`, `promote`, `withdraw` | exist; a `required_reviewers` rule with a non-empty reviewers list and Prevent self-review on; deployments from the branch `main` only |
| `github-pages` | exists; deployments from the branch `main` only (it serves documents the clients verify, so it needs no reviewer) |
| environments named by workflows | every environment a `.github/workflows/*.yml` names with `environment:` exists (a workflow naming a missing one creates it with no reviewer and no branch rule); `${{ ... }}` expressions are skipped |
| the tag ruleset | one ruleset targeting tags that is active, covers exactly `refs/tags/v*`, holds the `creation`, `update` and `deletion` rules, and has exactly one bypass actor: the release App (an Integration) |
| `RELEASE_SSH_KEY`, `FEED_SSH_KEY` | a secret of exactly the environment `release` / `feed`: of no other environment, and not a repository secret |
| signing-key-shaped names | no repository or organisation secret whose name matches `SSH_KEY`, `SIGNING` or `PRIVATE_KEY` (case-insensitive), except the App's `RELEASE_APP_PRIVATE_KEY`, which is printed as `KNOWN:` until it moves (step 5) |
| the `main` rulesets | their bypass actors are printed as `INFO:` lines for the owner to read |

Two exposures stay open, stated so they are decided with open eyes (the release plan's section 1, decisions 9 and 10):
the account the lanes run as is a repository administrator that can merge a changed workflow and bypass the review
rule, and the approval screen shows the run, not the diff — so the check prints the `main` rulesets' bypass actors and
the release card lists every change to the release-critical paths, and the owner decides with that in front of him.
The release App's `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` are repository secrets today, readable by a workflow
from any branch, and step 5 moves them into an environment limited to `main`.

## The steps

Each command is exact, each with the one-line result to expect. `<login>` below is the owner's second GitHub account
(the release reviewer) and `<id>` the number the first command of step 1 prints for it.

1. **Create `promote` and `withdraw` before the workflows that name them are merged.** A workflow that names a missing
   environment creates it with no reviewer and no branch rule, so the environment must be there first:

   ```sh
   gh api users/<login> --jq .id
   gh api -X PUT repos/morndo/morndo/environments/promote --input - <<'EOF'
   {"reviewers":[{"type":"User","id":<id>}],"prevent_self_review":true,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   EOF
   ```

   Expected: the first command prints the second account's id (look it up; do not paste an id you did not look up),
   the second answers with the environment object. Repeat the `PUT` for `withdraw`.

2. **Give `promote` and `withdraw` their branch policy**, the branch `main` only:

   ```sh
   gh api -X POST repos/morndo/morndo/environments/promote/deployment-branch-policies -f name=main -f type=branch
   ```

   Expected: the policy object (`"name":"main"`, `"type":"branch"`). Repeat for `withdraw`.

3. **Remove the tag policy `v*` from `release`, `feed` and `github-pages`**, which allow `main` and `v*` today (a run
   started from a tag must not reach a key), and make sure `main` is present:

   ```sh
   gh api repos/morndo/morndo/environments/release/deployment-branch-policies --jq '.branch_policies[] | select(.type=="tag") | .id'
   gh api -X DELETE repos/morndo/morndo/environments/release/deployment-branch-policies/<id>
   gh api repos/morndo/morndo/environments/release/deployment-branch-policies --jq '.branch_policies[] | "\(.name) \(.type)"'
   ```

   Expected: the first command prints the tag policy's id, the `DELETE` answers with no body, the third prints
   `main branch` and nothing else. Repeat all three for `feed` and `github-pages`.

4. **Create the tag ruleset**, so only the release App can create or move a `v*` tag (Release Please tags with its
   App token). The App's id is on its page under Settings > GitHub Apps, or in the org's installations:

   ```sh
   gh api orgs/morndo/installations --jq '.installations[] | {app_id, app_slug}'
   gh api -X POST repos/morndo/morndo/rulesets --input - <<'EOF'
   {"name":"v* tags: only the release App","target":"tag","enforcement":"active",
    "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
    "rules":[{"type":"creation"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}],
    "bypass_actors":[{"actor_id":<app_id>,"actor_type":"Integration","bypass_mode":"always"}]}
   EOF
   ```

   Expected: the first command lists the org's installations and their `app_id`s; the second answers with the ruleset
   object, `"enforcement":"active"` among its fields.

5. **Move the release App's two secrets into an environment limited to `main`** (decision 10). This also needs the
   `release-please` job in `.github/workflows/release.yml` to name that environment — a workflow change that is not
   in this pull request — so run these commands only together with that change; until then the check prints `KNOWN:`
   for the two secrets and does not fail on them:

   ```sh
   gh api -X PUT repos/morndo/morndo/environments/release-please --input - <<'EOF'
   {"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   EOF
   gh api -X POST repos/morndo/morndo/environments/release-please/deployment-branch-policies -f name=main -f type=branch
   gh secret set RELEASE_APP_ID -R morndo/morndo --env release-please --body "<the App's id>"
   gh secret set RELEASE_APP_PRIVATE_KEY -R morndo/morndo --env release-please < release-app-key.pem
   gh secret delete RELEASE_APP_ID -R morndo/morndo
   gh secret delete RELEASE_APP_PRIVATE_KEY -R morndo/morndo
   ```

   `release-app-key.pem` is the private key file the App's settings page produced; delete the local copy afterwards.

   Expected: the environment and its policy answer as in steps 1 and 2, the `secret set` commands report the secret
   names they stored, and the `secret delete` commands remove the two repository secrets.

6. **Run the check and keep its output**:

   ```sh
   gh auth status
   sh scripts/release/check-release-settings.sh
   ```

   Expected: `gh auth status` shows the token's scopes (organisation secrets need `admin:org`), the check prints
   `check-release-settings: ok (morndo/morndo: ...)`. Without `admin:org` the organisation secrets cannot be read and
   the check says so: run it with an administrator token, or pass `--no-org-secrets` to leave them unchecked. The
   check runs before every release and every Monday (the manager's Monday card), never inside Actions (the Actions
   token cannot read environment secrets, rulesets or reviewers), and its output is kept as evidence in the run book.

## Endpoints used

- https://docs.github.com/en/rest/deployments/environments — environments, protection rules, deployment branch policy
- https://docs.github.com/en/rest/deployments/branch-policies — list, add and delete deployment branch policies
- https://docs.github.com/en/rest/repos/rules — rulesets, their conditions, rules and bypass actors
- https://docs.github.com/en/rest/actions/secrets — repository, environment and organisation secret names

All read 2026-10-23. What the pages say that these steps rely on: the environment `PUT` takes `reviewers` (up to six,
`type` and `id`), `prevent_self_review` and a `deployment_branch_policy` whose two booleans are both required and must
differ; a branch policy takes `name` and `type` (`branch` or `tag`); a ruleset takes `target` `tag`, `enforcement`
`active`, `conditions.ref_name.include`/`exclude`, rules `creation`, `update` (with `update_allows_fetch_and_merge`) and
`deletion`, and bypass actors of type `Integration` with `bypass_mode` `always`. The check's own run against the live
settings (2026-10-24, read-only) is how the shapes it parses were confirmed. Not run: the steps themselves, which
change settings and belong to the owner or the Mac.
