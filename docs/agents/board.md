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

4. **Proof of work: which repositories the board checks** (settings of the hub process, read once at start: set them in
   the hub's environment, then restart it). A brief's `--pr` and `--ci` references are fetched by the hub itself
   ([ADR-0035](../adr/0035-proof-refs-on-review.md)), and only from repositories the settings list:
   - `MORNDO_PROOF_REPOS`: `owner/repository` names, comma-separated, for example `acme/shop,acme/api`. **Unset, the
     default is only `morndo/morndo`**, so on your own install every brief naming your repository is refused when it is
     filed (`ref_repo`) until you set this. A name must be whole (`owner/repo`); a hub given a bad one does not start.
     Task data never adds a repository: a merge record or a lane's words cannot widen the list.
   - `MORNDO_PROOF_GATE`: `off`, `warn` (the default) or `on`. In `warn` a Done is accepted and the Done event records
     what the board saw, with "would have been refused" where `on` would have held it; `on` refuses it
     (`proof_not_green`) unless the manager overrides with a reason.
   - `MORNDO_GITHUB_TOKEN_FILE`: an absolute path to a mode-600 file holding a read-only token, for private
     repositories. Without it a private repository's references read `not checked`, and the gate holds a Done over them
     like any reference that is not green.

   The gate holds a Done over: a reference that is not green (a pull request whose commit has a check failing or still
   running that its base branch requires, branch protection or ruleset, while an optional one shows as a ⚠ warning on the
   reference and holds nothing, and every check counts when the hub cannot read the required set; a `ci` reference whose named checks passed while another check at that commit failed or is running);
   a proof-list item nothing in the brief answers; and a brief that claims no code change on a task whose assigner
   listed no proof (the claim is the lane's word, so it needs the assigner's list to be checked against).

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
- When you assign a task, say what proof it needs: `morndo-board new "<title>" --assign <lane> --proof "pr@owner/repo: the pull request" --proof "ci@owner/repo: CI green" --proof "data: a sample of 30 rows"`, or later `morndo-board proof T-12 --add "<kind[@owner/repo]: text>"`. Kinds pr and ci the board checks itself; tests, manual, ui, data and infra are the lane's word. An item nothing in the brief answers shows `not covered` and holds the done when the gate is on.
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
- A task in review shows its proof line in `morndo-board list` and `show`: references the board checked itself are
  marked ✓ ✗ ≠ ? ! … ○; the lane's own checks are only its word. When the gate is on, a done with a reference that is
  not green is refused (`proof_not_green`); accept it only with `--proof-override "<what you looked at instead>"`, and
  never over a red reference without saying what you saw. `done --why` names a commit or `#n` the board did not verify:
  it warns, and still sends.
- When a task's PR has merged, record it: `morndo-board merged T-12 <sha>`. Done is then refused until the merge is on every
  node's build; the board says which node is behind. Accept it earlier only with `--not-live "<why>"`.
- A wrong sha: `morndo-board unmerged T-12 <sha>`, then record the right one.
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
  `STATUS: NEEDS DECISION T-12 checkpoint: <what>`, which the board moves to blocked with that line as the reason; the
  manager decides whether you go on.
- Work on one task at a time; the board refuses a second in progress. When a block clears: `morndo-board resume T-12`.
- Work only on tasks assigned to you. If you find work that isn't on the board, file it as a proposal:
  `morndo-board new "<what>" --desc "<why>"`. It lands in the backlog for the manager; don't start it yourself.
- Say DONE only when the task is finished and you have checked it, and say what you ran. You can't mark a task done;
  the manager does, after checking. Don't claim it is done elsewhere before the board says so.
- The manager may list the proof your task needs (`morndo-board proof T-12`). Answer every item in your brief: a `--pr` or `--ci` reference in that repository for pr and ci items, a `--test`, `--manual`, `--ui`, `--data` or `--infra` line of the same kind for the rest. You may add items of your own (`morndo-board proof T-12 --add "…"`); you cannot remove the manager's.
- File your brief before you end the turn, at the latest when the task is in review: `morndo-board brief T-12
  --summary "<what changed, for whom>" --left-out nothing --limit "none known" --pr owner/repo#42@<sha> --ci
  owner/repo@<sha>:ci,lint --test "<command: result>"`. A reference is whole (repository, number, sha) and the board
  checks it itself; what you ran yourself goes in `--test`, `--manual`, `--ui`, `--data` or `--infra` and is shown as
  your word, never as verified. A task with no code change says `--no-code "<what it is>"`. `morndo-board brief T-12
  --show` says how each reference checked out.
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
- **The brief is the lane's word, the references are the board's.** The lane names references (a pull request at a
  commit, that commit's checks) and the board fetches them itself, so a claim of green is never an input: what the
  lane ran on its own machine is shown as its word, and a done is held until the board's own checks are green.
