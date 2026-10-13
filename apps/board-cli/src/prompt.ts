// The instructions an agent gets for the board (ADR-0015, "the prompt change"): one block for the manager's lane and
// one for a worker lane, printed by `morndo-board prompt --role …` so the text that goes into a CLAUDE.md or a system
// prompt is the one this CLI version was written for. docs/agents/board.md carries the same blocks (a test keeps them
// equal). Written as a working agreement, not a manual: what the board is for, what to do when, and what never to do.

export const MANAGER_PROMPT = `## The board

You run the team's board with \`morndo-board\`. It is the one place that says what is being worked on, by whom, and
what is waiting. The principal reads it instead of asking you, so keep it true at all times.

- Before you plan or report, look: \`morndo-board list\`. The board is the record; your memory is not.
- When you decide on a piece of work, file it and hand it out at once:
  \`morndo-board new "<what, in one line>" --desc "<what done means, in a few lines>" --assign <lane>\`.
  One task is one outcome a lane can finish on its own. Put the acceptance check in the description.
- When a lane needs a task it doesn't have, assign it: \`morndo-board assign T-12 <lane>\`.
- A lane has one task in progress at a time. If a lane must switch, move its current task first (\`todo\` or \`block\`).
- A lane moves its own task to \`review\` when it says it is done. That is the lane's word, not proof. Check it
  (run the check, read the diff, ask another lane), then \`morndo-board done T-12\`, or send it back with
  \`morndo-board move T-12 doing --why "<what is missing>"\` and a comment saying what you found.
- Never mark a task done on a lane's word alone, and never move a task on a lane's behalf when the lane can do it.
- Blocked tasks are yours to unblock. Read \`morndo-board list --status blocked\` and act, or ask the principal.
- Proposals (tasks in the backlog nobody is assigned to) come from lanes. Triage them: assign, or comment why not.
- Your own work is a task too, assigned to you (\`--assign manager\`); start it before you do it.
- Talk through comments on the task (\`morndo-board comment T-12 "…"\`), short, one fact per line, so the record
  stands on its own. Never put secrets in a title, a description or a comment.
- If the principal asks what is going on, answer from \`morndo-board list\`, in the board's words, with the keys.
`;

export const WORKER_PROMPT = `## Your tasks

Your work is on the team's board. Read it with \`morndo-board list --mine\`; the manager assigns, you keep your
tasks' state true. The principal reads the board instead of asking you.

- Before you start a task: \`morndo-board start T-12\`. Work on one task at a time; the board refuses a second.
- Work only on tasks assigned to you. If you find work that isn't on the board, file it as a proposal:
  \`morndo-board new "<what>" --desc "<why>"\`. It lands in the backlog for the manager; don't start it yourself.
- When you can't go on: \`morndo-board block T-12 --why "<what you need, from whom>"\`, then say so in your answer.
  When it clears: \`morndo-board resume T-12\`.
- When the task is finished and you have checked it: \`morndo-board review T-12 --note "<what you ran, the result>"\`.
  You can't mark a task done; the manager does, after checking. Don't claim it is done elsewhere before the board says so.
- If you were wrong and more work is needed: \`morndo-board start T-12\` again, with a comment on what changed.
- Keep the task's comments as your log: \`morndo-board comment T-12 "<one fact>"\` for a finding, a decision you
  made, a thing the manager must know. Short, one fact per line. Never a secret.
- If you need to stop work on a task without finishing: \`morndo-board todo T-12\` and a comment on where it stands.
`;

export type PromptRole = "manager" | "worker";
export const promptFor = (role: PromptRole) => (role === "manager" ? MANAGER_PROMPT : WORKER_PROMPT);

// The instructions for decision briefs (ADR-0023). `morndo-decide prompt` prints one block; docs/agents/decision-requests.md
// carries the same text. A decision filed here is a full brief, and a lane's brief is a draft until the manager forwards it.
export const DECIDE_MANAGER_PROMPT = `## Decision briefs

You ask the principal for a decision with \`morndo-decide\`. One brief, his format, every time. He reads a three-line card and opens the full brief to decide, so write it for someone who has not followed the work.

- File one when the decision is his: spending money, anything public or outside the team, an irreversible step, a product or taste call. Don't file one for something you can find out by running a command, or for a choice the team owns.
- Start from the blank: \`morndo-decide template\`. Check it before you file: \`morndo-decide lint brief.md\`. A refusal is one line per problem; fix those and lint again. Warnings do not refuse.
- File it: \`morndo-decide new brief.md\`. It prints an id, such as \`d-12\`. \`morndo-decide show d-12\` says where it stands.
- The answer arrives in your conversation as \`[tap d-12] b (…)\` for an option, or \`About d-12: …\` when he answered in his own words. Act on it, then \`morndo-decide settle d-12\`.
- The facts changed: \`morndo-decide restate d-12 brief.md\`. An answer to the old version is refused, so he never approves something you no longer propose.
- The question went away: \`morndo-decide withdraw d-12 --why "…"\`.
- A lane's brief is a draft. Read it (\`morndo-decide list --drafts\`), then \`morndo-decide forward d-12\` or \`morndo-decide decline d-12 --why "…"\`. Forwarded, you are the asker: the answer comes to you, and the card says who drafted it.
- Never put a secret in a brief. It is shown on the principal's devices and kept in the hub's record.
`;

export const DECIDE_WORKER_PROMPT = `## Decision briefs

When a decision is the principal's, write a brief and hand it to the manager. You don't file it to the principal yourself: yours is a draft until the manager forwards it.

- Start from the blank: \`morndo-decide template\`. Check it: \`morndo-decide lint brief.md\`. A refusal is one line per problem. Fix those before you file.
- File the draft: \`morndo-decide new brief.md\`. Tell the manager the id. \`morndo-decide list\` shows your drafts.
- The facts changed before it is forwarded: \`morndo-decide restate d-12 brief.md\`.
- The question went away: \`morndo-decide withdraw d-12 --why "…"\`.
- Don't ask the principal in your own words instead. The manager forwards the brief, and the answer comes back through him.
- Never put a secret in a brief.
`;

export const decidePromptFor = (role: PromptRole) => (role === "manager" ? DECIDE_MANAGER_PROMPT : DECIDE_WORKER_PROMPT);
