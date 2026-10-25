# Release settings: the one-time setup, and the check that proves it

A release signs with two keys that live as environment secrets; the reviewers, the main-only branch rules, the tag
ruleset, the feed-branch ruleset and the CODEOWNERS entry for the trust files are what keep a pushed tag, a rewritten
feed branch or an edited workflow from reaching a key unattended. Every command on this page is
run by hand, once, by the owner, from the Mac or any machine whose `gh` holds a token with administrator rights to the
repository: no workflow and no script of this repository changes a setting, and
`scripts/release/check-release-settings.sh` only reads.

## What the check requires

`sh scripts/release/check-release-settings.sh --reviewer-id <id> --app-id <app_id> [--repo <owner/name>] [--no-org-secrets] [--allow-main-bypass]`
prints one `FAIL:` line per problem and exits 1, and `check-release-settings: ok (...)` and exits 0 when there is none
(2 for a usage error: both ids are required); `INFO:` lines never fail. `<id>` is the release reviewer's
user id (the second account) and `<app_id>` the release App's id, so the check compares numbers, never names. It checks,
read-only and printing secret names only, never values:

| What | Requirement |
| --- | --- |
| `release`, `feed`, `promote`, `withdraw` | exist; exactly one required reviewer, a `User` whose id is `--reviewer-id` (a team, the maintainer account or a second reviewer fails); Prevent self-review on; `can_admins_bypass` false (step 4); deployments from the branch `main` only |
| `github-pages` | exists; deployments from the branch `main` only (it serves documents the clients verify, so it needs no reviewer and may let administrators bypass) |
| `release-please` | exists; deployments from the branch `main` only; no required reviewer (the job that uses it runs on every push to `main`, so a reviewer would stop every push). A `branch_policy` rule alone, or no protection rules, is fine; Prevent self-review and `can_admins_bypass` are not required |
| the workflows | read from `main` through the API, never from a checkout, so a workflow change that is not merged yet is not checked; every environment a `.github/workflows/*.yml` names with `environment:` exists (a workflow naming a missing one creates it with no reviewer and no branch rule); `${{ ... }}` expressions are skipped; `environment:` may be a name, a `name:` entry below it, or a flow mapping such as `{ name: release }` |
| the tag ruleset | one ruleset targeting tags that is active, covers exactly `refs/tags/v*`, holds the `creation`, `update` and `deletion` rules, and has exactly one bypass actor: an `Integration` whose id is `--app-id` |
| the feed branch | one ruleset targeting a branch that is active, whose `include` is exactly `["refs/heads/feed"]` with an empty `exclude`, that holds the `non_fast_forward` and `deletion` rules, and whose `bypass_actors` is empty (nobody, administrators included, may bypass it). One passing ruleset is enough |
| key secrets | derived from the workflows, not from a name pattern: every `secrets.<NAME>` a job uses in `release`, `feed`, `promote` or `withdraw` must be a secret of exactly that environment, of no other environment, and neither a repository nor an organisation secret; a job with no environment that reads a key (`RELEASE_SSH_KEY`, `FEED_SSH_KEY`, `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` by name, a secret a key job reads, or one a key environment holds) fails |
| the App's secrets | `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` are environment secrets of `release-please` only: not a repository secret, not an organisation secret, and not a secret of any other environment (step 6). Any other secret a job with no environment uses is an `INFO:` line, and so is every repository or organisation secret that no workflow on `main` uses (a stray key kept as a backup shows up there; it is listed, not judged by its name) |
| the `main` rulesets | their bypass actors are printed as `INFO:` lines for the owner to read |
| CODEOWNERS | `.github/CODEOWNERS` on `main`, read through the contents API with the raw media type. For **each** of `trust/keys.json`, `trust/keys.json.sig`, `trust/release_allowed_signers` and `trust/feed_allowed_signers` the LAST non-comment line whose pattern covers the file (gitignore-style: `/trust/`, `trust/`, `/trust/*`, `/trust/**`, `/trust/keys.json`, but also `*.json` or `*`) decides, and it must name an owner starting with `@` and name the trust directory or file in its pattern. A later generic line (`*`, `**`, `*.json`, `*.sig`) takes the files over and fails; a later line with no owner (`/trust/*`) removes the owner and fails; a line before the trust line is overridden and does not matter; who the owner is is not judged. And an active ruleset on `main` has a `pull_request` rule with `require_code_owner_review` true, **an empty `exclude`** (an exclude may drop `main`) and **no bypass actor** (a bypass actor can skip the review; `--allow-main-bypass` accepts one knowingly, see below) |

Two exposures were named so they are decided with open eyes (the release plan's section 1, decisions 9 and 10).
Decision 9 stays open: the account the lanes run as is a repository administrator that can merge a changed workflow
and bypass the review rule, and the approval screen shows the run, not the diff. The live `main: pull request and code
owners` ruleset has exactly that bypass actor (the repository role Admin, mode `pull_request`, read 2026-10-24), so the
check **fails on it by default** and prints it. The owner who accepts the exposure says so with `--allow-main-bypass`,
which turns the failure into a `WARN:` line naming the actors, at every run; an `exclude` is never accepted. The release
card lists every change to the release-critical paths, and the owner decides with that in front of him. Decision 10 is closed by the setup below.

## The steps

Each command is exact, each with the one-line result to expect. `<login>` below is the owner's second GitHub account
(the release reviewer) and `<id>` the number the first command of step 1 prints for it.

**Name the repository once, and read it before every write.** Every command below takes `$REPO`, none has a repository
hard-coded, and every write is preceded by `repo`, which prints the slug. **Stop unless the slug is the repository you
mean**: the same steps are run on the release bench (`morndo/morndo-release-test`) as a rehearsal, and a write that
lands on the wrong repository changes the settings that guard a key.

```sh
# REPO is empty on purpose: pasting this block writes nowhere. Set it by hand to the repository you mean,
# for example production (morndo/morndo) or the release bench (morndo/morndo-release-test).
REPO=
repo() {
  [ -n "$REPO" ] || { echo "REPO is empty: set REPO=<owner>/<name> first" >&2; return 1; }
  echo "repository: $REPO (stop unless this is the repository you mean)" >&2
}
```

With `REPO` empty every command below fails (`repos//...`) instead of writing somewhere, and `repo` says so. Set `REPO` and
redefine `repo` again in every new shell. `${REPO%%/*}` is the organisation part where a command needs it.

1. **Create `promote` and `withdraw` before the workflows that name them are merged.** A workflow that names a missing
   environment creates it with no reviewer and no branch rule, so the environment must be there first:

   ```sh
   gh api users/<login> --jq .id
   repo
   gh api -X PUT repos/$REPO/environments/promote --input - <<'EOF'
   {"reviewers":[{"type":"User","id":<id>}],"prevent_self_review":true,"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
   EOF
   ```

   Expected: the first command prints the second account's id (look it up; do not paste an id you did not look up),
   the second answers with the environment object. Repeat the `PUT` for `withdraw` (run `repo` before it).

2. **Give `promote` and `withdraw` their branch policy**, the branch `main` only:

   ```sh
   repo
   gh api -X POST repos/$REPO/environments/promote/deployment-branch-policies -f name=main -f type=branch
   ```

   Expected: the policy object (`"name":"main"`, `"type":"branch"`). Repeat for `withdraw` (run `repo` before it).

3. **Remove the tag policy `v*` from `release`, `feed` and `github-pages`**, which allow `main` and `v*` today (a run
   started from a tag must not reach a key), and make sure `main` is present:

   ```sh
   gh api repos/$REPO/environments/release/deployment-branch-policies --jq '.branch_policies[] | select(.type=="tag") | .id'
   repo
   gh api -X DELETE repos/$REPO/environments/release/deployment-branch-policies/<id>
   gh api repos/$REPO/environments/release/deployment-branch-policies --jq '.branch_policies[] | "\(.name) \(.type)"'
   ```

   Expected: the first command prints the tag policy's id, the `DELETE` answers with no body, the third prints
   `main branch` and nothing else. Repeat all three for `feed` and `github-pages` (run `repo` before each `DELETE`).

4. **Turn off administrator bypass on `release`, `feed`, `promote` and `withdraw`.** The account the lanes run as is a
   repository administrator; with the bypass on it could skip the required reviewer, so the reviewer would stop nothing.
   GitHub documents this as a checkbox, not a REST parameter: Settings > Environments > the environment > deselect
   "Allow administrators to bypass configured protection rules" > Save protection rules
   (https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments, read
   2026-10-24). The REST `GET` returns `can_admins_bypass` (read live 2026-10-24: `true` on `release`, `feed` and
   `github-pages`), but the REST description does not list it as a `PUT` parameter, so this step uses the checkbox and
   the check is the proof:

   ```sh
   gh api repos/$REPO/environments --jq '.environments[] | {name, can_admins_bypass}'
   ```

   Expected: `can_admins_bypass` is `false` for `release`, `feed`, `promote` and `withdraw` (`github-pages` may stay
   `true`). Do this for `promote` and `withdraw` right after step 1, before their workflows are merged.

5. **Create the tag ruleset**, so only the release App can create or move a `v*` tag (Release Please tags with its
   App token). The App's id is on its page under Settings > GitHub Apps, or in the org's installations:

   ```sh
   gh api orgs/${REPO%%/*}/installations --jq '.installations[] | {app_id, app_slug}'
   repo
   gh api -X POST repos/$REPO/rulesets --input - <<'EOF'
   {"name":"v* tags: only the release App","target":"tag","enforcement":"active",
    "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
    "rules":[{"type":"creation"},{"type":"update","parameters":{"update_allows_fetch_and_merge":false}},{"type":"deletion"}],
    "bypass_actors":[{"actor_id":<app_id>,"actor_type":"Integration","bypass_mode":"always"}]}
   EOF
   ```

   Expected: the first command lists the org's installations and their `app_id`s; the second answers with the ruleset
   object, `"enforcement":"active"` among its fields.

6. **Put the release App's two secrets in `release-please`** (decision 10). Do these in order. A workflow that names a
   missing environment creates it with no protection rules or secrets, so the environment exists before the pull
   request that names it merges. A secret at the environment level takes precedence over a repository secret of the
   same name (https://docs.github.com/en/actions/reference/security/secrets, read 2026-10-24), which is why the
   repository copies stay until one push to `main` has read the environment copies, and are deleted last. The
   environment's branch rule walls off every other branch and every tag from these secrets, not `main` itself:
   whatever is merged to `main` can read them, which is why the release App keeps only the permissions pull requests
   and contents.

   1. Create the environment `release-please` with the branch policy `main` only and no reviewer, before the pull
      request that names it merges:

      ```sh
      repo
      gh api -X PUT repos/$REPO/environments/release-please --input - <<'EOF'
      {"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
      EOF
      gh api -X POST repos/$REPO/environments/release-please/deployment-branch-policies -f name=main -f type=branch
      ```

      Expected: the `PUT` answers with the environment object (no reviewers) and the `POST` with the policy object
      (`"name":"main"`, `"type":"branch"`).

   2. Set `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` in that environment:

      ```sh
      repo
      gh secret set RELEASE_APP_ID -R "$REPO" --env release-please --body "<the App's id>"
      gh secret set RELEASE_APP_PRIVATE_KEY -R "$REPO" --env release-please < release-app-key.pem
      ```

      `release-app-key.pem` is the private key file the App's settings page produced; delete the local copy afterwards.

      Expected: the `secret set` commands report the secret names they stored.

   3. Merge the pull request that adds `environment: release-please` to the `release-please` job.

   4. Let one push to `main` read it: the `release-please` job's app-token step succeeds.

   5. Delete the repository-level copies:

      ```sh
      repo
      gh secret delete RELEASE_APP_ID -R "$REPO"
      gh secret delete RELEASE_APP_PRIVATE_KEY -R "$REPO"
      ```

      Expected: the `secret delete` commands remove the two repository secrets.

7. **Protect the `feed` branch with a ruleset nobody can bypass.** The commit jobs of `withdraw.yml`, `promote.yml` and
   `feed.yml` write the `feed` branch with `contents: write` and no environment, and are guarded only by an `if` in
   their own file, so a user with write access could run a copy of the workflow from another branch. The feed key is
   the second gate (the sign job is behind the `feed` environment, and that environment allows `main` only). This
   ruleset keeps the branch's history from being rewritten and the branch from being deleted. Creating the branch and
   fast-forward updates, which is what those workflows do, are not blocked by these two rules
   (https://docs.github.com/en/rest/repos/rules, read 2026-10-24). **A promotion's seven-day soak relies on this
   ruleset**: it counts from the commit date of the oldest feed commit whose signed `latest.json` lists the Version,
   in first-parent order along the whole branch, and that is only the real first listing while history cannot be
   rewritten (no force push) or dropped (no deletion). It also relies on the dates of the commits the release bot
   itself makes: the signed feed pins which commit counts, not what its date says. The shell check before the key
   recomputes it from the branch, but it cannot tell a rewritten branch from a real one:

   ```sh
   repo
   gh api -X POST repos/$REPO/rulesets --input - <<'EOF'
   {"name":"feed branch: no force push, no deletion","target":"branch","enforcement":"active",
    "conditions":{"ref_name":{"include":["refs/heads/feed"],"exclude":[]}},
    "rules":[{"type":"non_fast_forward"},{"type":"deletion"}],
    "bypass_actors":[]}
   EOF
   ```

   Expected: the ruleset object, with `"enforcement":"active"` and `"bypass_actors":[]` among its fields.

8. **Name an owner for the trust files in `.github/CODEOWNERS`.** Add this line, with the maintainer's own handle in
   place of `@owner-account`:

   ```
   /trust/ @owner-account
   ```

   An active ruleset on `main` with a `pull_request` rule that has `require_code_owner_review` true (the existing
   `main: pull request and code owners`) is what turns that line into a required review, so the check requires that
   rule too (https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners,
   read 2026-10-24). CODEOWNERS is last-match-wins, per file: for each trust file the last line that covers it decides and must
   name an owner and the trust directory or file, so a later `*`, `*.json` or `*.sig` line, or a later `/trust/*` line
   with no owner, takes the files over and the check fails on it. With one maintainer account that the lanes also use,
   the `/trust/` entry names the same owner as `*`, so it is explicit but not yet a second review. It becomes one once the lanes get a GitHub account of their own
   without administrator rights (the plan's decision 9, "the real fix"). The check requires the entry either way.

9. **Run the check and keep its output.** It needs the second account's user id (the number `gh api users/<login>
   --jq .id` printed in step 1) and the release App's id (the `app_id` step 5 listed):

   ```sh
   gh auth status
   sh scripts/release/check-release-settings.sh --repo "$REPO" --reviewer-id <id> --app-id <app_id>
   ```

   Expected: `gh auth status` shows the token's scopes (organisation secrets need `admin:org`), the check prints
   `check-release-settings: ok ($REPO: ...)`, with the slug it read. On `morndo/morndo` today the check also fails on the repository Admin bypass actor of the `main` code-owner ruleset (decision 9) until the owner runs it with `--allow-main-bypass`, which turns that line into a `WARN:`. Without `admin:org` the organisation secrets cannot be read and
   the check says so: run it with an administrator token, or pass `--no-org-secrets` to leave them unchecked. The
   check runs before every release and every Monday (the manager's Monday card), never inside Actions (the Actions
   token cannot read environment secrets, rulesets or reviewers), and its output is kept as evidence in the run book.

## Running a withdrawal or a promotion

`withdraw.yml` and `promote.yml` are manual. Each run needs two taps: the `withdraw` or `promote` environment, then
`feed`. Reject or cancel a run left unapproved the same day. Its preparation job read the `feed` branch at that
moment, and the commit job refuses ("the feed branch moved; run this job again") if a re-sign ran meanwhile.
`feed.yml`'s Monday re-sign holds the `morndo-feed` concurrency group while it waits for its approval, and the feed
expires after 14 days: a missed week is safe, two are not. The withdraw workflow takes `morndo-feed` only in its
commit job. Withdrawing the last Version a channel offers needs the `allow_empty_channel` input.

A withdrawal marks the Feed. It does not change which release GitHub calls latest, so a first install made from
`https://github.com/<owner>/<repo>/releases/latest/download/install.sh` can still take a withdrawn Release until a newer
one is published. Until then, give people the address of a Version that is good
(`.../releases/download/v<version>/install.sh`, which installs exactly that Version), or publish the next release.

## Endpoints used

- https://docs.github.com/en/rest/deployments/environments — environments, protection rules, deployment branch policy
- https://docs.github.com/en/rest/deployments/branch-policies — list, add and delete deployment branch policies
- https://docs.github.com/en/rest/repos/rules — rulesets, their conditions, rules and bypass actors
- https://docs.github.com/en/rest/actions/secrets — repository, environment and organisation secret names
- https://docs.github.com/en/rest/repos/contents — the workflow files and `.github/CODEOWNERS` on `main`, read with the raw media type
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners — a CODEOWNERS line is a pattern followed by one or more `@` owners

All read 2026-10-23, and the rules and code owners pages again on 2026-10-24. What the pages say that these steps rely
on: the environment `PUT` takes `reviewers` (up to six, `type` and `id`), `prevent_self_review` and a
`deployment_branch_policy` whose two booleans are both required and must differ; a branch policy takes `name` and
`type` (`branch` or `tag`); a ruleset takes `target` `tag` or `branch`, `enforcement` `active`,
`conditions.ref_name.include`/`exclude`, rules `creation`, `update` (with `update_allows_fetch_and_merge`), `deletion`
and `non_fast_forward`, and bypass actors (an empty list means nobody bypasses it; a tag ruleset's actor is an
`Integration` with `bypass_mode` `always`). A CODEOWNERS pattern such as `/trust/` followed by `@` owners is what the
code owners rule reviews. The check's own run against the live settings (2026-10-24, read-only) is how the shapes it
parses were confirmed. Not run: the steps themselves, which change settings and belong to the owner or the Mac.
