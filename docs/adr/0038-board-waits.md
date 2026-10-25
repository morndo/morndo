# ADR-0038: A block names what it waits on, and the board moves the task back when it is over

- **Status:** Accepted, 2026-10-26, decided for the owner while he was away ("look at the morndo board and check what is
  genuinely stale … decide on my behalf"). Built in the pull request that adds this file.
- **Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), ADR-0035 (the forge adapter and its
  repositories).
- **Rules:** B18 and D7 in `docs/domain.md`. No migration: a block's waits live in the move event that named them.

## Context

A block's reason is free text, and nothing re-reads it. On 2026-10-25 seventeen tasks were blocked; at least five sat on
something that had already happened: a merge tap given four days before (T-331, 100 h), a pull request merged three
days before (T-364), a release run by hand the night before (T-295, T-353), a roll that had already shipped the code
(T-21, T-426). The hourly check is told to unblock blocked tasks, and still did not: a reason in words gives it nothing
to check. The owner reads the board in the app; a column of stale blocks is the first thing that makes it untrustworthy.

## Decision

1. **A block may name its waits** (B18): up to three things the hub can read without a person. Another task on the board
   (over when done), a pull request in a repository the hub reads (over when merged or closed), a card on the owner's
   list (over when closed), or a time with its offset (over when reached). They are given with `--on` (`T-11`, `#93`,
   `owner/repo#93`, `ny-530`, `until:2026-10-28T09:00+01:00`) and judged by the domain (`board-waits.ts`). A wait the
   hub could never read is refused at the block, never held: an unknown spelling, a repository outside
   `MORNDO_PROOF_REPOS`, the task itself, a time already past or more than 90 days ahead.
2. **The hub reads them itself** (`WaitWatch`): the board for a task, the forge for a pull request (the proof's adapter,
   credential and rate-limit wall; each pull request at most every five minutes), the manager's ledger for a card (as
   the decision cards read it), the clock for a time. A pass runs every two minutes and at once after a block that names
   waits. What was not read is unknown, never over.
3. **D7: when every wait is over, the board moves the task to do**, as actor `board (D7)`, with the reason
   `its wait is over: #93 merged, T-11 done`. It is the only edge D7 takes, it needs no Run and no assignee, and it names
   the revision the waits were read at, so a task changed meanwhile is judged again on the next pass (B6). Never to
   Done, never an assignment (D5).
4. **A block may be restated** while blocked, to change its reason or name its waits, by whoever may block it; the same
   block again is refused as `same`.
5. **The waits live in the move event**, not in a column: a task's waits are its latest move's, if that move was to
   blocked. An older hub after a rollback writes moves without waits, so no stale waits can come back with a column it
   never cleared, and no migration is needed.
6. **A block of words only that nobody changed for 48 hours is flagged** (`staleBlocks` in the board view, `[blocked N d
   on words only]` in `morndo-board list`). It is not moved: the board cannot tell whether it is over.

## Consequences

- The manager's board block (`morndo-board prompt --role manager`) tells it to name waits; the release refreshes that
  block in its CLAUDE.md. The app shows a block's waits on its card and in its panel, and the record words a D7 move as
  "when what it waited on was over".
- The hub reads more from GitHub: at most one request per watched pull request every five minutes, behind the same wall
  as the proof checks.
- Blocks that existed before stay words only until someone restates them with `--on`.
- Not done yet: the app shows the waits as named, not the hub's latest readings of them (those are in the CLI's `list`
  and `show`).
