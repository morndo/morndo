# ADR-0035: Proof on a task in review is a brief with references the hub verifies

- **Status:** Accepted, 2026-10-23: the owner chose option B (verified references and a brief) of `docs/plans/2026-10-19-proof-of-work.md` (revision 2). Built in morndo/morndo#120.
- **Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), B11 (merge records and the done gate).
- **Rules:** B13 to B16 in `docs/domain.md`. Migration 28 (`board_proofs`; first numbered 26, renumbered when usage detection took 26 and 27).

## Context

A Done is accepted on a free-text reason. On one team's board, of 101 Dones in three days, 17 named a check or a commit
that was not green at that moment and about half named a commit or pull request without its repository (counts only,
measured 2026-10-23). The board also moves tasks by itself now (D1 to D4): the move to review follows the lane's run,
cannot be refused, and did not happen at all for a turn that ended DONE with a wake-up pending (T-398).

## Decision

1. **The brief is its own action,** `brief`, on a task in progress or in review, filed by its assignee or the board's
   hands, never by the board (B13). It is not part of the move, so it works whether the move was the lane's, the
   manager's or the board's.
2. **Proof is verified or attested** (B14). A reference is whole: `owner/repo#PR@sha` for a pull request,
   `owner/repo@sha:check,check` for CI. The hub fetches it from the forge with its own read-only credential, in
   `ProofService` over a `ForgeChecks` port; the first adapter is GitHub REST. Attested text is shown and never counts.
3. **A reference that is not green does not move the task** (B15). It stays in review and the card says why; a
   reference that cannot be fetched is `unfetchable`, never green.
4. **The Done is gated** (B16) on the verified proof, with a recorded override (the manager's reason, or the
   principal's click), in a mode `off | warn | on`. Verification is started by hub events (brief filed, task entered
   review, a timer, a Done attempt), never by reading a Run.
5. **Results are rows, not events,** so a re-check never changes the task's `rev`.
6. **Private repositories are read with an optional credential.** The repositories the hub may read are the ones its
   settings list (`MORNDO_PROOF_REPOS`, default `morndo/morndo`) and nothing a task says: a merge record is a lane's
   word and adds no repository. Anything else is never asked. The credential is a
   read-only token in a file the settings name (`MORNDO_GITHUB_TOKEN_FILE`, mode 600), read once at start and never an
   environment value, a setting or a word in a log. Without it a private repository answers as one that does not exist,
   and the reference reads `private repo: not checked`: its own state, neither red nor unfetchable, not retried, and not
   verified, so a Done is held for it like for any reference that is not green, and the override is recorded.
7. **The mode starts at `warn`.** The first week records what the gate would have refused, with every override and its
   reason, before `MORNDO_PROOF_GATE=on` is set.
8. **The assigner's proof list** (added 2026-10-23, built in the same pull request). A checker of the worker's own list
   cannot catch what the worker left off, so whoever assigns a task may list the proof it needs: items of a kind
   (`pr`, `ci`, `tests`, `manual`, `ui`, `data`, `infra`), an optional repository and a text. The list is its own action
   and event, changes no state, stands across rounds, and the lane may add items but drop only its own. The brief is
   matched to it by kind and repository: a green reference covers a `pr` or `ci` item, an attested check of the same
   kind "tells" any other, and an item with nothing against it is `not covered`: shown on the card and in the CLI, and it
   holds the Done like any proof that is not green (override and mode as for B16).

## Consequences

- One new table (migration 28), one adapter, one application service, one domain file; the board's rules D1 to D6 do
  not change.
- The hub makes outbound calls to `api.github.com` built from validated parts only, against a repository allowlist.
- A green check proves the commit passed, not that it holds the work: the reviewer still reads the diff. Likewise a green `pr` reference proves the pull request is at that commit (open or merged) and, since the amendment below, that the commit's checks are neither failing nor running; it does not ask a repository to have checks.
- Two trade-offs of the caps, kept on purpose. A green row stays when the forge cannot be reached (a rate limit, a timeout,
  the network), for at most an hour, without being refreshed: the Done's refresh may therefore accept a row up to an hour old
  while GitHub is unreachable; the row says `last read hh:mm UTC; the forge could not be reached since`, and an hour later
  it gives way to unfetchable. And the automatic verifications have an hourly allowance for the whole hub (30): a few tasks
  can spend it and the rest wait for the timer's pass (every 2 or 10 minutes for what is still pending), so a busy hour slows
  verification and never changes a result. A lane's briefs (20 a round) and proof list changes (100) are capped; the
  assigner's are not counted.
- A stand-in forge (`MORNDO_FORGE_URL`) is for tests and scratch hubs: refused with a token, refused with the gate `on` unless the hub declares itself a scratch hub (`MORNDO_SCRATCH_HUB=1`), logged at start, and shown hub-wide (a chip in the Board header, a line in `morndo-board list`) and on every proof.
- After a rollback to a build from before this decision: the table is additive and is left alone, but the `briefed`
  events and the `proofSeen` of Done events stay in a task's record, and an older build's event schema has no `briefed`
  kind, so its CLI and app may fail to read the history of a task that carries one (not run; the fix is to roll forward,
  or to ship the older build a reader that skips kinds it does not know). A hub rollback that keeps the data is therefore
  not free for tasks that were briefed. The known case (found by review, not run): the build at 4a0274cf, the first on the new database, has no case for `briefed` or `proof_listed` in the task panel's record line and returns nothing for them, so its panel throws for any task whose record holds one while the board itself still loads. This build gives the record line a default for kinds it does not know, so that class of break is closed from here on; for that older build the fix is to roll forward or to patch it with the same default.
- Screenshots and per-item human marks are not in this decision; they are a later one (plan, option C).
- GitHub's documentation (read 2026-10-23) lists `Pull requests: read` and `Contents: read` for the pull request
  endpoint with fine-grained tokens and lists no fine-grained permission for the check-runs endpoint (`Checks` is a
  GitHub App permission). Whether a fine-grained token reads check runs is therefore tried once with the real token at
  setup; the documented fallback is the workflow-runs endpoint with `Actions: read`, added test-first only if needed.
- The assigner's proof list (what proof the work needs, set when the task is assigned, matched against the brief, with
  `not covered` shown for what has nothing against it) is the next decision, in the same pull request, and is not part of
  this one.

## Amendment, 2026-10-25 (T-450): three Dones that still passed, closed before `on`

Read from the code at 613f3853 by the product lane's review of the warn week. Each is now held in `on` and recorded as
"would have been refused" in `warn`; the manager's override and the principal's click pass them as before. The mode stays
`warn` by default; nothing here switches it.

1. **A brief naming only the pull request while the checks run** passed, by design of the first decision. It no longer
   does: a `pr` reference reads the commit's check runs as well. Failing is red, running is pending, and none yet is
   pending while the brief is young (YOUNG_MS) and green after (a repository without checks). Reason: a Done over
   unfinished checks is the case the gate exists for, and the assigner's `ci` item was easy to leave off.
   Cost: one more forge request per `pr` reference, and a token that cannot read check runs now leaves a `pr`
   reference unfetchable (as it already did a `ci` one).
2. **A `ci` reference that named only passing checks** passed while another check at the commit was red. The named
   list still says what must exist and be green; it no longer hides a failing or running check at the same commit.
   Skipped and neutral others are ignored. Cost: a known-flaky optional check blocks until overridden with a reason.
3. **A brief with no code change on a task with no proof list** passed on the lane's word alone. A no-code claim is now
   accepted only against at least one item the assigner filed; with none it reads `unchecked`. Reason: with nothing
   listed, nothing can contradict the claim, and a lane cannot be both the claimant and the list. Cost: a research
   task needs one list item (for example `manual: read the memo`) or a recorded override.
