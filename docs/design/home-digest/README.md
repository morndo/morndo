# Home digest: since you last looked, with proof

**Phase: design, 2026-10-12. No product code.** Issue [#33](https://github.com/morndo/morndo/issues/33). Decision record: [ADR-0025](../../adr/0025-home-digest.md). Mockups: [`mockups/home-digest.html`](mockups/home-digest.html) and [`mockups/home-weekly.html`](mockups/home-weekly.html); `node docs/design/home-digest/shots.ts <folder>` screenshots them in light and dark.

Home shows usage today (ADR-0016), not what happened. To learn what was pushed, merged, shipped or finished, what is stuck and what waits for them, the principal asks the manager, and the answer comes from the manager's memory. A lane's "done" looks the same as a checked fact. This design puts one list at the top of Home: everything that changed since the principal last looked, grouped by what it means for them. Every line says who checked it and links the proof. Every count comes from records, never from a summary someone wrote.

| Already decided | What the digest uses |
|---|---|
| Verification (V1 to V4) | A Claim is not Evidence; Evidence comes from a producer other than the claimant, on the claimed revision; missing Evidence is Unverified, never success. |
| Escalation (E6) | A report's headline is its Verdict, never the worker's words. The digest is E6 on Home. |
| Board (B1 to B8, ADR-0015) | Every change has an Actor; done is the manager's or the principal's acceptance, not a Verdict. |
| Observation, Catch-up (O7, C1, C5, C7) | Marks only move forward, are clamped to the hub's clock, are shared by every Endpoint, and never move past what was shown. |
| Jobs (J1 to J7, ADR-0017) | A job ends once, with an outcome and a redacted tail. |
| Lane events (ADR-0014) | "finished", "needs input", "answered", "stop failure", kept 7 days in the fleet. |
| Decision briefs (ADR-0023, proposed) | Asks get a compact card and a full brief in a modal. Needs you links to it. |

## 1. What the records say today

Measured on the system Morndo is learning from (one principal, about ten lanes), 2026-10-12, read only. Counts only; no names.

| Record | What it holds | What it lacks |
|---|---|---|
| The manager's task list | 239 tasks, each with a verification level already in four steps: `unverified` 31, `evidence-checked` 95, `reviewed` 21, `live-verified` 92. 18 tasks were closed while still `unverified`. | Evidence is 2,287 free-text strings. None is a typed link the hub could open or check. |
| The verdict ledger (`lanes ledger`) | 421 verdicts in 14 days, each tied to a PR's head commit and its patch id: 333 `test-verified`, 85 `live-verified`, 3 `failed`. A new commit voids the verdict unless its diff is the same (a rebase). 398 were recorded by the manager. | No test counts, no link to the run, no reviewer identity. |
| Lane events | 1,126 events: 830 finished (108 said done, 43 needs decision, 9 blocked), 131 needs input, 126 answered, 39 stop failures. | Kept 7 days in the fleet (ADR-0014): too short for a weekly view. |
| The manager's decision log | 1,081 entries. | Two names for the time (`ts`, `at`) and two for the text (`decision`, `what`); 473 entries don't say whether the decision can be undone. |
| The principal's messages | Messages asking for status ("status of all lanes", "where are we"): 14 in week 40, 47 in week 41, by a rough keyword count. | |

So the vocabulary exists and is used every day: four levels, verdicts bound to commits, voiding on a new push. What is missing is evidence a machine can open, a store the hub owns, and one place that shows it. The four levels in this design are the ones the manager already uses.

## 2. What organisations do, and what the digest takes

Sources are in section 11, all read on 2026-10-12. Full notes, with every quote, are outside this repo.

| Practice | Source | Adopt | Reject or adapt |
|---|---|---|---|
| Controllable inputs before outputs | Amazon 2009 letter [S1] | The weekly view leads with inputs the pipeline controls: the share reviewed or verified live, hours waited on the principal, stuck items. Outputs follow. | No analysts to evolve inputs. A small fixed set. |
| Resist proxies | Amazon 2016 letter [S2] | A green pipeline is process, not outcome: only a live check or a fresh reviewer reaches the top two levels. Every decision taken for the principal says how to undo it. | The worker's account of why it followed the process is not shown as evidence. |
| Narrative memos | Amazon 2017 letter [S3] | A Needs you line carries the ask, the due time and the default in full words, and opens the brief (ADR-0023). | A lane's prose is a claim: capped, under the evidence, never raising a level. |
| Dive deep; skeptical when metrics and anecdote differ | Amazon leadership principles [S4] | Every line is one click from the raw record. Where the claim and the record disagree, the line says so in words. | The principal does not audit everything. Checks run by default; the digest points at the low levels. |
| Weekly business review | Working Backwards, first-hand secondary [S5] | One fixed line format; one fixed weekly table with six prior weeks; space goes to variances. | In a WBR a human owner explains each variance. The lane that did the work is the wrong party to explain its own variance; explanations come from records or a fresh reviewer. |
| A single source of truth | GitLab handbook [S6] | The digest is a view over records and links to them; it stores no second copy of the truth. | A description a lane edited is a claim. |
| "A dot that doesn't move is a raised hand" | Shape Up, chapter 13 [S7] | Stuck is computed from the absence of side effects, not from a lane saying so. | Position comes from records, not self-placement. |
| Announce, then confirm live | Basecamp posts [S8] | Shipped has two facts with two times: deployed, then verified live. The gap shows. | No self-reported check-ins for lanes. |
| Definition of Done | Scrum Guide 2020 [S9] | An item that doesn't meet it "cannot be released or even presented": it shows as claimed, with what is missing. | The check is run by someone other than the doer. No sprint ceremonies. |
| Release Stabilization Period; outputs are not outcomes | EBM Guide 2024 [S10] | The trust measure: from "the lane says ready" to "a check passed or it failed". Activity never headlines the week. | The market-value areas are out of reach. Use DORA's current names. |
| Throughput beside instability; no targets; no competing | DORA guide and history [S11, S12, S13] | Change fail rate, recovery time and rework stand beside shipped and merged; per repo; no targets; no ranking of lanes. Definitions carry a version. | DORA counts production deployments. Much agent work never deploys, and "claims that later failed" is our own, unvalidated measure, marked experimental. |
| Change management: authorise, test, approve, document; no unilateral change | AICPA TSC CC8.1 [S14] | A change's line shows who tested and who approved, and the tester or reviewer is not its author. A push straight to a default branch is marked "no pull request, no review", as an emergency change is in CC8.1. | Auditors sample a period, and points of focus are guidance, not a checklist. One person does not sample; the digest shows every change and its record. |
| Graded trust by who produced the evidence | SLSA v1.2 [S15]; commit signature status [S16] | Levels name who checked, not how sure the worker is. The verifier, not the producer, decides; evidence names a commit, never a branch. "Unverified" is a visible state, as in GitHub's vigilant mode, not an absence. A link alone proves nothing until someone checks it. | Build-platform hardening is out of scope. |
| Calibrated trust; show past performance | Lee and See 2004 [S17] | The goal is appropriate trust, not more trust. The weekly view shows how often items shown at each level later failed, by engine and model too. Every line exposes its intermediate results (the evidence chips). | The paper's studies are of operators of physical automation; nothing here claims its findings were measured on coding agents. |
| Complacency and automation bias, even in experts | Parasuraman and Manzey 2010 [S18] | The system marks claim against checked on every line; it does not count on the principal noticing. A badge links to its evidence, and the checker's own misses (shown checked or reviewed, later failed) are counted. | "The user will learn" is not a plan: practice and training don't remove it. |
| False alarms cause disuse; salient state | Parasuraman and Riley 1997 [S19] | The level is on the line itself, short. Stuck limits are tuned on a count of stuck flags that cleared on their own (section 7). | |
| Seeing is not noticing | Bainbridge 1983 [S20] | The mark moves only when the principal says so (section 4); being on screen is not being read. Raw evidence stays one click away, so the principal can still take over. | |
| Alarm fatigue | Joint Commission SEA 50; AHRQ PSNet [S21] | Only Needs you asks for action. Everything else is quiet, counted and folded. The digest sends no notifications of its own. | |
| A read mark shared by every client | GitHub notifications API; Linear's Inbox [S22] | One mark per principal on the hub. Marking read names the newest item shown; anything newer stays new. Needs you is split from the rest, as Linear's Priority tab. | GitHub's docs don't say how read state syncs across devices; our rule (forward only, on the hub) is our own. |

Where these disagree, the design sides with the trust research: an item is shown at the level its evidence earns, even when that makes the week look worse.

## 3. The item model

### 3.1 Terms

Added to `docs/domain.md` when ADR-0025 is accepted. The domain module (`packages/domain/src/digest.ts`) holds the rules below as pure functions. It reads no disk, forge or fleet.

| Term | Means | Is not |
|---|---|---|
| Subject | What a line is about: a task (`T-12`), a change (`owner/repo#87`, a pull request at a revision), a deploy (an environment at a revision), an ask, a decision taken for the principal, a lane, or a job. | A message. |
| Revision | The commit a claim or a check is about (a SHA), with its patch id. | A branch name. |
| Event | One fact about a subject from one record, with its record's time and the hub's sequence number: needs you, decided for you, failed or rolled back, stale or stuck, shipped, merged, opened or pushed, done. | A summary. |
| Claim | A lane's statement that an outcome holds on a revision: done, merged, shipped, fixed. Filed through the agents' door, or read from the board (a task moved to review) or a lane event (its last answer said done). A board or lane-event claim is about the task (for a lane event, the task that lane has in progress, B5; none, and it is counted as unattached and shown nowhere), and its revisions are the heads of the task's linked changes when it was made. | Evidence (V1). |
| Evidence | The result of one check on one revision, with its producer: a CI run, test counts, a review, a live check, a screenshot, a deploy status. | Output the claimant produced about itself. |
| Producer | Who made the evidence: the hub's forge adapter (CI, deploy status), the manager, a lane, or the principal. | The lane named in the evidence's text. |
| Level | Who has checked a subject at its current revision: claimed, checked, reviewed, verified live; or failed. | A Verdict. "Verified live" says one live check passed on this revision, and its chip says what it checked. The Verdict Verified needs Evidence for every Check of a Done-means (V1); the digest shows no Verdict until Done-means exists. |
| Item | One line: a group of linked subjects (a task with its changes and deploys), its section, its level, its events since the mark, its evidence. | A stored summary. It is recomputed from records. |
| Link | A record that a change or a deploy belongs to a task: filed with a claim or evidence that names both, or on its own (`morndo-verify link`), always under a token. | A task key found in a branch name or a title. |
| Mark | The hub's sequence number up to which the principal has seen the digest, on any Endpoint, with the items seen above it. | A Read mark of a Conversation; an Acknowledgement. |

### 3.2 Events: where each comes from

| Event | Section | The record that makes it (and nothing else does) |
|---|---|---|
| needs you | Needs you | An open Ask waiting for the principal (Escalation, E8 to E14): the manager's list, a worker's question or menu, a brief. A worker's step for the principal (a login, a key) is an Ask of kind `time`. |
| decided for you | Decided for you | A row in the decision log (section 6.2), filed by the manager's token, with what, why, how to undo it, and whether it can be. |
| failed | Failed or rolled back | Evidence with result `fail` on a claimed revision (a red run on a pull request nobody has claimed yet is work in progress: its level shows failed, its section doesn't change); a check run concluding `failure` or `timed_out` on a default branch; a job ending `exited` non-zero, `timed_out` or `lost` (J2); a lane's `stop failure`; a task moved out of done (reopened). |
| rolled back | Failed or rolled back | A merged pull request whose commit says "This reverts commit \<sha\>" (git's default message [S27]) for a merged change; a deploy status `failure` or `error` [S26]; a deploy of an older revision after a newer one on the same environment. |
| stale or stuck | Stale or stuck | Computed (section 6.3). Never a lane's own report. |
| shipped | Shipped | A deploy status `success` for an environment at a revision that contains a merged change [S26], or a deploy record filed through the agents' door. |
| merged | Merged | The forge: the pull request's `merged`, `merged_at` and `merge_commit_sha` [S25]. |
| opened or pushed | Opened or pushed | The forge: a pull request opened, its head SHA changed, or a commit pushed straight to a default branch (shown with "no pull request, no review"). A head SHA change is also filed as a change head `{ subject, revision, at }`. |
| done | Done | A board event moving a task to done, with its Actor (B6). |

A change head is `{ subject, revision, at }`. The forge adapter files one when it reports that a pull request's head SHA changed. A link or the first claim files the opening head, which is not itself a forge event. The live subject state keeps the current head and is not what a week is judged at. A change claim that names a revision is judged at that revision. Otherwise the week uses the latest change head whose `at` is at or before the moment being judged, or, if there is none, the earliest change head after that moment (DG12). A claim with no revision and no head is claimed, revision unknown: evidence on some other revision does not count.

Whether a deploy's revision contains a change is an ancestry question for the forge (its compare endpoint). The exact call is checked against the forge's documentation when the adapter is built.

### 3.3 Evidence

```ts
type Evidence = {
  id: string; seq: number; at: number;                  // hub sequence and time
  subject: SubjectRef;                                  // change, deploy or task
  revision: { sha: string; patchId: string | null } | null;
  kind: "ci" | "tests" | "review" | "live" | "screenshot" | "deploy" | "file";
  result: "pass" | "fail" | "incomplete" | "info";
  counts?: { passed: number; failed: number; skipped: number };   // tests only
  link?: string;                                        // https only, or an attachment id
  note?: string;                                        // at most 140 characters, the producer's words
  producer: { kind: "forge" | "manager" | "lane" | "principal"; name: string; token?: string };
};
```

| Kind | Produced by | Bound to | Can raise the level to |
|---|---|---|---|
| `ci` | The hub's forge adapter, from the check runs of the SHA [S24]. Pass: every run completed, none concluded `failure`, `timed_out`, `cancelled` or `action_required`, at least one `success`. Fail: any `failure` or `timed_out`. Otherwise incomplete. | SHA | checked |
| `tests` | The manager or a lane that is not a claimant, with passed, failed and skipped counts. Skipped above zero shows in amber: a green run with the relevant tests skipped does not show the behaviour. | SHA | checked |
| `review` | A lane that is not a claimant, with approve (pass) or changes requested (fail) and a link to the review. | SHA | reviewed |
| `live` | The manager, a non-claimant lane, the principal, or later the hub itself: a check run against the deployed system, with what it checked and what it saw. | deploy at SHA | verified live |
| `screenshot` | Any producer. From a non-claimant, of the live system, it counts as `live`. From a claimant it is part of the claim. | SHA or deploy | verified live, or none |
| `deploy` | The forge adapter, from deployment statuses [S26]. | deploy at SHA | checked (for shipped) |
| `file` | Any producer: a report, a runbook, a log. | task | none on its own |

The claimants of a subject are every lane that filed a claim on it or linked it, and every lane that was ever assigned a task linked to it (a reassignment doesn't make the old assignee independent). Evidence from a claimant is shown, marked "attached by the claimant", and never raises the level (V1). Levels are computed from the current records each time, so order doesn't matter: evidence that arrived before a claim counts the same, and evidence from a lane that later claims the subject stops counting from then on.

A change nobody claimed or linked has no known author: the forge account is shared by every lane on a machine. Lane-produced evidence on it doesn't count; only the forge's own, the manager's and the principal's do. The lanes' prompt block says to claim a change when opening it, so this is the exception.

A task with no change has no SHA. Its evidence binds to the task's claim round instead: the time of its last move to review. A new move to review voids it, as a new push does for a change (DG4).

**V3 is only partly reachable.** V3 refutes a claim whose revision changes what a Check depends on; that needs a Done-means, which doesn't exist yet. Until then one rule stands in: a change that edits the forge's CI configuration doesn't get `ci` evidence counted for itself; the chip says "the change edits its own CI". A change that weakens a test is caught only by a reviewer.

### 3.4 Levels

| Level | Reached when, on the subject's current revision | Shown as |
|---|---|---|
| claimed | A claim exists and nothing below holds. Also every subject with no claim and no evidence. | Grey, dashed outline, `circle-dashed`, the word "Claimed". Never green. |
| checked | At least one passing `ci`, `tests` or `deploy` from a producer other than the claimants. The hub reading CI on the SHA is the orchestrator's check, as the manager does it by hand today (`evidence-checked`). | Neutral, `circle-check`, "Checked". |
| reviewed | A passing `review` from a non-claimant. | Neutral, `user-check`, "Reviewed". |
| verified live | A passing `live` check after the deploy that contains the revision. | Green, `badge-check`, "Verified live". The only green. |
| failed | Any `fail` evidence on the current revision, whatever else passed (V2); or the subject was reverted, rolled back or reopened. | Red, `circle-x`, "Failed" or "Rolled back". |

- The level shown is the highest reached; the chips list every piece of evidence, so "verified live" with no review is visible as such.
- A new revision drops the level to what exists for that revision. Evidence for an earlier revision stays visible, struck through, with "pushed again after the last check". A revision with the same patch id (a rebase) keeps its evidence, as the verdict ledger does today.
- A task's level is the lowest level of its linked changes, or its own evidence when it has no change.
- Asks, decisions, lanes and jobs carry no level; their line says what they are (Decision, Your step, Decided, Stuck, Waiting).

The same ladder in the vocabularies that already exist, so importers and the manager's instructions map one to one:

| Digest level | Domain (V1 to V4) | Manager's task list | Verdict ledger |
|---|---|---|---|
| claimed | Unverified (V4) | `unverified` | `type-check-only`, or none |
| checked | Evidence for some Checks | `evidence-checked` | `test-verified` |
| reviewed | Evidence for some Checks, one a review | `reviewed` | none |
| verified live | Evidence for some Checks, one live | `live-verified` | `live-verified` |
| failed | Refuted (V2) | none | `failed` |

### 3.5 The item

```ts
type DigestItem = {
  id: string;                        // stable: the root subject's ref
  seq: number;                       // the hub sequence of its newest event or evidence
  section: Section;
  subjects: SubjectRef[];            // root first: a task, then its changes, then their deploys
  level: Level | null;               // null for asks, decisions, lanes, jobs
  headline: { verb: string; key: string; title: string };   // from records: the task's or PR's title
  events: DigestEvent[];             // since the mark, oldest first: the trail
  evidence: Evidence[];              // current revision first, then voided, struck through
  claim?: { lane: string; words: string };   // the lane's own words, quoted, at most 140 characters
  lane?: string; repo?: string; at: number;
  changedSinceSeen?: string;         // "CI finished", "level checked → verified live", "refuted"
  actions: ("open_brief" | "open_lane" | "open_task" | "open_link" | "veto")[];
};
```

### 3.6 Invariants

| # | Invariant |
|---|---|
| DG1 | Every item, count and level is derived from records with an Actor or a producer: board events, Escalations, claims, evidence, links, lane events, jobs, forge facts and the decision log. A worker's free text never sets a level, a section, a verb or a count of anything but claims; it shows only as a quoted claim. Task and pull-request titles are shown as names, as on the board and the forge. |
| DG2 | An item's level is the highest level whose evidence is on the subject's current revision and comes from a producer other than its claimants. A claimant's own evidence never raises it (V1). |
| DG3 | Any failing evidence on the current revision, a revert, a rollback or a reopen shows the item as failed, whatever else passed (V2). Failed lasts while its cause is current: a new revision clears failing evidence (DG4); a reverted change and a rolled-back deploy stay failed; a reopened task is failed until it is accepted as done again, then its level is recomputed. The failure stays in the trail and in DG12's count. Placement in the Failed section follows section 3.2. |
| DG4 | A new revision without the same patch id voids earlier evidence for the level. The voided evidence stays visible as voided. |
| DG5 | One item per root subject. A task groups its linked changes and their deploys. The item sits in the first section, in the order of section 5, that a live condition of its own (DG6) or one of its events since the mark belongs to; its other events form its trail. |
| DG6 | Needs you and Stale or stuck are live state: an item stays while its condition holds and leaves when it clears, whatever the mark. A Needs you item leaves only by being answered, settled or expired (C1). |
| DG7 | The mark only moves forward. "Mark all seen" names the items the device covered: every line it displayed, and the items of a section folded by design (Opened or pushed), whose fold line shows their count and kinds. Items behind "N more" are not covered. The hub marks those items seen and moves the mark to the highest sequence number below which every item is seen; it never passes an item that wasn't covered, nor the hub's newest. Kept on the hub and told to every Endpoint (O7, C7). |
| DG8 | An item is new while its sequence number is above the mark and it has not been seen (opened, or covered by Mark all seen) at that sequence number. An item whose level, result or section changed after it was seen is new again, with what changed. The sequence is the latest record that changed it: the group's claims, links, assignments and change heads are replayed in sequence order, and a record raises the sequence exactly when the members, claimants, level or section differ from the record before it. |
| DG9 | A rebuild of the digest from the stores gives the same items, levels and counts. Section counts are counts of items; weekly counts are counts of records. |
| DG10 | Stale and stuck are computed from records and side effects (section 6.3), never from a worker's own report. Their limits come from config. |
| DG11 | The digest grants and starts nothing (O4, B8, C6): seeing, marking, opening, and a veto are not a Mandate, a Decision, an Acknowledgement, a Verdict or a board move. A veto is a Command (AC7) that sends the manager a message naming the decision. |
| DG12 | A claim is counted once per root subject and revision, at the earliest of its sources (a claim filed, a task moved to review, a lane event that said done). It counts as later failed when, within 14 days, failing evidence lands on that revision, its merge is reverted, its deploy is rolled back, or its task is reopened. It is counted in the claim's week, under the level its item showed just before the failure; a claim that held is counted under the level its item showed when the 14 days ended. A change claim that names a revision is judged at that revision. Any other claim is judged at the latest change head (`{ subject, revision, at }`, section 3.2) with `at` at or before that moment, or at the earliest change head after it if none is yet. Never at the live head. A link or the first claim files the opening head. A claim with no revision and no head is claimed, revision unknown, and evidence on some other revision does not count. |

## 4. Since you last looked: the mark

- **One mark per principal**, on the hub, as a sequence number: the digest's own counter, which grows by one with every event or evidence the hub records, plus the items seen above it. Not a time. Evidence arrives late (a review lands an hour after the merge it is about) and node clocks differ (FL13). A sequence number makes "new since the mark" exact.
- **What moves it:**
  - "Mark all seen" covers what the device displayed: every line on screen, and the folded Opened or pushed section, whose line gives its count and kinds. Items behind "N more" are not covered; the button says how many ("Mark all seen · 2 not shown"). The hub marks the covered items seen and moves the mark up to the first item that isn't (DG7, as C5). An item that arrived while the principal was reading stays new.
  - Opening an item (its task, lane, brief or evidence) marks that item seen.
- **What doesn't move it:** opening Home, scrolling, time passing, a notification, answering a decision elsewhere, the phone's away digest. A list on screen is not a list read: "people can write down numbers without noticing what they are" [S20]. Attending in `docs/domain.md` exists for the same reason.
- **Why "newest shown", not "now":** GitHub's notifications API marks read only what was updated before the time the client names [S22]. The digest does the same with its sequence number.
- **Across devices:** the mark and the opened items live on the hub and are pushed to every Endpoint (a `digest` frame). Two devices racing keep the larger value. A device that was offline sends its mark on reconnect; the rule above keeps that safe, because it can only name what it displayed. A mark is a preference, like a Read mark: no step-up, no audit row, its history not kept.
- **First look:** with no mark, the digest shows the last 24 hours and says so.
- **A long absence:** items older than the retention (90 days) are not listed; the line at the top says how many, and the weekly view covers them.
- **Not merged with other marks:** Read marks stay per conversation (O7). Last caught up (C7) stays the decisions run's. Whether the phone's away digest (ADR-0011, H4 and H5) becomes this digest on the phone is question Q3.

## 5. Sections, order, and one line

**Order, by what each asks of the principal:**

1. **Needs you**: act. Decisions and steps only the principal can take, each with its default if nobody answers.
2. **Decided for you**: veto while it can still be undone.
3. **Failed or rolled back**: know, perhaps step in.
4. **Stale or stuck**: know, perhaps nudge.
5. **Shipped**
6. **Merged**
7. **Done**
8. **Opened or pushed**: work in motion.

The issue listed progress first and problems last. This order puts what needs attention first, because the research on complacency and alarm fatigue says the failures are what a reader skims past when the good news comes first [S18, S21]. Question Q1 records the alternative.

**Within a section:** Needs you by blocking, then the earliest due or default time, then the oldest (C3). Stale by how long. The rest newest first.

**Folding:** Needs you, Decided for you, Failed and Stale always show every item. Shipped, Merged and Done show three, then "N more". Opened or pushed is folded to one line of counts. An empty section shows only as a zero in the strip.

**The strip:** one tile per section with its count and one fact ("1 due today", "1 rollback", "1 only claimed"). A click scrolls to the section. The Needs you count is its own set: every open Ask waiting for the principal (decisions and steps) and every worker that needs them (O6), one item per subject. It reads the same stores as the rail's badges, but Decisions counts only open decisions and Activity only workers, so the numbers can differ; the tile's fact line says what it holds.

**One line:**

| Part | Shows |
|---|---|
| Dot | Filled: new. Ring: seen before, changed since. None: seen. |
| Level | Icon and word, always both (never colour alone, as ADR-0016's meters). For asks, decisions, lanes and jobs: what it is. |
| Headline | The verb, the subject's key (`T-41`, `owner/repo#87`), its title from the record. |
| Chips | One per piece of evidence: `CI 3 of 3 checks`, `1,204 passed · 0 failed · 3 skipped`, `review by #review-3`, `live: /invoices/totals 200`, `screenshot`, `owner/repo#87 · 3e9d1a7`. Failing chips red; skipped tests amber; a claimant's own dashed; voided struck through. Each opens its link or attachment. |
| Trail | Folded events since the mark: "shipped 09:05, shown as Checked → live check failed 09:20 → rolled back 09:31". |
| Meta | The lane (opens its chat), the repo or environment, the time, the linked task, who accepted it. |
| Action | One button: Open brief (Needs you), Veto (Decided for you), Open task or Open lane. |

**Links:** a task opens beside the board (ADR-0015's task panel); a lane opens its chat; a pull request, CI run or review opens on the forge in a new tab; a screenshot or file opens from the hub's attachments; an ask opens its brief in the Decisions panel (ADR-0023). Needs you is answered there, not on Home: one place to answer (Q4).

Usage across accounts (ADR-0016) stays on Home, below the digest.

## 6. Counts from records

### 6.1 Which store each section reads

| Section | Store | Read | Kept |
|---|---|---|---|
| Needs you | Escalation service: the manager's list (read-only adapter), workers' questions and menus, briefs | Open Asks waiting for the principal, live | As today |
| Decided for you | `decision_log` (new, 6.2) | Rows after the mark | 90 days |
| Failed or rolled back | `evidence` (new), forge facts, `jobs` (fleet), lane events (fleet), `board_events` | Fail results, reverts, failed deploys, job outcomes, stop failures, reopened tasks | 90 days in the hub's copy |
| Stale or stuck | Observation, board, jobs, delivery queue, side-effect probe | Live state, recomputed every minute | Not stored; crossings recorded as events |
| Shipped | forge deployments, `deploy` records (new) | Successful deploys after the mark | 90 days |
| Merged | forge facts | Pull requests merged after the mark | 90 days |
| Done | `board_events` | Moves to done after the mark | As the board |
| Opened or pushed | forge facts | Pull requests opened, head SHA changed, direct pushes to a default branch | 90 days |
| Levels | `claims`, `evidence`, `links` (new) | Per subject and revision | 90 days |

The hub keeps its own copy of every fact it lists (`digest_events`), because lane events last 7 days in the fleet and the forge can be unreachable. A fact is copied once, keyed by its source and id, so a replay changes nothing.

### 6.2 New records

| Record | Written by | Through | Fields |
|---|---|---|---|
| `claims` | A lane's worker token | `morndo-verify claim` | subject, revision, outcome, the lane, a task to link, a note of at most 140 characters |
| `evidence` | The manager's or a lane's token; the forge adapter | `morndo-verify record`, `morndo-verify review`, `morndo-verify live`; the adapter | section 3.3 |
| `decision_log` | The manager's token only | `morndo-decide log` (a verb on ADR-0023's command) | what, why, undo, reversible, linked subjects, by |
| `links` | Any token | `morndo-verify link T-12 owner/repo#87`, or a claim or evidence naming both | task, change or deploy, by, at. The only way a task groups its changes. |
| `deploys` | Any token; the forge adapter | `morndo-verify deploy` | environment, repo, revision, url, by |
| `forge_facts` | The forge adapter | polling | pull requests, check runs, deployments, default-branch commits per watched repo |
| `digest_events`, `digest_seen`, `digest_weeks` | The hub | the projection | section 4, section 7 |

The commands live in `apps/board-cli` beside `morndo-board`, with the same tokens, environment, exit codes and one-line refusals (ADR-0015). Their prompt block tells a lane when to claim, and the manager when to record a check or a decision; a test keeps `docs/agents/verify.md` equal to the printed block.

**The forge adapter** (`apps/hub/src/adapters/forge-github.ts`, behind a `Forge` port so other forges can follow) polls the repos named in the hub's settings and in any claim, evidence or task link:
- every minute for repos with an open subject, every 10 minutes otherwise;
- with conditional requests, since a `304` does not count against the primary rate limit when the request is authorised [S23];
- webhooks are what the forge recommends [S23], but a hub on a home machine usually has no public address; they can replace polling later without changing the domain;
- a read-only token from the secret store (ADR-0018).

**Importers** (optional, behind config, read-only): the verdict ledger's TSV becomes evidence (its `by` the producer, its verdict the result), and the manager's decision log becomes `decision_log` rows, with each unreadable row counted and skipped. That way the trust measure starts with history on the first day.

### 6.3 Stale or stuck, computed

Limits come from the hub's config, with these defaults:

| Condition | Default limit | Computed from |
|---|---|---|
| A lane is busy with no side effect | 45 minutes | Observation says Working for the whole window, and none of these happened in it: a commit, a change to the working tree, a push, a board event by the lane, a job started or ended by it, a claim or evidence it filed, a message it sent. A moving screen is not a side effect. |
| A task is blocked | 4 hours | `board_events`: blocked since, with its reason. |
| A task waits in review | 8 hours | `board_events`: in review since, with no acceptance. |
| A task is in progress with nothing happening | 24 hours | No board event and no side effect by its assignee. |
| A job waits in its queue | 60 minutes | The job's state `queued` since (J5). |
| A message to a lane may not have arrived | at once | Delivery `uncertain` or `given_up` (ADR-0014). |

**The side-effect probe** is a typed fleet operation, `lane.sideEffects`, answered by the node from the lane's working directory: the time of the last commit, a hash of the working tree's status, how many commits are ahead of upstream, and the head SHA. The node runs git itself; no command line crosses the fleet (FL14). The hub asks for lanes that have been Working for 15 minutes or more, every 5 minutes.

A condition becomes an event when its limit is crossed, at that time, so it is "new since the mark" once. It stays listed while it holds (DG6), and its end is recorded in the item's trail.

A worker's open question or menu is not here: under O6 every one of them needs the principal, so it is in Needs you, with its age. A lane event doesn't say whom a question is for, so the digest can't tell a question meant for the manager from one meant for the principal.

## 7. The weekly view

ISO weeks in the principal's time zone (a setting, by default the hub's): the current week and the six before it, newest first, as a WBR shows six weeks of trend [S5]. Per repo or all repos.

| Column | Counted from | Note |
|---|---|---|
| Shipped | Successful deploys of a revision that contains at least one merged change | With how many were verified live. |
| Merged | Pull requests merged into a default branch | |
| Reverted | Reverts merged that week, of changes merged in any week | |
| Done | Tasks accepted as done | |
| Time to done | A task's first move to in progress, to its acceptance: median and 90th percentile | The nearest DORA measure is change lead time [S11]. |
| Claims | Claims filed, tasks moved to review, lane events that said done | |
| Later failed | Claims of that week that later failed (DG12) | Counts beside every rate. |
| Failed deploys | Deploys followed by a rollback, a failure status or a failed live check, of all deploys | DORA's change fail rate [S11]. |
| Recovery | Time from a failed deploy to the next successful one on that environment | DORA's failed deployment recovery time [S11]. |
| Stuck flags | Stale or stuck items raised, and how many cleared within 15 minutes with nobody acting: no message from the principal or the manager to that lane, and no board move by either, before it cleared | A false-alarm count, for tuning the limits: false alarms are what make people stop looking [S19]. |

**Inputs first** [S1]: the head of the view shows the share of done or shipped items that were reviewed or verified live, the median hours an ask waited on the principal, and how many items went stale. Shipped, merged and done follow, with instability beside them [S11, S13].

**How each level held up** (the trust measure): for the closed weeks, the claims by the level their item showed (DG12), how many later failed, and the rate. This tells the principal how much each level has been worth on this system, which is what calibrated trust needs [S17]. It is labelled experimental, as DORA's history shows a plausible measure can fail validation [S12].

**By engine and model, not by lane**: claims and later failures per engine and model, so the principal can see which model's word holds. No ranking of lanes [S11].

**Counts can't drift**: a week is recomputed from records until 14 days after it ends (the later-failed window), and marked provisional until then. Then its row is frozen in `digest_weeks` with the version of these definitions. Records older than 90 days are pruned; frozen weeks stay.

## 8. Layout

[`mockups/home-digest.html`](mockups/home-digest.html) (since you looked) and [`mockups/home-weekly.html`](mockups/home-weekly.html) (weekly), 1280 px, synthetic data, in the desktop's frame and tokens (`desk-tokens.css`, the brand's Ink palette), light and dark.

- Home's header stays. Below it: "Since you last looked", the mark ("since Mon 18:40, 15 h ago · 19 new · 2 changed"), a switch between Since you looked and Weekly, and Mark all seen.
- The strip of eight counts, then a one-line legend of the levels.
- The sections as cards in the order of section 5, each with its icon, name, count and how many are new.
- Usage across accounts below, unchanged.
- Colour only for status: red for failed, amber for stale and skipped tests, green only for verified live. A claim is grey and dashed.

The phone gets the same items later (Q3).

## 9. Build plan

| Step | What | Checks |
|---|---|---|
| 1 | Domain: `digest.ts` (subjects, events, levels, placement, the mark, stale, weekly) and the claim and evidence values in `verification.ts`; terms and DG1 to DG12 in `docs/domain.md`. | Unit tests per invariant, with negative controls: a claimant's own CI link doesn't raise the level; a push voids it; the same patch id keeps it; a failing check beats a passing review; a mark never passes what was displayed. |
| 2 | Protocol and hub: migrations for the new records, the agents' routes, `morndo-verify`, `morndo-decide log`, the projection, `GET /api/digest`, `POST /api/digest/seen`, `GET /api/digest/weeks`, the `digest` frame. | Hub tests; a rebuild from the stores equals the live projection (DG9). |
| 3 | The forge adapter (GitHub) with conditional polling; the node's `lane.sideEffects`. | Recorded forge responses; a fake node. |
| 4 | Home: the digest and the weekly view. | `e2e/home-digest.e2e.ts`, light and dark, keyboard; the strip equals the sections. |
| 5 | Importers for the verdict ledger and the decision log. | Run on a copy of real files; unreadable rows counted. |
| 6 | The prompt blocks in the manager's and the lanes' instructions. | Manual QA on the owner's box for a week: every line's link opens, and the counts match the board and the forge by hand. |

## 10. Open questions, with recommendations

| # | Question | Recommendation |
|---|---|---|
| Q1 | Section order: the issue's (progress first, problems last) or attention order (section 5)? | Attention order. The failures are the part a reader must not skim past. |
| Q2 | What moves the mark: only "Mark all seen" and opened items, or also leaving Home after attending to it for a while? | Explicit only, as section 4. An automatic mark makes "seen" mean "was on screen". |
| Q3 | Does the phone's away digest (ADR-0011) become this digest on the phone, with the same mark? | Yes, as a later step: one list, one mark, two screens. Until then they stay separate. |
| Q4 | Answer Needs you on Home, or open the brief? | Open the brief (ADR-0023). One place to answer keeps E8's single Decision simple. |
| Q5 | Polling or webhooks for the forge? | Polling with conditional requests now; webhooks when the hub has a reachable address. |
| Q6 | Who runs live checks: lanes and the manager recording them, or the hub running probes it is configured with? | Recorded checks now. A hub-run probe is the stronger producer and the next step. |
| Q7 | Show later failures per lane? | No. By level and by engine and model only. |
| Q8 | A "Reviewed" from a lane relies on the lane name a worker token states (ADR-0015's limit). Issue one token per lane? | Yes, before the digest calls anything reviewed in production use. Until then the line names the token as well as the lane. |
| Q9 | A weekly spot check against complacency: one item at the highest level, picked at random, with a "look at its evidence" prompt? | Yes, opt-out, at most one a week, never a Needs you item. Exposure to the system's own failures is what keeps reliance calibrated [S17, S18]. |
| Q10 | Retention: 90 days of records, frozen weeks forever? | Yes. |

## 11. Sources

All read on 2026-10-12. Quotes and notes on each are kept with the research notes outside this repo. The SEC, the journal publishers, the Joint Commission and scrum.org refuse plain scripted requests, so a link check from a script shows them as refused; the notes say how each was read. The two papers marked "abstract only" were not read in full.

**Status reporting and reviews**
- [S1] Amazon, 2009 Letter to Shareholders (SEC filing, Exhibit 99.1): "focusing our energy on the controllable inputs to our business". https://www.sec.gov/Archives/edgar/data/1018724/000119312510082914/dex991.htm
- [S2] Amazon, 2016 Letter to Shareholders, "Resist Proxies": "The process becomes the proxy for the result you want." https://www.aboutamazon.com/news/company-news/2016-letter-to-shareholders
- [S3] Amazon, 2017 Letter to Shareholders, six-page memos: "the quality of these memos varies widely." https://www.aboutamazon.com/news/company-news/2017-letter-to-shareholders
- [S4] Amazon Leadership Principles, Dive Deep: "skeptical when metrics and anecdote differ". https://www.amazon.jobs/content/en/our-workplace/leadership-principles
- [S5] Working Backwards (a former Amazon VP's firm; no Amazon-authored page on the WBR was found): "Data is presented in a 6-week and 12-month trend view". https://workingbackwards.com/blog/how-amazons-weekly-business-review-drives-data-driven-leadership/ and https://workingbackwards.com/blog/how-amazons-weekly-business-review-boosts-metric-insight/
- [S6] GitLab Handbook, Communication (last modified 2026-09-24): "The issue description should be the single source of truth." https://handbook.gitlab.com/handbook/communication/
- [S7] Basecamp, Shape Up, chapter 13: "A dot that doesn't move is effectively a raised hand". https://basecamp.com/shapeup/3.4-chapter-13
- [S8] Jason Fried, "Deployments: how we announce new features and updates internally at Basecamp" (2022-01-06), and "What's in a Heartbeat?" (2021-12-20). https://world.hey.com/jason/deployments-how-we-announce-new-features-and-updates-internally-at-basecamp-b709544e, https://world.hey.com/jason/what-s-in-a-heartbeat-4fd72d0e

**Done, evidence-based management, delivery metrics**
- [S9] The Scrum Guide, November 2020: "If a Product Backlog item does not meet the Definition of Done, it cannot be released or even presented at the Sprint Review." https://scrumguides.org/scrum-guide.html
- [S10] Evidence-Based Management Guide, May 2024: Release Stabilization Period, "between the point the developers say it is ready to release and the point where it is actually released". https://www.scrum.org/resources/online-evidence-based-management-guide
- [S11] DORA, "DORA's software delivery performance metrics" (last updated 2026-01-05): the five metrics; "Ignoring Goodhart's law … increases the likelihood that teams will try to game the metrics"; not "to compete against other teams". https://dora.dev/guides/dora-metrics/
- [S12] DORA, "A history of DORA's software delivery metrics" (2026-01-02): MTTR "renamed and redefined as failed deployment recovery time" (2023); deployment rework rate added in 2024. https://dora.dev/insights/dora-metrics-history/
- [S13] DORA reports 2024 and 2025 (landing pages): adoption "negatively impacts software delivery stability and throughput" (2024); an "amplifier" (2025). https://dora.dev/research/2024/dora-report/, https://dora.dev/research/2025/dora-report/

**Change records, provenance, trust in automation**
- [S14] AICPA, 2017 Trust Services Criteria (with Revised Points of Focus, 2022), CC8.1: "The entity authorizes, designs, develops or acquires, configures, documents, tests, approves, and implements changes"; point of focus: "restricting unilateral code development or testing and implementation by a single user". The download needs a login; the AICPA's own PDF was read from an archived copy of its asset file. https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022
- [S15] SLSA specification v1.2 (released 2025-11-24): the lowest level is "trivial to bypass or forge"; "provenance doesn't do anything unless somebody inspects it"; the verifier, not the producer, checks. https://slsa.dev/spec/v1.2/verifying-artifacts, https://slsa.dev/spec/v1.2/build-track-basics, https://slsa.dev/spec/v1.2/verification_summary. The in-toto Statement's subject is a fixed digest: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
- [S16] GitHub Docs, commit signature verification and vigilant mode: without it an unsigned commit shows "no verification status"; with it, "Unverified"; "Partially verified" for a check that doesn't cover the whole claim. Artifact attestations: "Generating attestations alone doesn't provide any security benefit." https://docs.github.com/en/authentication/managing-commit-signature-verification/displaying-verification-statuses-for-all-of-your-commits, https://docs.github.com/en/actions/concepts/security/artifact-attestations
- [S17] Lee, J. D., and See, K. A. (2004). Trust in automation: Designing for appropriate reliance. Human Factors 46(1), 50–80: "Design for appropriate trust, not greater trust. • Show the past performance of the automation." https://doi.org/10.1518/hfes.46.1.50_30392 (abstract on the publisher's page; full text from the authors' archived lab copy)
- [S18] Parasuraman, R., and Manzey, D. H. (2010). Complacency and bias in human use of automation: An attentional integration. Human Factors 52(3), 381–410: complacency "cannot be overcome with simple practice"; automation bias "cannot be prevented by training or instructions". https://doi.org/10.1177/0018720810376055 (abstract only)
- [S19] Parasuraman, R., and Riley, V. (1997). Humans and automation: Use, misuse, disuse, abuse. Human Factors 39(2), 230–253: disuse "is commonly caused by alarms that activate falsely"; monitoring depends on "the saliency of automation state indicators". https://doi.org/10.1518/001872097778543886 (abstract only)
- [S20] Bainbridge, L. (1983). Ironies of automation. Automatica 19(6), 775–779: "Unfortunately people can write down numbers without noticing what they are." https://doi.org/10.1016/0005-1098%2883%2990046-8 (the publisher's page was behind a bot check; read from the author's archived web copy)
- [S21] The Joint Commission, Sentinel Event Alert 50, Medical device alarm safety in hospitals (2013-04-08): "Between 85 and 99 percent of alarm signals do not require clinical intervention." https://www.jointcommission.org/en-us/knowledge-library/newsletters/sentinel-event-alert/issue-50. AHRQ PSNet, Alert Fatigue primer: "Make only high-level (severe) alerts interruptive." https://psnet.ahrq.gov/primer/alert-fatigue
- [S22] GitHub REST API, notifications (API version 2026-03-10), `last_read_at`: "Describes the last point that notifications were checked. Anything updated since this time will not be marked as read." https://docs.github.com/en/rest/activity/notifications. Linear's Inbox: "The Priority tab separates notifications that need your attention from other updates." https://linear.app/docs/inbox

**Forge and git facts used by the adapter**
- [S23] GitHub REST API, best practices: conditional requests; "Making a conditional request does not count against your primary rate limit if a `304` response is returned"; "You should subscribe to webhook events instead of polling". https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
- [S24] GitHub REST API, check runs: `GET /repos/{owner}/{repo}/commits/{ref}/check-runs`; conclusions `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required`. https://docs.github.com/en/rest/checks/runs
- [S25] GitHub REST API, pull requests: `merged`, `merged_at`, `merged_by`; `merge_commit_sha` after a merge. https://docs.github.com/en/rest/pulls/pulls
- [S26] GitHub REST API, deployment statuses: states `error`, `failure`, `inactive`, `in_progress`, `queued`, `pending`, `success`. https://docs.github.com/en/rest/deployments/statuses
- [S27] git-revert (page last updated in git 2.54.0): the default message starts "This reverts \<full-object-name-of-the-commit-being-reverted\>." https://git-scm.com/docs/git-revert
- [S28] GitHub Docs, reverting a pull request: "creates a new pull request that reverts the original merge commit." https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/reverting-a-pull-request
