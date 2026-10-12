# ADR-0025: A digest at the top of Home: since you last looked, with proof

- **Status:** Proposed, 2026-10-12. Design: [`docs/design/home-digest/README.md`](../design/home-digest/README.md). Design only; no product code. Building starts after the owner answers the design's section 10.
- **Issue:** [#33](https://github.com/morndo/morndo/issues/33).
- **Number:** 0019 to 0024 belong to other branches.
- **Builds on:** ADR-0006 (the desktop), ADR-0011 (the phone's away digest), ADR-0014 (lane events, the delivery queue), ADR-0015 (the board, agent tokens, a CLI first), ADR-0016 (Home), ADR-0017 (jobs), ADR-0018 (the secret store), ADR-0023 (decision briefs, proposed).
- **Rules:** V1 to V4, E6, B1 to B8, O7, C1, C5 and C7 in `docs/domain.md`; new DG1 to DG12 in the design, section 3.6, which go into `docs/domain.md` with the first PR.
- **Sources:** [S1] to [S28] in the design, section 11, read 2026-10-12.

## Context

1. **Home shows usage, not what happened.** To learn what was merged, shipped or finished, what is stuck and what waits for them, the principal asks the manager, and the answer comes from memory. On the system Morndo is learning from, those questions came 47 times in one week (a rough keyword count).
2. **A claim looks like a fact.** The board's done is the manager's acceptance of a lane's word (B8). A lane's STATUS: DONE is its own word (C5). Neither says whether anyone checked.
3. **The vocabulary exists; the records don't.** The manager there already grades its tasks in four levels (unverified, evidence-checked, reviewed, live-verified) and keeps verdicts bound to a PR's head commit that a new push voids. But its evidence is free text (2,287 strings, no link a program can open), 18 tasks were closed while unverified, and its decision log uses two names for the same fields. The hub has none of it: Verification (V1 to V4) is in the domain and not built.
4. **Lane events last 7 days** in the fleet (ADR-0014). A weekly view needs its own copy.
5. **The research agrees on the shape** (design, section 2): make the checker someone other than the doer [S9, S14]; grade trust by who produced the evidence [S15, S16]; show instability beside throughput, with no targets and no ranking [S11]; and show how reliable each level has been, so reliance can be calibrated rather than felt [S17, S18].

## Decision

1. **A Digest read model in the domain** (`packages/domain/src/digest.ts`, pure): items built only from records with an Actor or a producer (DG1). One item per root subject: a task with its changes and their deploys, or a change, deploy, ask, decision, lane or job on its own (DG5). Eight sections in attention order: Needs you, Decided for you, Failed or rolled back, Stale or stuck, Shipped, Merged, Done, Opened or pushed.
2. **Four levels and failed, by who checked, on the current revision:** claimed, checked (CI, tests or a deploy status from someone other than the claimants), reviewed (a fresh reviewer), verified live (a check where it runs). A claimant (a lane that claimed or linked the subject, or was ever assigned a linked task) never raises a level with its own evidence (DG2); on a change nobody claimed, only the forge's, the manager's and the principal's evidence count. Any failing evidence, revert, rollback or reopen shows failed while its cause is current (DG3). A new push voids earlier evidence unless the patch id is the same (DG4). "Verified live" names one passing live check; the domain's Verdict, which needs every Check of a Done-means (V1), is not shown until Done-means exists.
3. **The first slice of Verification in the hub:** `claims`, `evidence` and `links` (the only way a task groups its changes) records, filed under agent tokens with a new `morndo-verify` command beside `morndo-board` (claim, link, record, review, live, deploy), and evidence the hub produces itself from the forge (check runs, deployment statuses). A `decision_log` for "decided for you", filed only by the manager's token through `morndo-decide log` (ADR-0023's command), each with why, how to undo it and whether it can be.
4. **A forge adapter behind a port** (GitHub first): conditional polling of the watched repos for pull requests, check runs, deployments and default-branch commits, with a read-only token from the secret store. Webhooks later, when the hub has a reachable address.
5. **Stale and stuck are computed** from the board, Observation, jobs, the delivery queue and a new typed fleet operation, `lane.sideEffects` (last commit, working-tree hash, commits ahead, head), with limits from config: busy 45 minutes with no side effect, blocked 4 hours, in review 8 hours, in progress 24 hours with nothing happening, a queued job 60 minutes, a delivery in doubt at once (DG10).
6. **One mark per principal on the hub,** a sequence number, not a time, with the items seen above it. "Mark all seen" covers the lines the device displayed and the folded Opened or pushed section, never items behind "N more"; the mark moves up to the first item not covered. Opening an item marks that item seen. Nothing else moves it. Shared by every Endpoint, forward only (DG7, DG8). Needs you and Stale or stuck are live state and don't leave by being seen (DG6).
7. **A weekly view from the same records,** the current week and the six before it: shipped, merged, reverted, done, time to done, claims and claims that later failed (within 14 days: a failed check, a revert, a rollback or a reopen; DG12), failed deploys, recovery time, and stuck flags that cleared with nobody acting (a false-alarm count). Inputs first, instability beside throughput. A table of how often each level later failed, and the same by engine and model, never by lane. A week is provisional for 14 days, then frozen with the definitions' version.
8. **The digest grants and starts nothing** (DG11). A veto is a Command that sends the manager a message naming the decision.
9. **Order:** domain; hub records, routes and commands; the forge adapter and the side-effect probe; Home; importers for the existing verdict ledger and decision log (optional, read-only); the prompt blocks. Tests and checks in the design, section 9.

### Where things will live

| Piece | Where |
|---|---|
| Items, levels, placement, the mark, stale, the week; DG1 to DG12 | `packages/domain/src/digest.ts`, `packages/domain/src/verification.ts` |
| The wire: items, the `digest` frame, claim and evidence bodies | `packages/protocol/src/digest.ts`, `packages/protocol/src/verification.ts` |
| The projection, the stores, the routes | `apps/hub/src/application/digest-service.ts`, `verification-service.ts`; `/api/digest`, `/api/digest/seen`, `/api/digest/weeks`, `/api/agent/claims`, `/api/agent/evidence`, `/api/agent/links`, `/api/agent/decided` in `apps/hub/src/adapters/http.ts` |
| The forge adapter, the importers | `apps/hub/src/adapters/forge-github.ts`, `apps/hub/src/adapters/import-verdicts.ts`, `import-decisions.ts` |
| The side-effect probe | `lane.sideEffects` in `apps/node-agent/src/ops/` |
| The commands and their prompt blocks | `apps/board-cli/src/verify.ts`, `apps/board-cli/src/prompt.ts`; `docs/agents/verify.md` |
| Home | `apps/web/src/lib/desktop/HomeView.svelte`, `DigestSection.svelte`, `DigestLine.svelte`, `WeeklyView.svelte`, `digest.ts` |
| The checks | `packages/domain/test/digest.test.ts`, `apps/hub/test/digest.test.ts`, `apps/board-cli/test/verify.test.ts`, `e2e/home-digest.e2e.ts` |

## Alternatives

| Option | Verdict |
|---|---|
| **The manager writes a daily summary for Home** | Rejected. A summary is a claim about claims; its counts drift from the records and nobody can check them (DG1, DG9). |
| **The lane's own STATUS line and its links as the proof** | Rejected. Evidence the claimant produced is not evidence (V1). It shows, dashed, as part of the claim. |
| **One flat list, newest first** | Rejected. A failure between twenty merges is the line a reader misses [S18, S21]. |
| **The issue's order: progress first, problems last** | Not chosen; it is the design's open question Q1. |
| **A time as the mark** | Rejected. Evidence arrives after the event it is about, and node clocks differ (FL13); a sequence number makes "new" exact. |
| **Mark seen when Home is opened** | Rejected. On screen is not read; the digest would empty itself in passing. |
| **Read the fleet's lane events for the weekly view** | Rejected as the only store: 7 days. The hub keeps its own copy of what it lists. |
| **GitHub webhooks only** | Not now. A hub on a home machine usually has no public address. Polling with conditional requests [S23] works everywhere; webhooks can replace it later. |
| **A score per lane** | Rejected [S11]. Lanes are short-lived and a ranking invites gaming. The trust measure is per level and per engine and model. |
| **A model judges whether a claim holds** | Rejected. Its judgement would be one more claim. Levels come from who produced which check. |

## Consequences

- **Good:** the principal reads one list instead of asking; every line says who checked it and links the proof; a lane's word is never shown as a checked fact.
- **Good:** the weekly table says how much each level has been worth here, which is what calibrated trust needs.
- **Good:** the hub gains the first working part of Verification, which the Done-means and the domain's Verdict can build on.
- **Cost:** a forge token, polling traffic, three new commands to learn, and prompt blocks for the manager and the lanes. Lanes have to claim and record, or their work shows as claimed.
- **Limit:** "reviewed" relies on the lane name a worker token states (ADR-0015). One token per lane closes it (Q8).
- **Limit:** a live check is as good as what it checked. The line shows what it checked and what it saw, not only pass.
- **Limit:** "claims that later failed" is our own measure and unvalidated; it is labelled experimental.
- **Limit:** V3 (a change that weakens its own Check) needs a Done-means. Until then only a change that edits its own CI configuration is caught; a weakened test is caught only by a reviewer.
- **Limit:** work done without a claim or a link shows as unowned, and lane evidence on it doesn't count. The prompt blocks make claiming the normal path.
- **Not here:** the phone (Q3), hub-run live probes (Q6), forges other than GitHub, the Done-means and Verdicts.
