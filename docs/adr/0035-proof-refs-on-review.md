# ADR-0035: Proof on a task in review is a brief with references the hub verifies

- **Status:** Accepted, 2026-10-23: the owner chose option B (verified references and a brief) of `docs/plans/2026-10-19-proof-of-work.md` (revision 2). Built in morndo/morndo#120.
- **Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), B11 (merge records and the done gate).
- **Rules:** B13 to B16 in `docs/domain.md`. Migration 26 (`board_proofs`).

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

## Consequences

- One new table (migration 26), one adapter, one application service, one domain file; the board's rules D1 to D6 do
  not change.
- The hub makes outbound calls to `api.github.com` built from validated parts only, against a repository allowlist.
- A green check proves the commit passed, not that it holds the work: the reviewer still reads the diff.
- After a rollback to a build from before this decision: the table is additive and is left alone, but the `briefed`
  events and the `proofSeen` of Done events stay in a task's record, and an older build's event schema has no `briefed`
  kind, so its CLI and app may fail to read the history of a task that carries one (not run; the fix is to roll forward,
  or to ship the older build a reader that skips kinds it does not know). A hub rollback that keeps the data is therefore
  not free for tasks that were briefed.
- Screenshots and per-item human marks are not in this decision; they are a later one (plan, option C).
- GitHub's documentation (read 2026-10-23) lists `Pull requests: read` and `Contents: read` for the pull request
  endpoint with fine-grained tokens and lists no fine-grained permission for the check-runs endpoint (`Checks` is a
  GitHub App permission). Whether a fine-grained token reads check runs is therefore tried once with the real token at
  setup; the documented fallback is the workflow-runs endpoint with `Actions: read`, added test-first only if needed.
- The assigner's proof list (what proof the work needs, set when the task is assigned, matched against the brief, with
  `not covered` shown for what has nothing against it) is the next decision, in the same pull request, and is not part of
  this one.
