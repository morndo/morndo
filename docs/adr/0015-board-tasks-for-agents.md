# ADR-0015: The board: tasks for a team of agents, run like a real org

- **Status:** Accepted, 2026-10-09. The owner asked for it; built on `claude/funny-fermi-27rrm7`.
- **Builds on:** ADR-0004 (Commands, AC7), ADR-0006 (the desktop, the manager and the lanes), ADR-0008 (migrations, the protocol package, rate limits), ADR-0012 (lanes on many machines).
- **Rules:** B1 to B8 in `docs/domain.md`.

## Context

The requirement: it should be possible to see what the manager is working on without asking. The product needs a board: the manager creates tasks and assigns them to a lane, and the lane updates each task's status. Agent instructions change to match.

Until now the only record of what a lane was doing was its conversation and its screen. The desktop shows both, but neither says what the lane was asked to do, what done means, or what else waits. The manager's needs-you list (the ledger, ADR-0006) holds asks for the principal, not the team's work. Asking the manager "what is going on" costs a turn and gives an answer from memory.

## Decision

1. **A Board context, in the domain** (`packages/domain/src/board.ts`): a task is one outcome a lane can finish, with a key (`T-12`, never reused), a title, what done means, a status in work order (backlog, to do, in progress, blocked, in review, done), an assignee (a lane name), a priority, and a record of every change with who made it. The rules are a real org's:
   - the manager (or the principal) files tasks and hands them out; a lane may file a proposal, which lands in the backlog nobody's (B2);
   - a lane moves only its own tasks, along the work: take up, put back, block with a reason, offer for review, take up again. A lane never marks done (B3, B4);
   - a lane has one task in progress at a time (B5), so the board can say what each lane is doing *now*;
   - done is the manager's (or the principal's) acceptance of a lane's word. It is not a Verdict (V1): the board grants nothing (B8).
2. **The agents reach the board through the hub, with agent tokens** (`apps/hub/src/application/agent-access.ts`). A token is issued from the hub's console (`morndo agent-token new <name> --role manager|worker`), shown once, kept as a hash, revocable. The manager's token acts as the manager; a worker token acts as the lane it names on each call (`X-Morndo-Lane`), so one token serves every lane on a machine. The routes under `/api/agent/` carry no cookie, no Origin and no proxy identity: the token is the identity, and a lane on another node reaches the hub through the proxy as a tagged device, which has no identity header (ADR-0012). Refusals are limited per caller address, calls per token.
3. **A CLI for the agents, `morndo-board`** (`apps/board-cli`), with no dependencies but the hub: `list`, `show`, `new`, `assign`, `start`, `block`, `resume`, `review`, `done`, `todo`, `move`, `comment`, `edit`, `whoami`. A refusal comes back in one line, in words an agent can act on ("T-1 is already in progress for this lane; finish, block or put it back first"), with exit 1; usage is 2; a hub it can't reach is 3. The lane's name comes from `MORNDO_LANE`, else from the tmux window the CLI runs in.
4. **The prompt change ships with the CLI.** `morndo-board prompt --role manager|worker` prints the instructions block for a lane's prompt, so the words that tell an agent how to use the board are the ones this CLI version was written for. `docs/agents/board.md` carries the same blocks, and a test keeps them equal. The blocks are a working agreement: what the board is for, what to do when, and what never to do (a lane never claims done elsewhere before the board says so; the manager never marks done on a lane's word alone).
5. **The principal's board is on the desktop** (`apps/web/src/lib/desktop/BoardView.svelte`): a Board tab on the rail (its badge counts blocked tasks), six columns, a card per task, the task open beside the board with its record and a comment box, drag and drop between columns (a drop on Blocked asks why first), "Accept as done" on a task in review, and a form to file a task. Every change from the app is a Command (AC7). The lane's channel header shows the task it has in progress, as a chip that opens it on the board.
6. **The hub keeps the board** (`board_tasks`, `board_events`, `agent_tokens`; migration 13), writes each change with its event in one transaction, records it in the audit log (`BoardChanged`: the task, the kind of change and who, never a comment's words), and pushes the whole board to every live feed after a hello and on every change (`board` frame), with the lane names it lists now, so the app can mark an assignee that isn't running.

### Where things live

| Piece | Where |
|---|---|
| B1 to B8: the task, the actors, the moves, the order, the audit event | `packages/domain/src/board.ts` |
| The wire: the task and its events, the `board` frame, the bodies | `packages/protocol/src/board.ts` |
| Agent tokens | `apps/hub/src/application/agent-access.ts`, `morndo agent-token` in `apps/hub/src/main.ts` |
| The service, the routes | `apps/hub/src/application/board-service.ts`, `/api/board` and `/api/agent/board` in `apps/hub/src/adapters/http.ts` |
| The CLI and the prompt blocks | `apps/board-cli/src/cli.ts`, `apps/board-cli/src/prompt.ts` |
| The desktop | `apps/web/src/lib/desktop/BoardView.svelte`, `TaskCard.svelte`, `TaskPanel.svelte`, `NewTaskModal.svelte`, `StatusIcon.svelte`, `board.ts`; the runs on it (ADR-0032) in `run-words.ts`, `RunAvatar.svelte`, `RunDot.svelte`; the chip in `ChannelView.svelte`; the look's QA in a private QA record, not in this tree |
| The checks | `packages/domain/test/board.test.ts`, `apps/hub/test/board.test.ts`, `apps/board-cli/test/cli.test.ts`, `apps/web/test/run-words.test.ts`, `board-record.test.ts`, `board-runs-web.test.ts`, `e2e/board.e2e.ts` |

## Alternatives

| Option | Verdict |
|---|---|
| **A file the manager writes, read by the hub** (as the ledger is) | Rejected. One machine only, no provenance for a lane's changes, and the fleet design retires that pattern (ADR-0014). |
| **The fleet's client socket** | Rejected for now. It reaches only lanes on the machine that runs the fleet service; a lane on another node has no way in until sub-project 4 decides how a node relays client calls. The hub's HTTPS is reachable from every node already. |
| **An MCP server for the board** | Not now. A CLI works from every engine (Claude Code, Codex and the rest run shell commands) and from a person's terminal; an MCP adapter over the same routes can come later. |
| **Lanes mark their own tasks done** | Rejected. A lane's "done" is a Claim (V1); done on the board is someone else's acceptance, as in a team. |
| **Free-form statuses or per-task ranks** | Rejected. Six columns in work order and a fixed order within each (urgent first, waiting work oldest first, work in motion newest first) keep the board readable without a drag-sort nobody keeps up. |

## Consequences

- **Good:** the principal reads the board instead of asking; the manager answers from it; what each lane is doing is one chip away in its channel.
- **Good:** every change is on record with who made it, and a lane's word is never shown as done.
- **Cost:** two tokens to mint and put in the lanes' environment, and a prompt block per role to add to the agents' instructions (`docs/agents/board.md`). The install step (`morndo setup`, sub-project 3) will do both.
- **Limit:** a worker token names its lane; the hub records the name as claimed and marks an assignee that isn't running, but can't prove a lane is who it says. The audit keeps the token's id with every change, so a misused token is traceable and revocable.
- **Limit:** a board change from the app needs a fresh passkey check (AC7), as a send does.
- **Not here:** the board on the phone (the catch-up could carry a "to review" card), comments from a lane's conversation turned into board comments, and Verification: a task's "done" stays the manager's acceptance until Evidence exists (V1, V4).
