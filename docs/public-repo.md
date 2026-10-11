# Public repository

Checked 2026-10-10. Dub (`https://github.com/dubinc/dub`, tree `main`) is the licence model: AGPLv3 for the open core, a separate enterprise licence under `ee`. Its community files are not the model. The lists below say which pieces are files in this repo and which are settings the manager turns on after `morndo/morndo` exists.

## What dub has

Root, from the Git tree (6,126 paths, not truncated): `LICENSE.md`, `README.md`, `SECURITY.md`, `.gitignore`, and app directories. No `CONTRIBUTING.md`, no `CODE_OF_CONDUCT.md`, no `CODEOWNERS`, no `.env.example` at the root.

`.github` contains only `workflows/`. No issue or pull request templates, no `dependabot.yml`.

| Piece | Dub, 2026-10-10 | Here |
|---|---|---|
| Licence split | `LICENSE.md` is AGPLv3 outside named `ee` paths. README calls this open core. | Already `LICENSE.md` and `ee/LICENSE.md`. |
| `SECURITY.md` | Asks for email to a company address. | A file. Private GitHub reporting, no personal email. |
| Contributing | A README section, not a `CONTRIBUTING.md`. | A file. |
| Code of conduct | None in the tree. | Not added. |
| Issue and PR templates | None. | Files. |
| `CODEOWNERS` | None. The `morndo` org has no team. | A file, `@jacksnxly`, the form GitHub documents for one maintainer. |
| Dependabot config | None. | A file for npm and Actions version updates. |
| CI | Workflows under `.github/workflows`, some with secrets and floating action tags. | Existing CI, plus a secrets workflow. Actions pinned by commit. |
| `.env.example` | `apps/web/.env.example` only. | Not added. The quick start is one public variable in the README. |

Sources: the tree and file contents via the GitHub API on 2026-10-10 (`https://github.com/dubinc/dub`).

## What GitHub recommends

| Practice | Kind | Source, read 2026-10-10 |
|---|---|---|
| `SECURITY.md`, `CONTRIBUTING.md`, issue and PR templates | Repo files | [Community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file) |
| Secret scanning on public repositories | On for free once the repo is public. Alerts are a setting to watch. | [About secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning) |
| Push protection | Setting. Repository push protection needs GitHub Secret Protection and is off until an admin enables it. User push protection is an account setting and is on by default. | [About push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) |
| Private vulnerability reporting | Setting: Settings → Advanced Security → Private vulnerability reporting. `SECURITY.md` is separate and is shown above the form. | [Privately reporting a vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability), [Configuring private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository) |
| Branch protection or a ruleset on `main` | Setting. Prefer a ruleset: readers can see it, and it can require a pull request, the CI and secrets checks, a code-owner review, and block force pushes. | [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets), [About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) |
| Dependabot alerts and security updates | Settings. Alerts need the dependency graph. Security updates open patch pull requests. `dependabot.yml` is only the version-update schedule. | [About Dependabot alerts](https://docs.github.com/en/code-security/dependabot/dependabot-alerts/about-dependabot-alerts), [About Dependabot security updates](https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates), [dependabot.yml](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuration-options-for-the-dependabot.yml-file) |
| Actions on forks | Setting plus workflow shape. Require approval before workflows run for first-time contributors from forks. `GITHUB_TOKEN` stays read-only. Do not use `pull_request_target` or a self-hosted runner. Pin actions to a full commit SHA. | [Approving workflow runs from forks](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/approving-workflow-runs-from-public-forks), [Secure use](https://docs.github.com/en/actions/reference/security/secure-use) |

## Settings for the manager

After the public repo exists:

1. Enable private vulnerability reporting.
2. Confirm secret scanning is on. Enable push protection for the repository.
3. Enable Dependabot alerts and Dependabot security updates.
4. Add a ruleset on `main`: pull request required, review from code owners, no force push, and these required status checks: `CI / ci`, `CI / fleet`, `Secrets / gitleaks`, `Commit traces / traces`. `@jacksnxly` needs write access or the code-owner review never attaches.
5. Actions: approval required for fork pull requests from first-time contributors. Default workflow token permissions read. No self-hosted runners.

## Commit attribution

Checked 2026-10-11. `.claude/settings.json` sets `attribution.commit` and `attribution.pr` to an empty string, and `sessionUrl` to false. An empty `attribution.commit` omits the `Co-Authored-By` trailer; an empty `attribution.pr` omits the pull-request line. `attribution: false` needs a newer client and older clients reject the whole file, so the empty strings stay. Source: [Claude Code settings](https://code.claude.com/docs/en/settings-reference), read 2026-10-11.

`scripts/git-hooks/commit-msg` rejects attribution: a `Co-authored-by` or `Signed-off-by` line that names an assistant or a bot other than `dependabot[bot]`, a "Generated with" or "Generated by" line, a session or chat link, or an assistant-vendor email address. A product or runtime name in the subject or body is allowed. The Commit traces workflow checks the same attribution in the message, and the author and committer names, of every commit on a pull request and every push to `main`. `dependabot[bot]` is allowed. Authors such as `claude[bot]`, `cursor[bot]`, `codex`, and `copilot-swe-agent` fail.

The pre-push hook and that same job also reject a commit whose author email is not an address at `users.noreply.github.com`. The committer may use that address or GitHub's web-flow address `noreply@github.com`. The one commit already published with a personal author address, the PR #11 admin merge, is listed in `scripts/git-hooks/traces-published-exceptions` (one full sha per line, a comment line for why); the identity check skips exactly the shas listed there and nothing else.

Commit-metadata rules (commit message pattern, author email pattern) are not available for this repository. The free-org ruleset list has no commit-message or author-email rule, and push rulesets apply to private and internal repositories. Organizations on a GitHub Enterprise plan can add rules for how commit metadata is formatted. There is no ruleset JSON to apply here. Sources, read 2026-10-11: [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [Available rules (Enterprise Cloud)](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).
