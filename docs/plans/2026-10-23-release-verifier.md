# The release verifier: a proposal (C5), for review before any code

Status: a proposal. Nothing in it is built, installed or run. Facts say where they were read; the GitHub pages were read on 2026-10-23.

## 1. What is asked, and three facts that change the plan

The owner has granted a **release verifier**, a GitHub account of its own, the right to approve Morndo releases without him once it has installed the release on a canary and every check passed. It attaches the evidence to the approval, rejects the release when a check fails, and the owner is told after each release.

What the repository already has:

- The gate is real. `.github/workflows/release.yml`: the `sign` job runs in the GitHub environment `release` (line 314) and waits there until a required reviewer approves; only then does it get the release key. `docs/design/updates/README.md` §9.4 says so, and so does its threat table.
- Two end-to-end harnesses already install a real release the way `install.sh` does, inside throwaway systemd machines in Docker: `e2e/update.e2e.ts` (one machine) and `e2e/update-fleet.e2e.ts` (a control plane and a node, a browser journey with a virtual passkey, a rollback, a halted Rollout). Both follow rules the verifier keeps: no host mounts, no host network, no published ports, only labelled containers touched, everything removed on every way out.
- The updater has `morndo update --check`, `--rollback` (with a preview), `recover`, and a probation that judges health before an Update commits (`apps/updater/src/cli.ts`).

Three facts in the way of the plan as first written:

1. **The release key signs after the approval, so a signed candidate cannot exist when the verifier decides.** The updater installs only what a signed Feed and Manifest vouch for (invariant RL1). A candidate that is installed before the approval therefore cannot come from the real signed release.
2. **A node never updates above its control plane** (`skew()` in `packages/domain/src/releases.ts`: `node_ahead`). "The canary node first, then the others" cannot be the order on the real fleet: the control plane goes first, then the nodes. A real node cannot be the canary.
3. **The third machine also runs unrelated production workloads that Morndo must not touch.** Containers or services of ours next to them are not acceptable, and a node there is last in the rollout in any case.

So the canary is **an isolated copy, not a real node**: a throwaway two-machine fleet from the existing harness, running the candidate's own bytes. Section 4 says how it is trusted.

## 2. Where it runs, and as whom

- **A job, not an LLM lane.** A plain program started by a systemd user timer. It cannot be talked into an approval, costs no model time, and its decision is a function of the evidence. A model may be asked afterwards to explain a rejection, never to decide.
- **On the owner's build PC**, because the harnesses need Docker and the PC has it. Not on the control plane (it is the owner's main channel) and not on the third machine (fact 3). One heavy job at a time: the verifier takes the box's heavy-job lock and waits for it.
- **From a released version, never the candidate.** The verifier's code is the Morndo version already installed on the PC (the last release), so the candidate cannot change its own verification. The candidate runs only inside the canary containers.
- **As whom:** its own Linux user if the owner can create one (a one-time root step, in the open questions); until then the same user as the lanes, with the limits in §3 doing the real work. A job started by a lane that built the release is refused: the verifier checks the run's actor and its own start were not by the same lane account (it reads the actor from the workflow run).

## 3. The token

- **What the API needs** (GitHub REST, "Review pending deployments for a workflow run", `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments` with `environment_ids`, `state` `approved` or `rejected`, and `comment`): the caller must be a required reviewer with read access, and "OAuth app tokens and personal access tokens (classic) need the repo scope". The page lists no fine-grained token or GitHub App permission for it, so the only documented route is a classic token. That is broad, so the limits are on the **account**, not the token: the verifier account has **read access only** to `morndo/morndo` (the repository is public), no write, no admin, no other repository; it is a required reviewer of `release` and of nothing else (up to 6 reviewers may be listed, and one approval is enough).
- **The environment is limited to `main`** (deployment branches: selected branches). A stolen token cannot approve a signing job for a branch; it could approve one for a commit on `main`, and `main` takes only owner-merged changes. That is the stated limit of this design, the same one the design names for a taken-over maintainer account (§ threats: "can approve the gate").
- **Storage:** a file, mode 0600, outside every repository and every lane's working folder (`~/.config/morndo/verifier.token`), created by the owner. The job reads it once at start into its own process environment (`GH_TOKEN` for its own `gh` or HTTP client), never into an argument list, a log line, the evidence or a comment. A negative-control test (§8) fails if the token's value appears in any of them. Rotation: a classic token with an expiry (90 days), renewed by the owner; the job refuses to start, and says so to the manager, when it is within 7 days of expiry or the API answers 401.
- **Use:** two calls only, `GET .../pending_deployments` (is a `release` deployment waiting, and `current_user_can_approve`) and the one `POST`. Everything else (downloads, run and PR reads) is unauthenticated public reads, so the token is touched as seldom as possible.
- **Prevent self-review** is turned on for `release`, so whoever triggered a run (the account that merged to `main`) can never approve it; the verifier account never triggers a release.

## 4. Trigger

**Polling, every 60 seconds, from the PC.** A webhook would need an inbound public endpoint, which the owner's machines do not have. The job asks `GET /repos/morndo/morndo/actions/runs?status=waiting` for the `Release` workflow, then each run's `pending_deployments`; a run with a pending `release` environment whose `current_user_can_approve` is true and whose head is on `main` is a candidate. It keeps a ledger of run ids (a file) and evaluates each once; a rejected run that the owner re-runs is a new run id. A heartbeat to the manager every 15 minutes, and an alert when a pending release has waited 45 minutes without a verdict, so a release never hangs unseen.

## 5. One verification, step by step

1. **Read the run:** the head sha, that the run is the `Release` workflow on `main`, that `assemble` finished, and the build artifacts it uploaded (public run artifacts, downloaded with `gh run download`). The artifact digests GitHub reports are recorded.
2. **Checks on the commit** (block on any failure): the required checks (`ci`, `fleet`, `traces`, `gitleaks`) are `success` on this exact sha; the release commit is the one Release Please recorded.
3. **Review records** (a policy question, §11 Q3): every pull request in the range since the last release has a review record. **Default for the first release: warn, and list the pull requests without one**; the owner's merges are made by his own tap, which leaves no approving review on GitHub.
4. **Build the canary** from the harness: two machines at the **previous release A** (the last published one, installed with its own `install.sh` the way a user would), a control plane and a node.
5. **Offer the candidate B to the canary.** The canary has its **own throwaway key set and feed** (the harness's `feed-server.ts` already does this); the candidate's archives from step 1 are re-signed with the canary's key and offered on that feed. The canary's updater then applies B by its normal path (verify, stage, swap, probation). **Nothing about production trust changes**: the production key set is not touched, and no machine of the owner's runs an unsigned or canary-signed build. Before the canary applies B, the verifier compares the archive's `files.json` digest with the one the `sign` job will sign (the `assemble` output), so what the canary runs is byte for byte what will be released.
6. **Run the journeys** (§6) against the canary B. **Rollback drill** (§7).
7. **Decide.** Every item passed: approve. Any item failed or timed out: reject, naming the item. A verifier that itself fails (no Docker, no disk, a crash) **neither approves nor rejects**: it leaves the deployment pending and alerts the manager.

## 6. The journeys, without a human

All run inside the canary containers or through the harness's forwarders, on its own data, never on the owner's hub.

| Journey | How, without a person | Passes when |
| --- | --- | --- |
| Health | `morndo update --status` and the units' own health from outside, as the harness's checks do (`checks.ts`): hub, fleet and node each report B's commit, hub schema and fleet schema match the Manifest, the node is `online` | all three report B and `ready` within 2 minutes |
| A 20,000-character message from the web app, arriving intact in a lane | A headless browser of the verifier's own (not the owner's), a virtual passkey for the sign-in (what `update-fleet.e2e.ts` does), the canary hub reached through one forwarder on its localhost origin. It types a message of 20,000 made-up characters in the composer; the canary's lane is a stand-in program that records what it receives. | the stand-in received exactly 20,000 characters, once, with the same SHA-256 as sent |
| A board task moves on a lane's DONE | A task is created with a canary agent token; the stand-in lane ends a turn with the DONE line naming it; the stand-in posts the stop the way the node's relay does | the task is in Review within a minute and no earlier move happened |
| A decision answered, delivered once | An Ask is filed through the agent door; the browser answers it; the stand-in lane's record is read | exactly one typed delivery |
| Rollback drill | §7 | passes there |

The lane in the canary is a stand-in that records input, not a real model session: the journeys check Morndo's delivery, not a model. The real browser UI paths are still covered, on the candidate's commit, by CI's end-to-end suite; the verifier adds that the **released bytes** do the same.

## 7. The rollback drill

On the canary, after B has committed: (1) `morndo update --rollback --preview --json` is read and must name what a rollback would restore; (2) the rollback is run with the typed word the CLI requires; (3) the canary's hub, fleet and node report A, and both databases open (the schema floor: every migration in B must be additive, or a Backup must have been taken and restored); (4) A's lane journey from §6 still passes; (5) B is applied again and commits, which proves the Update is repeatable. A step that fails is a block. A migration that raises the floor is a **warning** in the evidence ("restore from Backup needed on rollback"), a block only if the drill's restore does not bring the data back.

## 8. Evidence, approval, and telling the owner

- The evidence is a JSON document: the run id, the head sha, each item with its name, result, measured value and time, the artifact digests, the canary's image and harness commit, and the verifier's own version. It is stored on the PC (`~/.local/share/morndo-verifier/evidence/<run>.json`).
- **The approval carries it:** the `comment` of the `POST` holds the item list (one line each: name, result, measure) and the SHA-256 of the full document, so the review record in the run's history is the evidence list. A rejection's comment names the failing item and its measure.
- **After each release**, the verifier posts a short report to the manager (a board comment and a file under the manager's reports), which the daily digest relays to the owner: the version, what passed, any warning, and the run's link.

## 9. Structure and the tests that define done

A new app `apps/release-verifier`, in the repository's layers: **domain** (Candidate, Journey, Evidence, Verdict: a candidate is approved only when every Journey passed, never otherwise), **application** (the verification service over ports: `Releases` (GitHub reads and the review call), `Canary` (build, offer, run a journey), `Evidence`, `Clock`), **adapters** (a GitHub REST adapter, a Docker canary that reuses `e2e/update-vm`, a file evidence store). No token, no process, no Docker call in the domain.

Named tests (unit tests with a fake GitHub server and a fake canary, written red first):

- `missing canary health rejects`
- `approval carries the evidence list`
- `a red required check rejects and names it`
- `a failing journey rejects and names the journey`
- `a failed rollback drill rejects`
- `a verifier failure neither approves nor rejects`
- `a pending deployment for another environment, or not on main, is ignored`
- `the same run is evaluated once`
- `a run the verifier started itself is refused`
- `the token never appears in the evidence, the comment, a log line or an argument list` (negative control: a build that logs it must make this fail)
- `the canary is offered files byte-identical to the assemble output, or rejects`
- `a pull request without a review record is listed as a warning`
- one integration run of the real canary on the PC for the first release, with the evidence kept for review.

**Done:** one real release approved by the verifier with its evidence in the approval, then rolled out to the control plane, then the other nodes (with the dependency in §10), and the owner told.

## 10. The release tool used so far, and the move onto the updater

- **The release tool used for the bootstrap, and its per-machine step on the third machine, are not involved in C5.** C5 never touches a real node: its canary is isolated. The owner's hold on a new release through that route stands, and that step stays uninstalled; C5 uses the updater.
- **The rollout after the approval is the updater's job, and the installs are not on it yet.** The three real machines run a release made by that tool, not an updater installation. "Rolled out to the control plane, then the nodes" therefore needs the move of those installs onto the updater (a later step of the plan). **Until then C5's done is: approved by the verifier, with evidence**, and the rollout continues with the release tool as in the bootstrap plan. After the move, the same approval releases through the Feed and the nodes follow the control plane.
- **The order stays, with that dependency stated:** the verifier, then the defaults and the first release approved by it, then the move of the installs onto the updater.

## 11. Size, and what the owner decides

| Phase | Work | Size |
| --- | --- | --- |
| 1 | domain and application, fake adapters, the named unit tests | 3 days |
| 2 | the GitHub adapter and the poll loop, token handling, the ledger | 2 days |
| 3 | the Docker canary reusing `e2e/update-vm` and the offer-on-its-own-feed step | 4 to 5 days |
| 4 | the four journeys and the rollback drill in the canary | 4 days |
| 5 | the unit, timer, alerts, the first real release | 2 days |

About three weeks of lane time, each phase reviewed before the next; the first real release is the proof.

**Questions for the owner**

1. **The canary is an isolated copy, not a real node**, because of the signing order and the node-never-above-control-plane rule. Is that acceptable for the grant's "canary"? (The alternative, a real node as the canary after signing, makes the verifier approve promotion instead of signing, and needs the control plane to be the first machine updated.)
2. **A classic token with the `repo` scope is the only documented way to approve.** It is bounded by giving the verifier account read access only, limiting `release` to `main`, and turning on Prevent self-review. Acceptable? Does the owner create the account's token and the Linux user for it?
3. **What counts as a review record?** Owner merges leave no approving review. Default proposed: warn and list for the first release, then decide whether a pull request needs a review comment from the review pipeline.
4. **Runner:** the build PC, with the heavy-job lock, or another machine with Docker?
5. **The wait for `stable`** (7 days on `latest`, §9.5) is a separate gate this verifier does not touch; keep it?

## Sources

- GitHub REST, review pending deployments: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28#review-pending-deployments-for-a-workflow-run (read 2026-10-23).
- GitHub, managing environments (required reviewers, Prevent self-review, deployment branches): https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments (read 2026-10-23).
- In this repository at `4a0274cf`: `docs/design/updates/README.md` §4.2, §9.4, §9.5; `.github/workflows/release.yml`; `packages/domain/src/releases.ts` (`skew`); `apps/updater/src/cli.ts`; `e2e/update.e2e.ts`, `e2e/update-fleet.e2e.ts`, `e2e/update-vm/`.
