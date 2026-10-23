# The release verifier: a proposal (C5), round 5, for review before any code

Status: a proposal. Nothing in it is built, installed or run. Facts say where they were read; the GitHub pages were read on 2026-10-23. Round 1 put the canary before the signing and offered a canary-signed build to a released version; the review showed that cannot work (a released version carries the production trust and refuses another key) and that it would leave the production signatures untested. This round puts the verifier's approvals **after** the signing, where the real signatures exist.

## 1. What is asked, and the facts the design rests on

The owner has granted a **release verifier**, a GitHub account of its own, the right to approve Morndo releases without him once it has installed the release on a canary and every check passed. It attaches the evidence to the approval, rejects the release when a check fails, and the owner is told after each release.

Facts from this repository at `4a0274cf`, and what they force:

1. **The release key signs after the approval.** `.github/workflows/release.yml`: the `sign` job runs in the environment `release` (line 314) and gets the key only after a required reviewer approves. Before that approval no signed manifest exists.
2. **The signed assets are then available as run artifacts** (`sign` uploads them; `publish` downloads them by exact name and puts them on the draft release), and the draft is not public until `ship` runs `gh release edit --draft=false`. Between `publish` and `ship` the real, production-signed bytes exist and nothing is irreversible yet (a published release is immutable and its tag cannot be reused, design §9.4).
3. **The updater installs only what a signed Feed vouches for** (RL1), and the **feed key signs only after publication** (`feed-sign`, environment `feed`). So an update through the Feed under production trust cannot run before the release is published.
4. **`install.sh` is signed, takes the caller's signers file (`--signers`) and a base URL (`MORNDO_RELEASE_BASE`)**, verifies the manifest's signature, size and SHA-256 itself and installs that archive. So the real signed bytes can be installed on a machine of the verifier's choosing, under the production signers, without a Feed and without rewriting a byte of the manifest.
5. **A node never updates above its control plane** (`skew()`, `node_ahead`), so a real node cannot be "the canary, first". The canary is an isolated copy, never a machine of the owner's.
6. Two end-to-end harnesses already build throwaway systemd machines in Docker, install Morndo as `install.sh` does, and follow the rules the verifier keeps (no host mounts, no host network, no published ports, only labelled containers touched, removal on every way out): `e2e/update.e2e.ts` and `e2e/update-fleet.e2e.ts` (a control plane and a node, a browser journey with a virtual passkey, a rollback). They build their releases from source with in-memory test keys and do not consume published artifacts; the verifier reuses their machine, forwarders and checks, and replaces the build step with the real signed assets.
7. The updater has `morndo update --check`, `--status`, `--rollback` (with a preview) and `recover` (`apps/updater/src/cli.ts`).

## 2. The design: the verifier approves at the two points where the signed bytes exist

| Gate | What waits | What the verifier can know there | The verifier's call |
| --- | --- | --- | --- |
| 1 `release` (exists) | the `sign` job, before the release key is used | CI, the review records, the build artifacts the run made. Not signatures. | **The owner's tap stays.** The verifier account is **not a reviewer of this environment**, so its token cannot approve it (D1). |
| 2 `publish` (new: the `ship` job gets an environment) | publishing the draft, the irreversible step | the **production signatures as they are**, and a **fresh install of the real signed release** on an isolated canary under production trust, with the journeys | **verifier approves or rejects** |
| 3 `promote` (new: the promotion workflow of design §9.5, to be built, with its approval job in **its own environment `promote`**, not in `release`) | B being offered to users on `stable` | an **update from the real released A to B through the real Feed**, under production trust, then a rollback drill | **verifier approves or rejects**; a reject withdraws B in the Feed |

**Reading of the grant.** "Approve a release once it has installed it on the canary" can only mean a gate after signing, because only then is there something to install. Gates 2 and 3 are that. Gate 1 is where the release key is used: signed assets are valid under the production key for as long as they exist, and a run's artifacts are downloadable, so a bad candidate signed at gate 1 would leave a validly signed bad manifest lying around even if gate 2 then rejects it. That is why gate 1 stays with the owner (one tap per release, at the moment the key is used), **and the token enforces it, not only the workflow**: the verifier account is a reviewer of `publish` and `promote` and of no other environment. D1 asks whether to change that.

**Which environments the verifier account reviews, exactly:** `publish` and `promote`. Not `release` (the key use), not `feed` (the Feed's signing), not `github-pages`. Gate 3 has its own environment because a reviewer of `release` could also approve the key use; with `promote` the two are separate in GitHub's settings and in what the token can do.

**The Feed key: who authorizes each use.** The design keeps the feed key online so the weekly re-sign needs no human (design §9.5 and its decision Q3), which means the environment `feed` has **no required reviewers**, and the verifier is **not a reviewer of `feed`** either: the same token could then approve the weekly re-sign, which has no release behind it and no evidence. The gates in front of it are what authorize a feed-key use, so each verifier approval is **explicitly** the authorization of exactly one named feed use, and nothing else can start one:

- approving `publish` for release X lets `ship` publish X and then `feed-sign` add X to the `latest` Feed, in the same run and for the version that run built (`needs.release-please.outputs.version`), and no other;
- approving `promote` for version X lets the promotion workflow's signing job add X to the `stable` Feed, for the version named in that run (its `run-name` carries it) and no other;
- the weekly re-sign signs the Feeds as they are, with a new number and expiry, and adds no Release;
- the approval comment says which use it authorizes ("authorizes: publish of X and the `latest` Feed entry for X"), and the evidence records it; the verifier evaluates, and compares before it approves, the very version the run will sign.

Workflow tests (phase 3) pin each of these: the feed-signing jobs take their version from the run that was approved, and no job other than the weekly re-sign can sign a Feed without a preceding approved `publish` or `promote`. Decision D6 asks the owner to confirm this reading, or to put himself as reviewer of `feed` as an extra tap per release.

**What each gate cannot test, and why**

- Gate 2 cannot test the Feed chain (the feed key signs only after publication), the hosting at github.com (the canary is served the assets from inside its own machine, with the manifest unchanged), an *update* from A to B (no Feed yet), or a rollback (a fresh install has no previous version). It tests every signature of the release key chain as shipped, the archive against the manifest, the install path, and the journeys on the real bytes.
- Gate 3 tests the whole chain end to end, including the Feed, because by then B is published and the Feed lists it. What no check before a rollout can cover is the owner's own machines: their data, sizes and hardware. The updater's own probation, Backup and automatic rollback cover that.

**What a rejection leaves behind.** A gate-2 reject stops the draft from being published, but the signed assets are already run artifacts: **a validly signed bad manifest stays downloadable for the repository's artifact retention period**, and `install.sh` run with a base URL pointing at it and the production signers would accept it. Two changes in the workflow close that (phase 3): the signed artifacts get a short retention (days, not the default), and a failure-path job deletes the run's artifacts when `publish` is rejected (it needs `actions: write`, which the workflow's own token can hold; the verifier's read-only account cannot).

**Which channel the owner's machines follow decides what gate 3 is worth to him.** The standing decision of 2026-10-21 is that the owner's fleet follows `latest`, and that stays the default of this plan. (The design's own wording, `docs/domain.md` under Channel, calls `stable` the owner's default, Q2, so the two differ; D5 settles which one the plan assumes.) Consequences, stated plainly: the control plane takes B when the Feed lists it, and the nodes wait the Rollout's soak (30 minutes by default, design §7). So **for the owner's own machines gate 2 is the last approval before B can reach them**; gate 3 then guards only users on `stable`, and **a gate-3 reject cannot move a machine that is already on B** (a withdrawal marks B withdrawn; machines on it stay on it and are told). The verifier's real-Feed update test and rollback drill run as soon as B is on `latest`, inside the nodes' soak window, and a failure there **alerts the owner at once so he can halt the Rollout** (halting is the principal's action); it cannot undo what the control plane already took. Moving the owner's fleet to `stable` instead (D5) makes gate 3 protect him too, at the cost of seven days on `latest` before he gets a release.

## 3. Where it runs, and as whom

- **A job, not an LLM lane**: a plain program on a systemd user timer. It cannot be talked into an approval and costs no model time; its decision is a function of the evidence. A model may be asked afterwards to explain a rejection, never to decide.
- **On the owner's build PC**, because the canary needs Docker. Not on the control plane (the owner's main channel) and not on the owner's third machine (it runs unrelated production workloads that Morndo must not touch, and it is last in a rollout anyway). One heavy job at a time: the verifier takes the box's heavy-job lock and waits for it.
- **From a released version, never the candidate:** its code is the Morndo version already installed on the PC, so a candidate cannot alter its own verification. Its trust anchors are its own: the production `release_allowed_signers`, the root signer pin and the key set with its minimum version, copied from the **previously released** tree, never read from the candidate.
- **Separation from the builders** is the GitHub account and the run's `triggering_actor`: the verifier account never triggers a release, and Prevent self-review is on, so the account that merged to `main` cannot approve. The job also runs under its own Linux user if the owner creates one (D4); until then it shares the lanes' user and relies on the limits in section 4.

## 4. The token, what it can reach, and what a leak allows

- **What the API needs** (GitHub REST, "Review pending deployments for a workflow run", `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`, body `environment_ids`, `state` `approved` or `rejected`, `comment`): a required reviewer with read access, and "OAuth app tokens and personal access tokens (classic) need the repo scope". The page documents no fine-grained or GitHub App permission for it, so the only documented route is a **classic token**, and a classic `repo` scope reaches whatever the account can reach. The bound is therefore on the **account**:
  - the account is **not a member of the `morndo` organisation**; it is an **outside collaborator with the Read role on `morndo/morndo` only** (the Read role is what lets it be listed as a required reviewer; the pages read do not say whether a user with no role can be listed, so this is confirmed when the settings are made), and it is never added to any other repository, above all not a private one;
  - if it must be a member, the organisation's **base permission is "No permission" or "Read"** (checked in the organisation's member privileges; a base above Read would give it write on every repository);
  - the job **checks this on every start** and refuses to run otherwise: `GET /user` names the account; `GET /repos/morndo/morndo` shows `permissions.push` false and `permissions.admin` false; `GET /user/repos?visibility=private` is empty.
- **Environments it can approve:** only `publish` and `promote`; the account is not listed as a reviewer anywhere else, so a leaked token cannot approve a `release` (key use) job.
- **What the token is used for:** every authenticated read and the one review call: listing waiting runs, a run's pending deployments, downloading the run's artifacts (an artifact download needs a token even for a public repository), and the `POST`. Authenticated reads have a limit of 5,000 an hour, so a 60-second poll is well inside it.
- **What a leak allows:** approving or rejecting any pending `publish` or `promote` deployment of `morndo/morndo` runs on `main`, posting comments as the account, and reading what the account reads (public repositories only, by the checks above). It cannot push, merge, change settings, or read a private repository. The worst case is approving the publication or promotion of a release the owner already approved for signing, which is a commit on `main` that took an owner-merged change; the environments allow only `main` (deployment branches), Prevent self-review stays on, and the key use stays behind the owner's own tap.
- **Binding an approval to what was evaluated:** the `POST` names one `run_id` and the `environment_ids` read from **that run's own pending list**. Immediately before it, the job reads the run again and compares `head_sha`, `run_attempt`, the workflow and the environment ids with what it evaluated; any difference means no call, and the run is evaluated again. It never calls the endpoint for a run it did not evaluate.
- **Storage:** a file, mode 0600, outside every repository and every lane's working folder (`~/.config/morndo/verifier.token`), created by the owner. The job reads it once at start into its own process environment (for its own HTTP client), never into an argument list, a log line, the evidence or a comment. A classic token should carry an expiry (90 days); the job refuses to start and tells the manager when it is within 7 days of expiry or the API answers 401.

## 5. Trigger

**Polling, every 60 seconds, with the token.** A webhook would need an inbound public endpoint, which the owner's machines do not have. The job lists `Release` runs with `status=waiting`, then each run's `pending_deployments`; a run is a candidate when it has a pending deployment for gate 2's environment `publish` (or gate 3's `promote`) and `current_user_can_approve` is true and its head is on `main`. It polls **both workflows**: the `Release` workflow for gate 2 and the promotion workflow for gate 3, and a waiting promotion run is evaluated like a waiting release run, for the version in its `run-name`. A ledger file of `(run_id, run_attempt, gate)` makes each evaluated once; a re-run of a rejected release is a new attempt and is evaluated again. A heartbeat to the manager every 15 minutes, and an alert when a pending release has waited 45 minutes without a verdict, so a release never hangs unseen.

## 6. One verification per gate

**Gate 2 (publish).**

1. Read the run: head sha, the `Release` workflow on `main`, the run's artifacts.
2. **The production signatures as they are**, with the verifier's own pinned trust and tools from the released version: `ssh-keygen -Y verify` of `manifest.json` and `install.sh` under the production release signers and the release namespace; the key set's root signature and a version at least the previous release's (so a rolled-back key set fails); the released copy of the repository's signing checker (`scripts/release/check-signing-release.sh`) run on the downloaded assets; `gh attestation verify` for every asset against this repository and the release workflow. A manifest byte is never changed.
3. **The archive against the manifest:** size and SHA-256 of every archive equal the manifest's, `files.json`'s digest equals the manifest's, and the archives equal what `assemble` produced.
4. **Commit checks:** the required checks (`ci`, `fleet`, `traces`, `gitleaks`) are `success` on the head sha; the sha is the one Release Please recorded; the release-record rule of D2.
5. **Fresh install on an isolated canary:** a throwaway control plane and node from the harness; the real signed `install.sh` is checked with `ssh-keygen` against the production signers, then run with `--signers <production signers>` and `MORNDO_RELEASE_BASE` pointing at a static server **inside** the machine that serves the downloaded assets.
6. The journeys of section 7 on that install, except the rollback.
7. Decide (section 9).

**Gate 3 (`promote`).** After publication and the Feed's `latest` entry: the canary installs the real **previous** release A from its published, signed `install.sh` (production signers, the public download), is set to channel `latest`, and the updater follows the **real Feed**: verify, stage, swap, probation, commit. Then the journeys, the rollback drill (section 8), and a second apply of B. Decide.

## 7. The journeys, without a human

All run inside the canary containers or through the harness's forwarders, on the canary's own data, never on the owner's hub.

| Journey | How, without a person | Passes when |
| --- | --- | --- |
| Health | `morndo update --status` and the units' own health from outside, as the harness's `checks.ts` does: hub, fleet and node each report B's commit, the hub and fleet schema numbers match the manifest's, the node is `online` | all three report B and `ready` within 2 minutes |
| A 20,000-character message from the web app, intact in a lane | The verifier's own headless browser (not the owner's), a virtual passkey for the sign-in (as `update-fleet.e2e.ts` does), the canary hub reached through one forwarder on its localhost origin. It types a message of 20,000 made-up characters in the composer; the canary's lane is a stand-in program that records what it receives. | the stand-in received exactly 20,000 characters, once, with the SHA-256 that was sent |
| A board task moves on a lane's DONE | A task is created with a canary agent token; the stand-in lane ends a turn with the DONE line naming it and posts the stop as the node's relay does | the task is in Review within a minute with no earlier move |
| A decision answered, delivered once | An Ask is filed through the agent door; the browser answers it; the stand-in lane's record is read | exactly one typed delivery |

The lane is a stand-in that records input, not a model session: the journeys check Morndo's delivery, not a model. The browser UI paths are still covered on the candidate's commit by CI's end-to-end suite; the verifier adds that the **released bytes** do the same.

## 8. The rollback drill (gate 3)

On the canary, after B has committed: (1) `morndo update --rollback --preview --json` is read and must name what a rollback would restore; (2) the rollback is run with the typed word the CLI requires; (3) hub, fleet and node report A, and both databases open (the schema floor: B's migrations must be additive, or a Backup must have been taken and restored); (4) the delivery journey passes on A; (5) B is applied again and commits. A failing step blocks. A migration that raises the floor is a **warning** in the evidence ("restore from Backup needed on rollback"), a block only if the restore does not bring the data back.

## 9. What blocks, what warns, and the line between a reject and a verifier failure

- **Reject (a block), naming the item:** a required check not `success`; a signature, key-set, size, hash, digest or attestation check failing; a journey failing; a journey that **did not run**; the journey list empty or shorter than the plan's; a failed rollback drill; the release-record check not passing. **That check blocks until the owner has chosen the rule (D2): while no rule is configured its result is `fail: no rule set`, so the verifier never approves a release on a check that did not pass.**
- **Warn, in the evidence:** a migration that raises the schema floor; a protocol range that drops; a journey that passed only on its one allowed retry; a duration far above the previous release's.
- **The line:** once the canary has **booted and the item has started**, anything that goes wrong, including a timeout, is the candidate's failure and **rejects**. When the verifier cannot get that far (the Docker daemon is down, the disk is full, an artifact will not download, GitHub answers 5xx or 401, the canary does not boot before the first item starts) it is a **verifier failure: it neither approves nor rejects**, leaves the deployment pending and alerts the manager. **It is retried**: on the next polls, up to three attempts five minutes apart; after the third failure, or when the deployment has waited 45 minutes, the alert says a person is needed, and the owner approves or rejects by hand in GitHub. A hang ends there, never in an automatic approval or rejection.
- **Approval is a conjunction over the planned list, never over what happened to run:** the verdict is `approved` only when every item of the plan has a recorded pass; an item with no record is a failure.

## 10. Evidence, approval, and telling the owner

- The evidence is a JSON document: the run id and attempt, the head sha, each item with name, result, measured value and time, the artifact digests, the canary image and harness commit, and the verifier's own version, stored on the PC (`~/.local/share/morndo-verifier/evidence/<run>.json`).
- **The approval carries it:** the `comment` of the `POST` holds one line per item (name, result, measure) and the SHA-256 of the full document, so the review record in the run's history is the evidence list. A rejection's comment names the failing item and its measure.
- **After each release** the verifier posts a short report to the manager (a board comment and a file under the manager's reports), which the daily digest relays to the owner: the version, what passed, any warning, and the run's link.

## 11. Structure and the tests that define done

A new app `apps/release-verifier`, in the repository's layers: **domain** (Candidate, Plan, Journey, Evidence, Verdict: a verdict is approved only when every item of the plan has a pass), **application** (the verification service over ports: `Releases` (GitHub reads and the review call), `Canary` (build, install, run a journey), `Evidence`, `Clock`), **adapters** (a GitHub REST adapter, a Docker canary reusing `e2e/update-vm`, a file evidence store). No token, process or Docker call in the domain.

Named tests (unit tests against a fake GitHub server and a fake canary, written red first):

- `missing canary health rejects`
- `approval carries the evidence list`
- `an empty journey list never approves`
- `a journey that did not run counts as failed`
- `a journey that times out after it started rejects`
- `a canary that cannot boot neither approves nor rejects`
- `a verifier failure leaves the deployment pending and alerts`
- `a red required check rejects and names it`
- `a failing journey rejects and names the journey`
- `a failed rollback drill rejects`
- `a changed manifest byte rejects` and `a signature by another key rejects`
- `a key set below the previous release's minimum version rejects`
- `an archive whose hash differs from the manifest rejects`
- `the approval names the run and environment it evaluated, and re-reads head sha and attempt first`
- `a run whose head sha changed between evaluation and approval is not approved`
- `a pending deployment for another environment, or not on main, is ignored`
- `a waiting promotion run is evaluated through gate 3, for the version in its run-name`
- `a promotion run whose version differs from the one evaluated is not approved`
- `the approval comment names the feed use it authorizes, and that version is the one that was evaluated`
- `the feed-signing jobs run only on main: a workflow_dispatch of feed.yml on any other ref cannot reach the feed environment` (a workflow test reads each feed-signing job's condition)
- `the verifier refuses to start unless release, publish, promote and feed are limited to main in their deployment-branch settings` (against a fake GitHub; the settings read is confirmed with the token in the spike)
- `the same run and attempt is evaluated once`
- `the verifier refuses to start when its account can push, or can see a private repository`
- `the token never appears in the evidence, the comment, a log line or an argument list` (negative control: a build that logs it must fail this)
- `with no release-record rule set the verifier never approves`
- `a first-parent commit with no pull request fails the record check`
- `a merge whose second parent differs from the verdict's head sha fails the record check`
- `a squash or rebase merge fails the record check`
- `a pull request without a release record rejects`
- `the verifier account is not a reviewer of release: the start-up check lists the environments it can review and refuses any other than publish and promote`
- one real canary run on the PC for the first release, with its evidence kept for review.

**Done:** one real release approved by the verifier at gate 2 and again at gate 3, each with its evidence in the approval, rolled out to the control plane, then the other nodes (the dependency in section 12), and the owner told.

## 12. The release tool used so far, and the move onto the updater

- **The release tool used for the bootstrap, and its per-machine step on the third machine, are not involved in C5.** C5 never touches a real node: its canary is isolated. The owner's hold on a new release through that route stands, and that step stays uninstalled; C5 uses the updater.
- **The rollout after the approvals is the updater's job, and the installs are not on it yet.** The three real machines run a release made by that tool, not an updater installation. "Rolled out to the control plane, then the nodes" therefore needs the move of those installs onto the updater (a later step of the plan). **Until then C5's done is: approved at gates 2 and 3 with evidence**, and the rollout continues with the release tool as in the bootstrap plan. After the move, the same approvals release through the Feed and the nodes follow the control plane.
- **The order stays, with that dependency stated:** the verifier, then the defaults and the first release approved by it, then the move of the installs onto the updater.

## 13. Size, and what the owner decides

| Phase | Work | Size |
| --- | --- | --- |
| 1 | domain and application, fake adapters, the named unit tests | 3 days |
| 2 | the GitHub adapter and the poll loop, token handling and the start-up account check, the ledger | 3 days |
| 3 | the workflow change (environments `publish` on `ship` and `promote` on the promotion workflow of design §9.5; a short retention for the signed artifacts and a clean-up job when `publish` is rejected) and the environment settings | 4 days |
| 4 | the Docker canary reusing `e2e/update-vm`: the real-asset install (gate 2) and the real-Feed update (gate 3) | 5 days |
| 5 | the four journeys and the rollback drill in the canary | 4 days |
| 6 | the unit, timer, alerts, the first real release | 2 days |

About four to five weeks of lane time, each phase reviewed before the next; the first real release is the proof.

**Spike before any build (10 minutes, needs the owner's account and token).** In a scratch public repository that is not `morndo/morndo`, give the verifier account the Read role and try to list it as a required reviewer of a test environment; then start a run that waits on that environment and approve it through the API with the classic token. The pages read do not say whether a Read-role user can be listed or can approve, and the whole token design rests on it; if it fails, the design changes before a line is written.

**Decisions for the owner** (each with the answer recommended)

- **D1. Who approves gate 1 (the key use)?** Recommended: **the owner keeps it**; the verifier approves `publish` and `promote` only, and is a reviewer of no other environment. The alternative lets a leaked token use the release key on any commit already on `main`.
- **D2. The release-record rule.** G-9 says every check passed, so a pull request without a record **blocks**, and until a rule is chosen the check fails, so no release is approved. The repository has one human account and reviews are made by agents under it, so GitHub shows no independent review, and the manager's ledger cannot be the evidence: lanes that build can write it. A file or a helper cannot tell a reviewer lane from a builder lane when both run as the same Linux user, so the record's authenticity has to come from **who holds a key**. Recommended: **(A) the independent review runs as its own Linux user, with its own model account and its own signing key (`ssh-keygen -Y sign`, a namespace of its own, the key mode 0600, unreadable by builder lanes); it signs one verdict per pull request and head sha (PR number, head sha, pass or fail, time) and appends it to a file; the verifier, under its own user, checks each signature against the reviewer's public key pinned in its own configuration and requires a pass for the final head sha of every pull request in the range.** A forged line fails the signature, so the file may be writable by anyone. **The range rule:** the verifier walks `main`'s first-parent history from the previous release to the head, and every commit on it must be the merge of a pull request whose signed verdict is for **the head sha that was merged**: a first-parent commit with **no pull request** (a direct push) fails the check; a merge commit whose second parent **differs from the verdict's head sha** (the branch moved after the review) fails it; a squash or rebase merge, which has no such parent, fails it (not supported). **Residual risk, stated plainly:** the reviewer is a model session, so a verdict is a model's judgement, and an instruction hidden in the pull request's text, diff or files could make it sign a pass. The signature proves who signed, not that the judgement was sound; the checks above bound it to one head sha, and the owner's own merge tap and gate 1 stay behind it. The cost is real: the reviewer's session stops being a lane of the node and becomes a separate user's, with its own login. Alternatives: (B) amend G-9 so this check only warns, the honest fallback if (A) is not wanted; (C) require approving GitHub reviews from a second account.
- **D3. Workflow and settings:** environments `publish` (on `ship`) and `promote` (on the promotion workflow), each with the verifier account as reviewer, deployment branches `main`, Prevent self-review; `feed` keeps no reviewers (as designed) **but its deployment branches are limited to `main`**, because `feed.yml` can be started by hand (`workflow_dispatch`) and without that rule a workflow run from any other branch could reach the feed key; the same rule on `release`, `publish` and `promote`; the feed-signing jobs also carry `if: github.ref == 'refs/heads/main'` as a second layer; with the version bindings and tests of section 2; a short retention for the signed artifacts and a clean-up job on rejection. Recommended: yes, as a reviewed pull request and owner-side settings.
- **D4. The account, the users and the runner:** the verifier account an outside collaborator with the Read role on this repository only (or an organisation member with the organisation's base permission at Read or none); a classic token with an expiry, created by the owner; **a Linux user of its own for the verifier job, and, if D2 is (A), one for the independent reviewer**; the build PC as the runner with the heavy-job lock. Recommended: yes to all.
- **D5. Channel of the owner's own machines.** Default kept: **`latest`** (the decision of 2026-10-21; `docs/domain.md` still says `stable`, which would then be updated). Trade-off: he gets B after gate 2 only, and a gate-3 failure can only alert him in the nodes' 30-minute soak, not move machines already on B. Recommended: **keep `latest` for now, and revisit after the first two releases**; moving to `stable` buys the gate-3 protection and costs seven days of delay per release. The seven days stay a separate rule the verifier does not shorten.
- **D6. Who reviews the environment `feed`.** Recommended: **nobody, as designed** (the key stays online for the weekly re-sign), with each verifier approval explicitly naming and binding the one feed use it authorizes (section 2). Alternative: the owner reviews `feed`, one more tap per release and per promotion, and the weekly re-sign then waits for him too unless it moves to its own environment.

## Sources

- GitHub REST, review pending deployments: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#review-pending-deployments-for-a-workflow-run (read 2026-10-23).
- GitHub, managing environments (required reviewers, Prevent self-review, deployment branches): https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments (read 2026-10-23).
- In this repository at `4a0274cf`: `docs/design/updates/README.md` §4.2 (RL1), §9.4, §9.5; `.github/workflows/release.yml` (`sign` line 314, `publish`, `ship`); `install.sh` (`--signers`, `MORNDO_RELEASE_BASE`); `packages/domain/src/releases.ts` (`skew`); `apps/updater/src/cli.ts`; `e2e/update.e2e.ts`, `e2e/update-fleet.e2e.ts`, `e2e/update-vm/`.
