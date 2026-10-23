# The release verifier: a proposal (C5), round 2, for review before any code

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
| 1 `release` (exists) | the `sign` job, before the release key is used | CI, the review records, the build artifacts the run made. Not signatures. | **Default: the owner's tap stays** (decision D1). |
| 2 `publish` (new: the `ship` job gets an environment) | publishing the draft, the irreversible step | the **production signatures as they are**, and a **fresh install of the real signed release** on an isolated canary under production trust, with the journeys | **verifier approves or rejects** |
| 3 promotion to `stable` (the weekly design §9.5 workflow, to be built, with its approval job in `release`) | the Release being offered to default users | an **update from the real released A to B through the real Feed**, under production trust, then a rollback drill | **verifier approves or rejects**; a reject withdraws B from `latest` |

**Reading of the grant.** "Approve a release once it has installed it on the canary" can only mean a gate after signing, because only then is there something to install. Gates 2 and 3 are that. Gate 1 is where the release key is used: signed assets are valid under the production key for as long as they exist, and a run's artifacts are downloadable, so a bad candidate signed at gate 1 would leave a validly signed bad manifest lying around even if gate 2 then rejects it. That is why the default keeps gate 1 with the owner (one tap per release, at the moment the key is used); D1 asks whether to change it.

**What each gate cannot test, and why**

- Gate 2 cannot test the Feed chain (the feed key signs only after publication), the hosting at github.com (the canary is served the assets from inside its own machine, with the manifest unchanged), an *update* from A to B (no Feed yet), or a rollback (a fresh install has no previous version). It tests every signature of the release key chain as shipped, the archive against the manifest, the install path, and the journeys on the real bytes.
- Gate 3 tests the whole chain end to end, including the Feed, because by then the release is published and on `latest`. What no pre-rollout check can cover is the owner's own machines: their data, sizes and hardware. The updater's own probation, Backup and automatic rollback cover that, and the owner's machines follow `stable`, so they see B only after gate 3 (decision D5).

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
- **What the token is used for:** every authenticated read and the one review call: listing waiting runs, a run's pending deployments, downloading the run's artifacts (an artifact download needs a token even for a public repository), and the `POST`. Authenticated reads have a limit of 5,000 an hour, so a 60-second poll is well inside it.
- **What a leak allows:** approving or rejecting any pending `release` or `publish` deployment of `morndo/morndo` runs on `main`, posting comments as the account, and reading what the account reads (public repositories only, by the checks above). It cannot push, merge, change settings, or read a private repository. The worst case is approving a signing or publishing job for a commit that is already on `main`, which takes an owner-merged change; the environments allow only `main` (deployment branches), and Prevent self-review stays on.
- **Binding an approval to what was evaluated:** the `POST` names one `run_id` and the `environment_ids` read from **that run's own pending list**. Immediately before it, the job reads the run again and compares `head_sha`, `run_attempt`, the workflow and the environment ids with what it evaluated; any difference means no call, and the run is evaluated again. It never calls the endpoint for a run it did not evaluate.
- **Storage:** a file, mode 0600, outside every repository and every lane's working folder (`~/.config/morndo/verifier.token`), created by the owner. The job reads it once at start into its own process environment (for its own HTTP client), never into an argument list, a log line, the evidence or a comment. A classic token should carry an expiry (90 days); the job refuses to start and tells the manager when it is within 7 days of expiry or the API answers 401.

## 5. Trigger

**Polling, every 60 seconds, with the token.** A webhook would need an inbound public endpoint, which the owner's machines do not have. The job lists `Release` runs with `status=waiting`, then each run's `pending_deployments`; a run is a candidate when it has a pending deployment for gate 2's environment `publish` (or gate 3's approval job) and `current_user_can_approve` is true and its head is on `main`. A ledger file of `(run_id, run_attempt, gate)` makes each evaluated once; a re-run of a rejected release is a new attempt and is evaluated again. A heartbeat to the manager every 15 minutes, and an alert when a pending release has waited 45 minutes without a verdict, so a release never hangs unseen.

## 6. One verification per gate

**Gate 2 (publish).**

1. Read the run: head sha, the `Release` workflow on `main`, the run's artifacts.
2. **The production signatures as they are**, with the verifier's own pinned trust and tools from the released version: `ssh-keygen -Y verify` of `manifest.json` and `install.sh` under the production release signers and the release namespace; the key set's root signature and a version at least the previous release's (so a rolled-back key set fails); the released copy of the repository's signing checker (`scripts/release/check-signing-release.sh`) run on the downloaded assets; `gh attestation verify` for every asset against this repository and the release workflow. A manifest byte is never changed.
3. **The archive against the manifest:** size and SHA-256 of every archive equal the manifest's, `files.json`'s digest equals the manifest's, and the archives equal what `assemble` produced.
4. **Commit checks:** the required checks (`ci`, `fleet`, `traces`, `gitleaks`) are `success` on the head sha; the sha is the one Release Please recorded; the release-record rule of D2.
5. **Fresh install on an isolated canary:** a throwaway control plane and node from the harness; the real signed `install.sh` is checked with `ssh-keygen` against the production signers, then run with `--signers <production signers>` and `MORNDO_RELEASE_BASE` pointing at a static server **inside** the machine that serves the downloaded assets.
6. The journeys of section 7 on that install, except the rollback.
7. Decide (section 9).

**Gate 3 (promotion).** After publication and the Feed's `latest` entry: the canary installs the real **previous** release A from its published, signed `install.sh` (production signers, the public download), is set to channel `latest`, and the updater follows the **real Feed**: verify, stage, swap, probation, commit. Then the journeys, the rollback drill (section 8), and a second apply of B. Decide.

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

- **Reject (a block), naming the item:** a required check not `success`; a signature, key-set, size, hash, digest or attestation check failing; a journey failing; a journey that **did not run**; the journey list empty or shorter than the plan's; a failed rollback drill; the release-record rule failing (D2).
- **Warn, in the evidence:** a migration that raises the schema floor; a protocol range that drops; a journey that passed only on its one allowed retry; a duration far above the previous release's.
- **The line:** once the canary has **booted and the item has started**, anything that goes wrong, including a timeout, is the candidate's failure and **rejects**. When the verifier cannot get that far (the Docker daemon is down, the disk is full, an artifact will not download, GitHub answers 5xx or 401, the canary does not boot before the first item starts) it is a **verifier failure: it neither approves nor rejects**, leaves the deployment pending and alerts the manager.
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
- `the same run and attempt is evaluated once`
- `the verifier refuses to start when its account can push, or can see a private repository`
- `the token never appears in the evidence, the comment, a log line or an argument list` (negative control: a build that logs it must fail this)
- `a pull request without a release record rejects` (once D2 fixes the rule)
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
| 3 | the workflow change (an environment on `ship`; the promotion workflow of design §9.5 with its approval job) and the environment settings | 3 days |
| 4 | the Docker canary reusing `e2e/update-vm`: the real-asset install (gate 2) and the real-Feed update (gate 3) | 5 days |
| 5 | the four journeys and the rollback drill in the canary | 4 days |
| 6 | the unit, timer, alerts, the first real release | 2 days |

About four weeks of lane time, each phase reviewed before the next; the first real release is the proof.

**Decisions for the owner**

- **D1. Who approves gate 1 (the key use)?** Default proposed: the owner keeps it. The verifier approves gates 2 and 3. If the verifier is to approve gate 1 as well, it can only do so on checks that run before signing (CI, review records, the build artifacts), and a leaked token could then use the release key on any commit already on `main`.
- **D2. The release-record rule.** G-9 says every check passed, so a pull request without a record must block, not warn. But the repository has one human account, and reviews today are made by agents under it, so GitHub shows no independent review. A rule must be chosen: (A, recommended) the verifier, which runs on the owner's PC, reads the manager's ledger read-only and requires every pull request in the range to map to a ledger entry marked verified; (B) amend G-9 so this check is a warning; (C) require approving GitHub reviews from a second account. Until chosen, the check is not enforced and the evidence says so.
- **D3. Workflow and settings changes:** an environment `publish` on the `ship` job (reviewer: the verifier account; deployment branches: `main`; Prevent self-review), the same for `release`, and the promotion workflow of design §9.5. These are owner-side settings and a reviewed pull request.
- **D4. The account and the runner:** the verifier account as an outside collaborator with the Read role on this repository only (or an organisation member, with the organisation's base permission at Read or none), a classic token with an expiry created by the owner, a Linux user for the job if possible, and the build PC as the runner with the heavy-job lock.
- **D5. Channels and the soak:** the owner's machines follow `stable`, so gate 3 protects them; the seven days on `latest` before promotion (design §9.5) remain a separate rule the verifier does not shorten unless the owner says so.

## Sources

- GitHub REST, review pending deployments: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#review-pending-deployments-for-a-workflow-run (read 2026-10-23).
- GitHub, managing environments (required reviewers, Prevent self-review, deployment branches): https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments (read 2026-10-23).
- In this repository at `4a0274cf`: `docs/design/updates/README.md` §4.2 (RL1), §9.4, §9.5; `.github/workflows/release.yml` (`sign` line 314, `publish`, `ship`); `install.sh` (`--signers`, `MORNDO_RELEASE_BASE`); `packages/domain/src/releases.ts` (`skew`); `apps/updater/src/cli.ts`; `e2e/update.e2e.ts`, `e2e/update-fleet.e2e.ts`, `e2e/update-vm/`.
