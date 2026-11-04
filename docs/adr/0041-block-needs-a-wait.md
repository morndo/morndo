# ADR-0041: A block needs a watched wait

- **Status:** Accepted, 2026-11-04, decided for the owner while he was away. Built in the pull request that adds this
  file; this is part B.
- **Builds on:** ADR-0015 (the board), ADR-0038 (a block names what it waits on), ADR-0040 (a board that cannot go
  stale silently).
- **Rules:** B21 and B22 in `docs/domain.md`. No migration: the one new field on a move event (`unwatched`) is optional,
  so an older hub or CLI never sees it.

## Context

The 2026-11-04 cleanup (ADR-0040) found 18 blocks of words only: a task blocked on "the owner's keys", "the release",
"the other team", with nothing the board could read and nobody bound to answer. B18 gave a block a way to name what it
waits on and B20 flags what sits too long, but nothing made a lane name anything: filing the block stayed as easy with
a wait as without one, and the stale list only ever grows. The same cleanup showed the other half: a lane ends its turn
BLOCKED and the board blocks the task, but the answer to "who does something next, and when?" lives nowhere but the
prose of the reason.

## Decision

1. **A block gate (B21).** A move to blocked by a person or a lane — a restatement too — that names no wait and asks
   no decision is refused (`no_wait`). The board's own moves are never gated (D2 blocks on the status line alone, D5:
   the board grants nothing), and a decision never is (B19: it is the manager's to answer, with its own deadline and
   inbox). The hub's setting is `MORNDO_BLOCK_GATE`: `off`, `warn` or `on`, any other value refused at start as
   `MORNDO_PROOF_GATE`'s is; unset, the gate warns and refuses from 2026-11-12T00:00Z, the one week the manager
   approved, read per change against the hub's clock so a hub that runs past the date refuses without a restart. In
   `warn` the block is taken and the move event carries `unwatched: true`; the CLI prints a notice naming the date and
   the waits it could name. The cap a time wait must fit drops from 90 days to 31.
2. **`next:` on status lines (B22).** A status line may end with `next: <who> by <when>`: who owes the next move on
   the task — the owner, the manager, a lane, a task key — and by when, as a date (that day's 23:59 UTC), an instant
   with Z or an offset, or `in <N> min|h` resolved against the run the line rode in on. The hub passes a next on only
   while it is ahead and within the 31-day cap, and D2's block then carries it as the block's `until:` wait, so the
   board itself ends the block — the same watch B18 gives a typed `--on`, without anyone typing it. A next already
   past, or too far ahead, is dropped, never a refusal: a board block is never lost to the clock, and a wait that
   slips into the past between the reading and the move is retried without it. The node's relay asks a BLOCKED or
   NEEDS DECISION answer with no next for one (`NEXT_ASK`, third after the status ask and the waker ask; the
   contract's `statusContract.next` turns it off), never a WAITING one: a wait has its lease and a waker (W1), and it
   makes no block.

## Consequences

- Blocks filed after the switch date are watched or ask a decision; a lane that will not name either cannot park a
  task. Blocks filed before it are not touched: they stay as they are, and B20's sweep still lists them.
- A lane's status line alone can now make a block self-ending, which is less to type than `--on` and read by the same
  watch; the ask at the relay means a lane that forgot gets one prompt, once per turn.
- The notice and the refusal name the 31-day cap and the five spellings of a wait, so the words an agent needs are in
  the answer it gets.
- The prompt blocks in `docs/agents/board.md` and `morndo-board prompt` say a block names a wait and show `next:`.

## Alternatives

- **Refuse at once, no warn week.** Every existing block would be fine (the gate judges only new moves), but every
  lane habit that files words-only blocks would break on one morning, mid-task, with nothing in the answer but the new
  refusal. One week of warnings teaches the ask and softens none of the rule.
- **A 7-day cap instead of 31.** The board held four real `until` waits from 2026-11-15 to 2026-12-04 when this was
  written; a 7-day cap would have refused them, so the cap takes nothing a block really used and 31 days stands.
