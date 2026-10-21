# The board follows the fleet (ADR-0032)

**Phase: slice 1, building.** Request: issue #74. Builds on the board (ADR-0015), reliable lanes (ADR-0027) and background jobs (ADR-0017).

## 1. Why

The board was out of date because it depended on agents remembering to move their tasks. Measured on the live fleet over the 7 days to 2026-10-20:

- 77 of the 122 lanes that ended a turn never had a task on the board, and they ended 593 of the 1,191 turns.
- Tasks outlived their lanes. One task sat in progress for a lane that no longer existed, and another sat in review for 117 hours after its lane had gone.
- 713 of 1,201 turn ends (59%) left background work running, 90 left a wake-up scheduled, and 65 said WAITING with nothing pending. The app showed all of these lanes as idle.
- `morndo-board list --json` read through a pipe stopped at 64 KiB while the board was 181 KB (#69), so the manager often read a broken board.

Agent boards that work keep the task a person asked for apart from the run an agent did, and derive the run's state from events instead of the agent's word: Linear's agent sessions, Vibe Kanban's sessions, Devin's `status` and `status_detail`, Multica's `reason_code`. Section 9 lists the sources.

## 2. Bounded contexts

| Context | Owns | Code |
|---|---|---|
| **Runs** (new, in the Fleet) | What each lane is doing now, derived from what the fleet observed. | `packages/domain/src/run.ts` (pure), `apps/fleet/src/application/runs.ts`; `GET /v1/runs`, `run` events |
| **Board** (the hub) | Tasks: what is asked, who owns it, and their acceptance. Plus the board's own moves, which follow runs. | `packages/domain/src/board.ts`, `apps/hub/src/application/board-projector.ts` |
| **Relay** (the node) | The once-per-turn asks to a lane. The status ask exists; the waker ask is new. | `apps/node-agent/src/relay/status-ask.ts` |

The Fleet supplies the Board (customer and supplier). The Board reads runs and never writes them. The Fleet never reads the board.

## 3. Runs

| Term | Means | Is not |
|---|---|---|
| Run | One lane's current activity: its phase, what it waits on, until when, and how the fleet knows. | A task, or a turn. |
| Phase | `working`, `waiting`, `needs_you`, `ended`, `gone`, or `unknown`. | A board status. |
| Wait | What a waiting run waits on: `background` (the agent CLI's own background tasks), `wakeup` (a scheduled wake-up), `job` (a Morndo job of that lane), or `declared` (it said WAITING, and nothing will wake it). | An excuse to stop. |
| Deadline | When a wait should have produced a sign of life. | A timeout that kills anything. |
| Source | What told the fleet: `hook` (the agent CLI's own hook fields), `session` (the node's session state), `job`, or `status` (the lane's turn-end status line). | Proof that the work is right. |

| # | Invariant |
|---|---|
| R1 | A run's phase comes only from what the fleet observed: hooks, the node's session state, jobs, and the lane registry. Nothing written to the board sets it. Of a lane's own words, only its turn-end status line counts. |
| R2 | A turn end that leaves background work running or a wake-up scheduled is never `ended`. The run waits on its own work until a later turn starts, or until a later turn end reports nothing pending. |
| R3 | Every wait has a deadline: the `for` of its WAITING line, else `laneWatch.waitingMin`. For a wake-up whose schedule can be read, the deadline is its next fire time plus 5 minutes. A wait past its deadline with no activity since is overdue, which is the lane watch's `stale`. |
| R4 | A WAITING turn end with nothing pending and no job of that lane (queued, starting or running, by its lane or its notice) is a `declared` wait. It is shown as having no waker, and the relay asks once for one (W1). |
| R5 | A lane whose window is gone while its node is online is `gone`. While its node is not online, its run is `unknown`, never `working`. |
| R6 | A run carries no command line and no prompt. A background task shows only its type and a description of at most 80 characters, through the shared redactor. A wake-up shows only its fire time and whether it recurs (FL14). |
| R7 | Precedence, first match wins: gone, unknown, needs_you, working, job, background, wakeup, declared, ended. |
| R8 | Every run names its source and the time its phase began. |

`working` means a hook came after the lane's last turn end, or the node reports the session `busy` or `shell` and the last turn end left nothing pending. Claude Code shows `shell` while a background shell runs after its turn ended, which is the lane's own work, not a turn. `needs_you` means the node reports the session `waiting`, or a `needs_input` came after the last turn end with no `answered` since.

## 4. The board's own moves

| # | Invariant |
|---|---|
| B10 | The board moves a task by itself, as actor `board`, only along these edges. The record names the rule and the run it read. |
| D1 | In progress to in review: the assignee's turn ended `done` after the task's last change of state, even while its background work is still running (the run keeps the turn's outcome). The reason is its status line, or "background work still running" while that work runs. |
| D2 | In progress to blocked: the run ended `blocked` or `needs_decision`. The reason is its status line. |
| D3 | In progress to to do: the assignee's run is `gone`. The reason is "its lane stopped without DONE". |
| D4 | To do, blocked or in review to in progress: the assignee's run is `working` or `waiting` since after the task's last change, the lane has no other task in progress (B5), and this is its only open task. |
| D5 | The board never moves a task to done, and never assigns or edits one (B2, B3, B9 hold). |
| D6 | A run whose phase began before the task's last change of state (status, assignee or description; a comment is not one) moves nothing, so the board never undoes a move a person or a lane made after it. |

**The console actor.** `morndo lanes start <name> --task T-12` assigns T-12 to the new lane as `console`, the control plane's console, which already acts for the principal (`memory approve`, `pair`, `revoke`). The lane's first turn then moves T-12 to in progress (D4).

## 5. The waker ask

| # | Invariant |
|---|---|
| W1 | Some Claude Code Stops are asked once to give their wait a waker: the status line says WAITING, `background_tasks` and `session_crons` are empty, and no job of that lane is queued, starting or running on its node (by its lane or its notice). The rules are the status ask's: never the orchestrator, never after a Stop-hook continuation, and once per turn. A waker is a scheduled wake-up, a `morndo job start --notify lane:<lane>`, or a settled status (DONE, BLOCKED or NEEDS DECISION). |

## 6. The wire

- **Lane event `finished`** gains `tasks?: { type, label }[]` and `wakes?: { schedule, recurring }[]`, at most 8 of each (R6).
- **`RunView`:** `{ lane, node, sessionId?, phase, wait?, deadline, overdue, outcome?, line?, question?, since, source }`. Here `wait` is one of:
  - `{ on: "background", tasks }`
  - `{ on: "wakeup", next }`
  - `{ on: "job", jobs: { id, name }[] }`
  - `{ on: "declared", what }`
- **Fleet API:** `GET /v1/runs` returns `{ runs: RunView[] }`. The `run` event on `/v1/events` carries a run whenever it changes.
- **Board frame:** gains `runs: RunView[]`. `BoardActor` gains `{ kind: "board", rule, lane }` and `{ kind: "console" }`.

## 7. The app (in the current design)

- **Card:** the assignee's avatar gets a ring for its run. Working is solid, its own work is dashed, a wake-up is dotted, and needs-you or no-waker is in the warning colour. A live line under the title gives the run in words. The "not running" chip stays.
- **Header pills:** "N working now" and "N waiting on their own work".
- **Lanes without a task:** a row above the columns names the lanes that are working or waiting with no open task, so their work is never off the board.
- **Moves:** a card that changes column moves there with Svelte's crossfade, and its avatar moves with it. Under reduced motion nothing animates.

How the app does it (`apps/web/src/lib/desktop/`; the words and classes in `run-words.ts`, tested in `apps/web/test/run-words.test.ts`):

- **Decoding:** the feed decodes the frame's `runs` one by one with `RunViewSchema` and keys them by lane (`board.ts` `decodeRuns`); one it can't read is dropped. A frame without `runs` shows no ring, line or count. Of two runs with one lane name, the one whose lane is there wins.
- **Which card:** a lane's run shows on one card, its task in progress, else its open task changed last. Backlog and done cards keep a plain avatar.
- **Ring** (`RunAvatar.svelte`): an outline 2px off the avatar. Its shape says what the lane is on, its colour how it stands:

  | Run | Ring |
  |---|---|
  | working | solid `--working`, a soft pulse |
  | waiting on background or a job | dashed `--working` |
  | waiting on a wake-up | dotted `--muted` |
  | declared (no waker) | dashed `--warn` |
  | needs you | solid `--warn` |
  | overdue | its wait's shape in `--warn` |
  | ended, gone, unknown | none |

- **Live line:** 12px, muted, one line, with a dot in the phase's colour (`RunDot.svelte`):
  - "Working · 3m"
  - "In the background: npm test (+1 more) · 6m"
  - "Job e2e running"
  - "Wakes at 14:42", or "A wake-up is scheduled"
  - "Says waiting on the deploy · nothing will wake it"
  - "Needs you: …"
  - "Said DONE: …", "Said BLOCKED: …", "Said NEEDS DECISION: …"; no status line is "Idle"
  - "Its machine is offline"

  An overdue wait adds " · overdue". A gone lane has no line: its card shows "not running", whatever the hub's lane list says.
- **The record:** the console is "console". A board move reads "board moved it to In review when builder said DONE: …". D2 reads "… said it is blocked or needs a decision", D3 "… when builder stopped", D4 "… when builder started on it".
- **The row:** "Without a task", a chip per lane with its ringed avatar, name and phase word. A click opens the lane's channel, as the task panel's "Open <lane>" does.
- **Moves:** the leaving card is inert (Svelte's outro) and loses its `data-task`, so a key is on one card at a time.

## 8. Acceptance (slice 1)

- Domain tests for R1 to R8 and D1 to D6, each with a negative control.
- Fleet:
  - `GET /v1/runs` and the `run` event, against a real fleet with an agent's hooks.
  - A Stop with a background task gives `waiting` on `background`, and the next turn gives `working`.
  - A lane whose window closes gives `gone`.
  - A job of the lane gives `job`.
- Relay: W1 asks once and never the orchestrator. A pending task or job means no ask.
- Hub:
  - The projector moves tasks by D1 to D4 against a real board store.
  - A manual move after a run is not undone (D6).
  - `lanes start --task` assigns the task as `console`.
- App: the e2e board check still passes, and the new ring, live line and lanes-without-a-task row show.
- **Live QA on a real lane:**
  - A background shell shows `waiting` and then `working`.
  - A WAITING with nothing pending is asked for a waker.
  - DONE moves the task to in review.
  - Stopping the lane moves its task back to to do.

Not in slice 1: review and merge lanes attaching to a parent task, filing a task for a lane with none, evidence on each review (#58), and expiring old proposals.

## 9. Sources (read 2026-10-20)

- Claude Code hooks: Stop input `background_tasks` (id, type, status, description, command) and `session_crons` (id, schedule, recurring, prompt), which "let hooks distinguish 'session is done' from 'session is paused waiting for background work to wake it back up'". `UserPromptSubmit` also fires when a scheduled task fires and when a background subagent reports back. https://code.claude.com/docs/en/hooks
- Linear agent sessions: states `pending`, `active`, `awaitingInput`, `error`, `complete` and `stale`, tracked "automatically based on the last emitted activity". https://linear.app/developers/agent-interaction
- Devin v3: `status` plus `status_detail` (working, waiting_for_user, waiting_for_approval, finished). https://docs.devin.ai/v3-openapi.json
- Multica: heartbeats, a `reason_code` on a skipped run, and status categories kept apart from agent starts. https://github.com/multica-ai/multica
- Vibe Kanban: an issue holds workspaces, a workspace holds sessions, and runs still marked running are reconciled at startup. https://github.com/BloopAI/vibe-kanban
