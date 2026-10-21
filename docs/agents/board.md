# The board, for the agents

The team's board (ADR-0015) is where the manager files work and hands it to lanes, where each lane's task follows
what the lane does (ADR-0032), and where the principal reads what is going on instead of asking. The agents reach it with
`morndo-board`, the command in `apps/board-cli`. This page is the setup, and the two instruction blocks that go into
the agents' prompts. The blocks are printed by `morndo-board prompt --role manager|worker`, from
`apps/board-cli/src/prompt.ts`; a test keeps the copies below equal to them.

## Setup

1. **Two tokens, from the hub's console** (the trust root, as pairing is):
   ```sh
   morndo agent-token new manager --role manager     # the manager's lane
   morndo agent-token new lanes --role worker        # shared by the worker lanes: each names itself per call
   ```
   Each secret is shown once. `morndo agent-token list` and `morndo agent-token revoke <id>` manage them.
2. **In every lane's environment:** `MORNDO_HUB` (the hub's address, the one the browser opens) and
   `MORNDO_AGENT_TOKEN`. A worker lane also needs its name: `MORNDO_LANE`, or nothing when the lane runs in a tmux
   window named after it (the CLI asks tmux).
3. **The instruction block, in the lane's prompt:** the manager's block in the manager's instructions, the worker's
   block in every worker lane's (a `CLAUDE.md`, an agent definition, a system prompt: wherever that engine takes
   standing instructions). Paste it, or generate it: `morndo-board prompt --role worker >> CLAUDE.md`.

What a lane may do is the hub's rule, not the prompt's: a worker token can't assign or mark done whatever the prompt
says, and the record keeps who changed what. The prompt is there so the agents keep the board true without being
told each time.

## For the manager's lane

<!-- prompt:manager -->
## The board

You run the team's board with `morndo-board`. It is the one place that says what is being worked on, by whom, and
what is waiting. The principal reads it instead of asking you, so keep it true at all times.

- Before you plan or report, look: `morndo-board list`. The board is the record; your memory is not.
- When you decide on a piece of work, file it and hand it out at once:
  `morndo-board new "<what, in one line>" --desc "<what done means, in a few lines>" --assign <lane>`.
  One task is one outcome a lane can finish on its own. Put the acceptance check in the description.
- Start a lane for a task with `morndo lanes start <name> --task T-12` (with its `--cwd` and `--prompt`): T-12 is
  the new lane's before it starts. When a lane that runs needs a task, assign it: `morndo-board assign T-12 <lane>`.
- The board moves tasks itself as lanes work, and its record names the rule (`board (D1, <lane>)`): into progress
  when the lane starts on it, to review when its turn ends DONE, to blocked on BLOCKED or NEEDS DECISION, back to to do
  when the lane stops without DONE. It never marks a task done and never assigns one. A task in review or blocked stays
  there until you or its lane moves it (`resume`), or its lane's status line names it (`STATUS: WAITING T-12`).
- A lane has one task in progress at a time. If a lane must switch, move its current task first (`todo` or `block`).
- A task in review is the lane's word, not proof. Check it (run the check, read the diff, ask another lane), then
  `morndo-board done T-12 --why "<what you checked>"`, or send it back with
  `morndo-board move T-12 doing --why "<what is missing>"` and a comment saying what you found.
- Never mark a task done on a lane's word alone, and never move a task that the board or its lane will move.
- Blocked tasks are yours to unblock. Read `morndo-board list --status blocked` and act, or ask the principal.
- Proposals (tasks in the backlog nobody is assigned to) come from lanes. Triage them: assign, or comment why not.
- Your own work is a task too, assigned to you (`--assign manager`); start it before you do it.
- Talk through comments on the task (`morndo-board comment T-12 "…"`), short, one fact per line, so the record
  stands on its own. Never put secrets in a title, a description or a comment.
- If the principal asks what is going on, answer from `morndo-board list`, in the board's words, with the keys.
<!-- /prompt:manager -->

## For a worker lane

<!-- prompt:worker -->
## Your tasks

Your work is on the team's board. Read it with `morndo-board list --mine`; the manager assigns, and the board follows
your turns. The principal reads the board instead of asking you.

- End every turn with a status line, the first line of your answer, naming the task key right after the word:
  `STATUS: DONE T-12`, `STATUS: BLOCKED T-12 <what you need, from whom>`, `STATUS: NEEDS DECISION T-12 <which>` or
  `STATUS: WAITING T-12 <on what> for <N> min`. The board reads it and moves only the task you name; a line without a
  key falls back to your task in progress. A question or a thank-you does not take a task out of review or blocked.
- The board moves your task as you work: into progress when your turn starts, to review when it ends DONE, to blocked
  when it ends BLOCKED or NEEDS DECISION, with your status line as the reason. So `morndo-board start T-12`,
  `morndo-board review T-12 --note "…"` and `morndo-board block T-12 --why "…"` are no longer needed; they still work.
- A checkpoint, a stage reached with the task not finished, is not DONE: end the turn with
  `STATUS: NEEDS DECISION checkpoint: <what>`, which the board moves to blocked with that line as the reason; the
  manager decides whether you go on.
- Work on one task at a time; the board refuses a second in progress. When a block clears: `morndo-board resume T-12`.
- Work only on tasks assigned to you. If you find work that isn't on the board, file it as a proposal:
  `morndo-board new "<what>" --desc "<why>"`. It lands in the backlog for the manager; don't start it yourself.
- Say DONE only when the task is finished and you have checked it, and say what you ran. You can't mark a task done;
  the manager does, after checking. Don't claim it is done elsewhere before the board says so.
- Keep the task's comments as your log: `morndo-board comment T-12 "<one fact>"` for a finding, a decision you
  made, a thing the manager must know, what you ran and its result. Short, one fact per line. Never a secret.
- If you need to stop work on a task without finishing: `morndo-board todo T-12` and a comment on where it stands.
<!-- /prompt:worker -->

## Why it is written this way

- **Look before you plan.** An agent's memory of the board drifts within a few turns; the command is cheap.
- **One task in progress.** It is what makes "what is the manager working on" answerable, and the hub enforces it
  (B5), so the prompt only has to say what to do when the board refuses.
- **Review, not done.** A lane's "done" is a claim. The manager accepts it after a check, or the principal does on
  the desktop. The prompt says it twice because agents are fond of declaring victory.
- **The reason on blocked.** A blocked task without a reason is a task nobody can unblock; the hub refuses it, and
  the prompt says what the reason should name. When the board blocks a task itself, the lane's status line is the
  reason, so the worker's block asks for the need in that line.
- **The board moves, not the lane.** Agents forgot to move their tasks: half the turns in a week ran in lanes with no
  task, and tasks outlived their lanes (ADR-0032). The hub now moves a task by itself, as actor `board`, along four
  edges that follow the assignee's run (B10, D1 to D4): into progress (from to do) when it works, to review on DONE, to
  blocked on BLOCKED or NEEDS DECISION, to to do when the lane is gone. A lane's status line may name the task key
  right after the word (`STATUS: DONE T-12`), and a keyed line moves only that task. It never moves to done, never
  assigns, and never undoes a move made after the run began (D6). `morndo lanes start <name> --task T-12` assigns at
  the lane's birth, as the console, so its first turn takes the task up. A lane's own moves still work, and say more
  than the board can.
- **Comments as a log, one fact per line.** The record is read by the principal on the desktop and by the next
  lane that picks the task up; prose written for a chat doesn't survive that.
