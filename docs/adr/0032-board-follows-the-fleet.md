# ADR-0032: The board follows the fleet: runs derived from what lanes do, and every wait needs a waker

- **Status:** Accepted, 2026-10-20. Design: [`docs/design/agent-board/README.md`](../design/agent-board/README.md). The request: issue #74.
- **Number:** the next after ADR-0031.
- **Builds on:** ADR-0015 (the board), ADR-0017 (background jobs), ADR-0027 (reliable lanes: status lines, the lane watch, the status ask).
- **Rules:** R1 to R8, B10 with D1 to D6, and W1 in `docs/domain.md`.

## Context

The board held what agents said, and only what they remembered to say. Over a week of live use:

- **Work missing from the board:** half of all turns ran in lanes that had no task.
- **Dead lanes still held tasks:** tasks stayed in progress for lanes that were gone.
- **Waiting looked idle:** 59% of turn ends left background work running, which the app showed as idle.

The fleet already observed nearly everything needed to know better:

- Claude Code's Stop hook carries `background_tasks` and `session_crons`, which exist "to distinguish 'session is done' from 'session is paused waiting for background work to wake it back up'" (hooks reference).
- The node reports each session's state.
- The lane watch knows each lane's last turn and deadline.
- Jobs know their lane.

Agent boards that stay true keep the task apart from the run, and derive the run's state from events: Linear's agent sessions, Vibe Kanban's sessions, Devin's `status_detail`, Multica's reason codes.

## Decision

1. **A Run per lane, in the Fleet.** A pure domain function, `deriveRun`, takes the lane watch's last turn, the session state, the lane's running jobs, the registry and the node's status, and returns the run. The result has:
   - a phase;
   - for a waiting run, what it waits on: background, a wake-up, a job, or declared with no waker;
   - a deadline and whether it is overdue;
   - its source.

   The fleet serves runs (`GET /v1/runs`) and publishes changes (`run` events). Turn-end lane events keep a redacted summary of pending background tasks and wake-ups instead of counts only.
2. **The board's own moves.** A projector in the hub reads runs and moves the assignee's task along four edges: done to review, blocked, gone to to do, and a new turn into progress. It moves as actor `board`, naming the rule. It never moves a task to done, never assigns, and never acts on a run older than the task's last change.
3. **Every wait needs a waker.** The relay's status ask gains a second question. A WAITING turn end with nothing pending, and no job of that lane, is asked once to schedule a wake-up, start a job, or settle.
4. **`lanes start --task`** binds a lane to its task at birth, as the console actor.
5. **The app keeps its design.** Runs show as rings on avatars and a live line on cards, plus two header pills and a row of lanes working without a task.

## Alternatives considered

| Option | Verdict |
|---|---|
| Keep the board manual and remind agents harder (prompt text) | Rejected. That is what failed. Backlog.md needs a whole guide to keep agent-set status "aligned with reality". |
| Compute runs in the hub from raw lane events | Rejected. The facts and their deadlines are the fleet's (the lane watch, the inventory, jobs). Computing them twice would let two answers drift. |
| Let runs move tasks to done | Rejected (B3, B9). Acceptance stays a person's or the manager's. Linear, Copilot and Multica all keep it out of the agent's hands. |
| Read liveness from the screen (pane hashes, prompt text) | Rejected as a primary source. It breaks when the CLI's words change, as Claude Squad does. The session state and hook fields are typed. |
| Auto-file a task for every lane without one | Deferred. A row of lanes without a task shows the work first. Filing comes after we see what those lanes are. |

## Consequences

- **The board tells the truth without anyone's help:** a lane that stops, finishes or blocks moves its card. Waiting is shown as waiting, with what it waits on.
- **Dead waits are caught:** a WAITING with nothing to wake it is asked about at once, instead of being found stale 30 minutes later.
- **Board rule change:** B3's "a lane moves its own tasks" keeps working, and the board's own moves sit beside it, each recorded.
- **Weaker for other engines:** a Codex lane has no `background_tasks`, so its runs rest on the session state, its status line and its jobs. Long waits should go through `morndo job` on every engine.
- **Not yet:** attaching review lanes to their parent task, filing tasks for lanes without one, and evidence on reviews (#58).

## Amendment, 2026-10-21 (B12): the board moves the task a turn is about

The moves followed the run, and the run follows the lane — but a lane's turn is about one task, and on 2026-10-21 the
board misfired four times, among them: a DONE for one task moved another, a read-only question pulled a blocked task
back into progress, and a task in review flipped three times in two minutes as short messages came. So the lane's own
word now says which task the turn is about:

- A status line may name its task key right after the word: `STATUS: DONE T-285`, `STATUS: WAITING T-12 on CI`. D1 and
  D2 with a key move only that task, and only if it is the lane's. A key naming a task that is not the lane's open task
  moves nothing; the board leaves one line about it in the history of the lane's own task in progress.
- Without a key, the rules are unchanged: the line falls back to the lane's task in progress.
- D4 moves only to do → in progress. A task in review or blocked leaves its column only by an explicit move (the
  manager's, or the lane's `resume`) or by a keyed WAITING that names it (D1).

## Sources (read 2026-10-20)

- https://code.claude.com/docs/en/hooks: the Stop input fields `background_tasks` and `session_crons`; `UserPromptSubmit` on a fired schedule and on a background subagent reporting back.
- https://linear.app/developers/agent-interaction: agent session states, tracked from emitted activity.
- https://docs.devin.ai/v3-openapi.json: `status` and `status_detail`.
- https://github.com/multica-ai/multica: heartbeats, reason codes, status categories apart from agent control.
- https://github.com/BloopAI/vibe-kanban: tasks, workspaces and sessions, and reconciliation at start.
