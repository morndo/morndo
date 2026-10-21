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

## Sources (read 2026-10-20)

- https://code.claude.com/docs/en/hooks: the Stop input fields `background_tasks` and `session_crons`; `UserPromptSubmit` on a fired schedule and on a background subagent reporting back.
- https://linear.app/developers/agent-interaction: agent session states, tracked from emitted activity.
- https://docs.devin.ai/v3-openapi.json: `status` and `status_detail`.
- https://github.com/multica-ai/multica: heartbeats, reason codes, status categories apart from agent control.
- https://github.com/BloopAI/vibe-kanban: tasks, workspaces and sessions, and reconciliation at start.

## Addendum, 2026-10-21: merged, not live (B11)

Needs the build stamp of ADR-0032's B5 follow-up (PR #83): every node reports the version and commit of its agent, and `GET /v1/nodes` carries it as `commit`.

**The problem.** A task's PR merged and the manager marked the task done, while the nodes still ran the build from before the merge. Done on the board said "accepted"; the owner read it as "I have it".

**The rule (domain.md B11).**

1. **A merge is recorded, never read.** `morndo-board merged T-12 <sha> [--repo owner/name]` (default `morndo/morndo`) is set by the manager, the principal, the console or the task's own lane. It is stored with the time and who recorded it, and shown in `show`, `list`, the API (`merged`) and the board frame. The board never reads GitHub. A wrong record is cleared by the manager, the principal or the console with `morndo-board unmerged T-12 <sha>` (a worker cannot, even on its own task); the history keeps both events. A replacement is an `unmerged` and then a `merged`. A task holds at most 5 merge records (each is a git check per node). A lane's own record is first checked once against the hub's checkout and refused (`no_commit`) when the checkout has no such commit, so a lane cannot make the hub run git for any sha it invents; the manager's, the principal's and the console's are not asked (a refused record would leave the task with no merge to hold done for), and an unknown answer (no checkout, git failing) takes the record.
2. **Live means on every node.** A `morndo/morndo` merge is live when, for every enrolled, non-revoked node, `git merge-base --is-ancestor <merge> <the node's build commit>` succeeds. An equal commit counts. An offline node counts with the last build it reported; an online node counts with what it reports now, so one that reports no commit is unknown, never its last one. Until then the task reads `merged, not live: pc on abc1234, srv01 unknown`: each node that blocks, with its build when it is behind, or `unknown`.
3. **Done is refused while the merge is not live.** The refusal names the blocking nodes. The board still never moves a task to done by itself (D5): this only closes the manager's door.
4. **The override is recorded.** `done T-12 --why "…" --not-live "<reason>"` is accepted for the manager and the console. The reason is kept on the task's event (`notLive`) and on the merge, and shown in `show` and `list`. The principal's own accept in the app is never refused: it has no field for a reason, so it is recorded as the override `accepted by the principal`.
5. **Unknown is not live (fail closed).** These all block: no `MORNDO_REPO`, a commit missing from the checkout, a node that reported no commit, and no node at all.
6. **Other repos are unchanged.** A merge in another repo (a client's, or any repo whose builds a node does not carry) never gates done. Node builds say nothing about it.

**How it is computed.**

- The hub setting `MORNDO_REPO` is the path of a Morndo checkout. The hub runs `git merge-base --is-ancestor` in it ([git-merge-base](https://git-scm.com/docs/git-merge-base), read 2026-10-21: status 0 when the first commit is an ancestor of the second, 1 when it is not, another non-zero status for an error). Status 0 is live for that node, 1 is behind, anything else is unknown.
- **The hub never fetches.** The operator keeps the checkout current. A merge commit the checkout has not got yet is unknown, so a stale checkout blocks done instead of letting it through.
- **The node builds** come from the fleet's node list, read when the hub starts and every 15 seconds. The hub remembers the last commit each node reported while it runs, and uses it only while the node is offline. After a hub restart an offline node is unknown until it connects again. The fleet does not keep an offline node's commit.
- **Git never blocks the hub.** The board reads liveness from a cache. A pair (merge, build) that is not cached answers unknown at once and is checked in the background (`execFile`, 5 second timeout, at most 4 at a time); the board frame is pushed when an answer arrives. So a first `done` right after a merge was recorded can be refused as unknown and pass a few seconds later.
- **Answers are cached** per pair: ancestor and not-ancestor for good, unknown with a backoff (30 seconds, doubling to 10 minutes), so a corrected checkout is noticed without git running again every poll.
- **Git gets a clean environment**: only `PATH`, `HOME`, `LANG` and `GIT_TERMINAL_PROMPT=0`, and the checkout is named with `-C`. A `GIT_DIR` or `GIT_WORK_TREE` in the hub's own environment never reaches it.

**The web.** The task panel shows the label (and the blocking nodes) and offers "Accept anyway" while a merge is not live. The board cards do not show it yet (a follow-up). A fleet that keeps an offline node's commit across a hub restart is a follow-up too.
