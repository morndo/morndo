# ADR-0035: Proof on a task in review is a brief with references the hub verifies (draft)

- **Status:** Proposed, 2026-10-23. Draft that goes with `docs/plans/2026-10-19-proof-of-work.md` (revision 2); no code yet.
- **Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), B11 (merge records and the done gate).
- **Rules:** B13 to B16, proposed for `docs/domain.md`. Numbers (ADR, rules, migration 26) are re-checked when the PR opens.

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

## Consequences

- One new table (migration 26), one adapter, one application service, one domain file; the board's rules D1 to D6 do
  not change.
- The hub makes outbound calls to `api.github.com` built from validated parts only, against a repository allowlist.
- A green check proves the commit passed, not that it holds the work: the reviewer still reads the diff.
- Screenshots and per-item human marks are not in this decision; they are a later one (plan, option C).
