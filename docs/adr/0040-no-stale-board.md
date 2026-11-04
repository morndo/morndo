# ADR-0040: A board that cannot go stale silently

- **Status:** Accepted, 2026-11-04, decided for the owner while he was away. Built in the pull request that adds this
  file; this is part A.
- **Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), ADR-0038 (a block names what it waits on).
- **Rules:** B19 and B20 in `docs/domain.md`. No migration: a decision's deadline lives in the move event that set it,
  as B18 gives a block's waits.

## Context

On 2026-11-04 a cleanup of the board found it had gone stale in the ways a board goes stale when nothing checks it:
46 blocked tasks; 8 checkpoints a lane had asked and no manager had answered, one for four days; 18 blocks of words
only, waiting on nothing the board could read; and pull requests merged days before that the board still showed as
open work. The board is the one place that says what is being worked on (ADR-0015); a column nobody believes is worse
than no board, because it answers questions wrongly. B18 gave blocks a way to end themselves; nothing yet says to a
person "this has sat, and nobody answered".

## Decision (part A)

1. **A block may be a decision (B19)**: the asker waits on the manager's answer. The move says so (`--decision`, or
   the board's own D2 move when a lane's turn ends NEEDS DECISION), and the block carries a deadline 24 h after it was
   asked, on the task and in the move event. A restatement that is still a decision keeps the first ask's clock, a
   restatement without the flag ends the decision, and leaving blocked ends it too — B18's rule for waits, applied to
   the deadline, so no migration and an older hub's later block can never bring a deadline back.
2. **The decision inbox**: the hub reads the blocked tasks and sends the manager's lane the open decisions with their
   deadlines, at most hourly while any wait, again at the next pass when a message did not go. An answer — a comment
   by the manager, the principal or the console after the ask — closes an item without moving the task. A decision
   past its deadline with no answer tells the principal once, numbers only, as every push is. A blocked task from
   before the rule, whose reason says it needs a decision or is a checkpoint, is an inbox item from the hub's start:
   its clock begins there, once, and a restart may tell the principal of an overdue one a second time.
3. **The stale sweep (B20)**: a task in blocked or review that nobody changed for 48 h — a comment, a brief or a merge
   record is a change — and that the board watches nothing on (no wait it has read, no merge still going live, not a
   decision) is stale. The hub sends the manager's lane the list: at once when the list changed, at most every 12 h
   while it is unchanged. The board grants nothing here (B8): it lists, it never moves a task on stale alone.

Both send through the fleet's delivery queue under ids of their own (`board-inbox:<when>`, `board-stale:<when>`), and
neither types anything itself. The CLI shows the same reads to a person: `inbox` and `stale`.

## Consequences

- The manager's prompt block tells it to answer from `inbox`, and to ask its own checkpoint with `block --decision`.
- A lane asking a decision no longer needs the manager to notice a column: the lane's status line alone (D2) opens an
  inbox item with a deadline.
- The principal's push is counts only, as the payload's schema demands; the line naming the task goes to the
  manager's lane, and the app's own words for a decision's deadline are not part of this.
- The hub reads the tasks each pass; nothing new is asked of any other machine.

## Later parts (planned, not this one)

- A block gate: refusing a block of words only when a wait could have been named.
- Next lines: what a lane should pick up when its task is closed out from under it.
- Reading the merges of a task's pull requests itself, so the board stops trusting a lane's word that one merged.
