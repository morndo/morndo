# The board, for the agents

The team's board (ADR-0015) is where the manager files work and hands it to lanes, where each lane keeps its own
tasks' state true, and where the principal reads what is going on instead of asking. The agents reach it with
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
- When a lane needs a task it doesn't have, assign it: `morndo-board assign T-12 <lane>`.
- A lane has one task in progress at a time. If a lane must switch, move its current task first (`todo` or `block`).
- A lane moves its own task to `review` when it says it is done. That is the lane's word, not proof. Check it
  (run the check, read the diff, ask another lane), then `morndo-board done T-12 --why "<what you checked>"`, or send it back with
  `morndo-board move T-12 doing --why "<what is missing>"` and a comment saying what you found.
- Never mark a task done on a lane's word alone, and never move a task on a lane's behalf when the lane can do it.
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

Your work is on the team's board. Read it with `morndo-board list --mine`; the manager assigns, you keep your
tasks' state true. The principal reads the board instead of asking you.

- Before you start a task: `morndo-board start T-12`. Work on one task at a time; the board refuses a second.
- Work only on tasks assigned to you. If you find work that isn't on the board, file it as a proposal:
  `morndo-board new "<what>" --desc "<why>"`. It lands in the backlog for the manager; don't start it yourself.
- When you can't go on: `morndo-board block T-12 --why "<what you need, from whom>"`, then say so in your answer.
  When it clears: `morndo-board resume T-12`.
- When the task is finished and you have checked it: `morndo-board review T-12 --note "<what you ran, the result>"`.
  You can't mark a task done; the manager does, after checking. Don't claim it is done elsewhere before the board says so.
- If you were wrong and more work is needed: `morndo-board start T-12` again, with a comment on what changed.
- Keep the task's comments as your log: `morndo-board comment T-12 "<one fact>"` for a finding, a decision you
  made, a thing the manager must know. Short, one fact per line. Never a secret.
- If you need to stop work on a task without finishing: `morndo-board todo T-12` and a comment on where it stands.
<!-- /prompt:worker -->

## Why it is written this way

- **Look before you plan.** An agent's memory of the board drifts within a few turns; the command is cheap.
- **One task in progress.** It is what makes "what is the manager working on" answerable, and the hub enforces it
  (B5), so the prompt only has to say what to do when the board refuses.
- **Review, not done.** A lane's "done" is a claim. The manager accepts it after a check, or the principal does on
  the desktop. The prompt says it twice because agents are fond of declaring victory.
- **The reason on blocked.** A blocked task without a reason is a task nobody can unblock; the hub refuses it, and
  the prompt says what the reason should name.
- **Comments as a log, one fact per line.** The record is read by the principal on the desktop and by the next
  lane that picks the task up; prose written for a chat doesn't survive that.
