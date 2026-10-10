# Fleet Clients Implementation Plan

> **Executing this plan (any agent or editor):** run the lanes in wave order ([Lanes and order](#lanes-and-order)); within a lane, the tasks in order. Do each step literally:
> - create a file with the text given;
> - replace only text found exactly once (if it isn't, stop and report it);
> - run every `Run:` and compare it with its `Expected:`; a count or a message that differs is a finding to report, not to paper over;
> - commit where the step commits (the controls runner reads `HEAD`).
>
> Steps use checkboxes (`- [ ]`) for tracking. Where two parts seem to disagree, [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md) says which is meant.
> - **Tasks 1–17, and Task 21's Step 1 (the rollout scripts and their test),** are repo work and safe on any machine. Tests use their own tmux servers, temporary homes and random ports ([Global Constraints](#global-constraints)). On macOS, `pane-lock`'s two tests need `flock` and `timeout` on `PATH`; without them they fail, as they do on `main`.
> - **Tasks 18–21 are the operator's own machine.** They are not in this tree.
> - **Before a lane's branch merges:** `npm run check`, `npm run lint`, `npx vitest run` and `node scripts/negative-controls.ts --check`.
> - **Proof:** the whole plan was run in order on one clone on 2026-10-09 (RECONCILIATION, rulings 67–75).

**Goal:** Every client reaches lanes only through the fleet:
- the hub, a new `morndo lanes`, kira, the owner's `lanes` and the manager's helpers;
- messages to a lane go through a delivery queue on its node, typed once and confirmed from the conversation;
- lane events are a Morndo feature;
- the owner's setup plugs in from outside.

**Architecture:** The node agent gains a delivery queue (`lane.deliver`), session state in its inventory, a launcher from its policy, and lane state events through its spool. The fleet routes deliveries, mirrors their state, builds lane events from hooks and node state and delivers them to the manager, and keeps the hook bus's subscriber contract. A new `packages/fleet-client` carries the TypeScript client for the hub, `morndo lanes` and kira.

**Tech Stack:** Node 24.21.0 (type stripping, ESM), TypeScript 6.0.3, ws ^8.22.0, better-sqlite3 ^13.0.3, zod/mini through `packages/protocol/src/z.ts`, vitest 5.0.3, tmux 3.4+. kira (outside Morndo) runs on Bun 1.4.2 with its own tests. No new dependencies.

**Spec:**
- [`README.md`](README.md): design v3 with the triple-check (§16), approved by the owner on 2026-10-08;
- [ADR-0014](../../adr/0014-fleet-clients-delivery-queue-and-lane-events.md);
- the fleet core: [`../fleet-core/README.md`](../fleet-core/README.md), its §16.4 rule in particular.

Executors read all three. §N below means this spec's section; "core §N" means the fleet core's.

**The tasks** are in [`plan/`](plan/), one file per lane part; the [Task index](#task-index) links each. The parts were drafted in parallel against the Contracts below; [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md) records how they were made consistent.

## Branches and worktrees

- **One integration branch, `feat/fleet-clients`,** made from `main` after this plan merges. Nothing is committed to it directly. Each lane works in its own worktree (`git worktree add .worktrees/fc-<lane> -b feat/fleet-clients-<lane> feat/fleet-clients`), and its branch is merged into `feat/fleet-clients` in wave order:

  | Lane | Branch | Tasks | Merged |
  |---|---|---|---|
  | foundation | `feat/fleet-clients-foundation` | 1, 2, 3 | before wave 1 |
  | agent | `feat/fleet-clients-agent` | 4, 5, 6 | end of wave 1 |
  | fleet | `feat/fleet-clients-fleet` | 7, 8, 9, 10 | end of wave 1 |
  | hub | `feat/fleet-clients-hub` | 11, 12, 13, 14 | end of wave 1 (Task 11 may merge to `main` on its own first: it is issue #20) |
  | tests | `feat/fleet-clients-tests` | 15, 16, 17 | wave 2 |
  | owner | outside this repo: kira's repo on the PC, `~/.local/bin` | 18, 19, 20 | wave 3, during the rollout |
  | rollout | `feat/fleet-clients-rollout` | 21 | wave 3 |

- **A fresh worktree needs `npm ci` and `npx playwright install chromium`** before its first run. Node modules and the browser are not shared between worktrees, and the web tests need Chromium.
- **Tasks 18 to 20** change the chat bot and the local lane scripts. They are not in this tree:
  - only during the rollout (Task 21), and only after the go-ahead its step names;
  - each on a branch or with a backup first, with kira's own tests (`bun test`) run on the PC.

## Global Constraints

- **Runtime:** `engines.node` `>=24.12`. The services run as `~/.nvm/versions/node/v24.21.0/bin/node --no-warnings <file>.ts`. TypeScript runs as stripped types; there is no build step for the hub, agent or fleet.
- **No new dependencies.** `ws`, `better-sqlite3` and zod/mini are already in the stack. kira stays dependency-free (Bun).
- **tmux:** every tmux call passes `-u`, names a session as `=name`, doubles `#` in every argument tmux reads as a format (`tmuxLiteral`), and targets windows and panes by ID (core §9).
- **Tests never touch the owner's running system.** Each uses an isolated tmux server (`tmux -L test-<uuid>`), a temporary HOME and random ports. Never ports 8786, 8787, 8788, 8789, 8790 or 8791 (all in use on the PC), and never the default tmux server.
- **Durability** follows the fleet core's §16.4 rule: a commit is synced to the disk only when what it guards must outlive the machine (`synced()` in `apps/node-agent/src/ops/done-keys.ts`; the fleet's rule is §6). Every new table says which of its commits are synced, and why.
- **Claude Code internals.** Every fact about them (transcript shapes, session files, menus) is pinned by a recorded example in a fixture under `test/fixtures/claude-code/` (from 2.1.293 on the PC, read-only, with no secrets and no owner content: synthetic texts in the recorded shapes), so a change in Claude Code shows as a failing test.
- **Primary docs.** Every library, API and version is checked against current primary docs and cited with URL and date in a comment where it is used.
- **DDD** (repo README): `packages/domain` holds no infrastructure; `packages/protocol` imports no `node:*`; `packages/node-ops` imports no `apps/*`; `packages/fleet-client` imports only `packages/protocol`, `ws` and `node:*` (ruling 9).
- **Negative controls as data:** every guard a task adds has an entry in `scripts/negative-controls.ts` (core §12.1), or a test of its own named "… (negative control)". Each task lists its entries.
- **Commits:** Conventional Commits. A commit message never names the assistant, its maker or its product (a local hook refuses them, and refuses a command whose text contains those names, so run edits and commits as separate commands).
- **Wording** shown to the owner, exactly:
  - "Queued, it will be delivered";
  - "Delivered";
  - "May have been delivered";
  - the waiting reasons in plain words (Task 13's table).
- **Ports and paths on the PC** (for Tasks 18 to 21):
  - kira moves to 127.0.0.1:8786;
  - the relay takes 127.0.0.1:8787 at step 3 (8789 until then);
  - fleet socket `~/.local/state/morndo-fleet/fleet.sock`;
  - fleet config `~/.config/morndo-fleet/config.json`;
  - agent policy `~/.config/morndo-node/policy.json`.

## Review Focus

Five inputs the spec implies but no section spells out, most likely first. Each has its test in the task named.

1. **A text that starts with `/`** (`morndo lanes send manager "/compact"`): Claude Code runs it as a slash command, and its transcript records a command, not a prompt with that text. Expected: typed once, and confirmed by the command entry (`<command-name>/compact</command-name>`). Without that rule it would be `uncertain` after 24 hours. *Task 2 (receipt), Task 5 (a drill-sized unit test).*
2. **Three senders to one lane at once** (a kira tap, a hub answer and a lane-event batch to the manager). Expected: one at a time in the order stored, never two pastes interleaved in the box, each confirmed by its own receipt. *Task 5.*
3. **The node's clock differs from the client's** (the PC ran 1.1 s behind the control plane). A deadline is therefore sent as a duration (`ttlMs`) and turned into `notAfter` on the node's clock when stored; no client sends a clock time. *Task 1 (schema), Task 4.*
4. **A lane-event batch over 8000 characters** after a long fleet outage. Expected: split into several deliveries of at most 8000 characters, each with the header, in order; none refused `too_large`. *Task 9.*
5. **The hub's manager window renamed** (`MORNDO_MANAGER_WINDOW` is not `manager`) while the fleet's `stickyLanes` still says `manager`. Expected: the hub says so once in its log at start, from `GET /v1/caps` (which lists `stickyLanes`), and still delivers. *Task 12.*

## Contracts (names and types shared across tasks)

These are binding: every part uses these names and types exactly. A part that needs something else stops and asks the reconciler; it doesn't invent a parallel name. [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md)'s rulings are folded in here; where a ruling adds detail (part 02's agent internals, part 04's hub types), the part is the authority.

### `packages/protocol/src/fleet.ts` (Task 1)

```ts
// Error codes added (each executed: "no"):
//   id_conflict   a delivery id already used with another target or text
//   no_session    a delivery to a pane that runs no Claude Code (§4.1)
//   already_typed delivery.cancel of a delivery past `queued`
export type ErrorCode = /* existing */ | "id_conflict" | "no_session" | "already_typed";

export type SessionStatus = "busy" | "idle" | "waiting" | "shell";
// Pane gains (§5): the session file's status (null without a session) and the pane's process id.
// `status` and `pid` from the live session's file (pid: Claude Code's process), `topic`/`lastPrompt` from its transcript's
// latest ai-title and last-prompt entries (rulings 12, 13); null without a live session or from an older agent.
export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; sessionName?: string; title?: string;
  claudeVersion?: string; status: SessionStatus | null; pid: number | null; topic?: string; lastPrompt?: string };

export const KEY_NAMES = ["Enter", "Escape", "Tab", "BSpace", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-u", "Space", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export type DeliveryState = "queued" | "typed" | "held" | "delivered" | "uncertain" | "given_up";
export type WaitingReason = "menu_open" | "draft_present" | "no_input_box" | "busy" | "no_pane" | "no_session" | "earlier" | "unavailable";
export type GiveUpReason = "expired" | "cancelled" | "gone" | "refused";
export type DeliveryTarget = { lane: string; sticky: boolean } | { workerId: string };
export type Delivery = {
  id: string; node: string; target: { lane: string } | { workerId: string };
  state: DeliveryState; queuedAt: number; notAfter: number;            // the node's clock
  waiting?: { reason: WaitingReason; since: number };
  sessionId?: string;                                                  // bound (a non-sticky name) or typed into
  typedAt?: number; deliveredAt?: number;
  why?: GiveUpReason; note?: string;                                   // note: e.g. "typed, never seen taken"
};

// Ops added or changed:
//   "lane.deliver":    { id: string; target: DeliveryTarget; text: string; ttlMs?: number }  → { delivery: Delivery }
//   "delivery.cancel": { id: string }                                                          → { delivery: Delivery }
//   "pane.capture":    { workerId: string; lines: number; attributes?: boolean; join?: boolean /* default true */ } → { text: string | null; truncated: boolean }
//   "pane.keys":       { workerId: string; data?: string; names?: KeyName[]; expect: Expect }  (exactly one of data and names) → { ok: boolean }
//   "lane.start":      { name: string; cwd: string; account?: string; resume?: string; prompt?: string }
//                      → { workerId: string; waiting?: "trust"; prompt?: string /* the first prompt's delivery id */ }
//   "lane.stop":       { name: string; mode?: "exit" | "kill" }                                → { ok: true }
// lane.deliver and delivery.cancel are not in KEYED_OPS: a delivery's id is its idempotency (§4.1); its typing runs
// under the id as a done key inside the agent (§4.3), and a retype under `${id}#2`.

// Agent → fleet, added: the latest state of one delivery (§4.4).
export const EvDelivery = z.object({ v, t: z.literal("ev.delivery"), delivery: DeliverySchema });

// The hook stream's path union gains "/lane": a lane state event the node made from its session state (§7), carried
// and replayed like a hook. Its body: { event: "needs_input" | "answered"; sessionId: string | null; question?: string }.
export type HookEvent = { streamId: string; seq: number; at: number;
  path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file" | "/lane";
  node: string; window: string | null; late?: true; body: unknown };

export type LaneEventName = "finished" | "needs_input" | "answered" | "stop_failure";
export type LaneEvent = { v: 1; t: "lane"; seq: number /* the fleet's own, from lane_events */; event: LaneEventName; node: string;
  window: string | null; lane: string | null; sessionId?: string; at: number;
  status?: "done" | "blocked" | "needs_decision" | null; firstLine?: string; bg?: number; crons?: number; question?: string; error?: string };

export type AlertKind = /* existing */ | "delivery_waiting" | "subscriber_lagging";

// LIMITS gains:
//   maxDeliveryId: 200, deliveryTtlMs: 86_400_000, deliveryTryMs: 5000, deliveryAlertMs: [120_000, 900_000, 3_600_000],
//   deliveryKeepMs: 604_800_000, deliveryStartGraceMs: 120_000, captureMaxLines: 2000, captureMaxBytes: 262_144,
//   laneEventBatchMs: 3000, laneEventKeepMs: 604_800_000, intakeWindowMs: 25, subscriberLagMs: 60_000, laneStopWaitMs: 30_000,
//   deliveryReceiptHoldMs: 60_000 (ruling 42)
```

### `packages/node-ops` (Task 2)

```ts
// receipt.ts: "has Claude Code taken this text?" from a session's transcript (§4.3, §1). A port of
// The inbox transcript rules, extended to what 2.1.293 writes, plus slash commands (Review Focus 1).
export type ReceiptVerdict = "delivered" | "held" | "dropped" | "none";
export type PendingText = { id: string; text: string; typedAt: number };
// Reads complete JSONL lines (as transcript.read returns them) and matches each entry to the earliest pending text it
// fits, at or after its typedAt; each entry decides at most one pending text. Unknown entry kinds and `remove`
// reasons give "none" (no verdict).
export function readReceipts(lines: string[], pending: PendingText[]): { id: string; verdict: Exclude<ReceiptVerdict, "none">; at: number }[];
export function promptMatches(text: string, prompt: string): boolean;   // exact, pasted wrapper, "[Pasted text #N +K lines]", merged
// menu.ts (ported from kira.ts parseMenu): the question a menu on screen asks, kira's rule (§7).
export function menuQuestion(screen: string): string | null;
// sessions.ts: SessionInfo gains `status: SessionStatus | null` (the file's own value) and `pid: number`.
// tmux.ts: the tmux adapter gains
//   sendKeyNames(paneId: string, names: KeyName[]): Promise<boolean>;
//   capture(paneId: string, o?: { lines: number; attributes?: boolean; join?: boolean /* default true */ }): Promise<string | null>;   // o optional: the hub calls capture(id)
//   pasteLiteral(paneId: string, text: string): Promise<void>;   // load-buffer + paste-buffer -p, no checks (the launcher)
```

### `packages/fleet-client` (Task 3)

```ts
// The hub's FleetClient (apps/hub/src/adapters/fleet-client.ts) moved here unchanged, with a client name and these added.
// apps/hub imports it from "@morndo/fleet-client" from Task 3 on; its old module re-exports for one release.
export class FleetClient {
  constructor(socketPath: string, o?: { client?: string /* x-morndo-client, default "hub" */ });
  // existing: caps(), nodes(), lanes(), alerts(), op(), events(), files …
  deliver(d: { id: string; text: string; ttlMs?: number } & ({ lane: string } | { workerId: string })): Promise<Delivery>;
  delivery(id: string): Promise<(Delivery & { stale: boolean }) | null>;
  deliveries(q?: { lane?: string; state?: DeliveryState }): Promise<(Delivery & { stale: boolean })[]>;
  cancelDelivery(id: string): Promise<Delivery | null>;   // null: no such delivery (404), as delivery(id) (ruling 56)
  laneEvents(since?: number): Promise<LaneEvent[]>;
}
// FleetEvent's `t` gains "delivery" (body: Delivery & { stale: boolean }) and "lane" (body: LaneEvent).
// A refusal (lane_conflict, node_offline, id_conflict, no_session, no_pane, already_typed) throws FleetOpFailed with its OpError.
// No answer throws FleetUnavailable: `reached: false` means nothing left this process (nothing was queued); `reached: true` means
// the request went out and no answer came, so the delivery is in doubt. A caller in doubt sends the same id again, never
// types the text itself and never tells the owner "not delivered" (ruling 49).
// GET /v1/caps answers { api: number[]; stickyLanes: string[] }.
```

### Client API routes (Tasks 8, 9; the reference is Task 15)

| Route | Answer |
|---|---|
| `POST /v1/deliveries { id, lane \| workerId, text, ttlMs? }` | 200 `{ ok: true, delivery }`, or 200 `{ ok: false, error: OpError }` for a refusal, as `/v1/op` answers op refusals (ruling 3) |
| `GET /v1/deliveries/<id>` | `{ delivery, stale }`, or 404 `{ error: "no_such_delivery" }` |
| `GET /v1/deliveries?lane=&state=` | `{ deliveries: (Delivery & { stale })[] }`: the newest 1000 of the last 7 days |
| `POST /v1/deliveries/<id>/cancel` | `{ ok: true, delivery }`, or `{ ok: false, error }` |
| `GET /v1/lane-events?since=<seq>` | `{ events: LaneEvent[] }`, at most 1000 per answer, oldest first |
| `/v1/events` | adds `{ t: "delivery", node, body }` and `{ t: "lane", node, body }` |
| `POST /v1/op` | refuses `lane.deliver` and `delivery.cancel` with `bad_args` (ruling 4) |

`morndo lanes` exits (Task 14's `EXIT`, README §9.2, ruling 49): 0 accepted; 2 bad arguments; 3 late (`--wait` ran out; a stop not seen in time); 4 not delivered (given up, uncertain, or refused); **5 in doubt** (the fleet was reached and didn't answer: run it again with the same `--id`, which is safe; the line names the id); 69 the fleet wasn't reached (nothing queued).

### Config

```ts
// Fleet (apps/fleet/src/config.ts, FleetConfig gains; defaults in brackets):
stickyLanes: string[];                       // ["manager"]
laneEvents: { deliverTo: string | null;      // "manager"
              header: string;                // "[lane-event] Lane events (handle them as your instructions say):"
              ignore: string[];              // [] (globs on the lane name)
              batchMs: number };             // 3000
// Agent policy (apps/node-agent/src/config.ts, Policy gains):
launch: { command: string[]; via: "shell" | "direct" };   // { command: ["claude"], via: "shell" }
protected: string[];                                      // ["manager"]
// Hub (apps/hub/src/config.ts): MORNDO_MANAGER_QUEUE ("off" | "0" turn it off; on by default when MORNDO_FLEET_SOCKET is set).
```

### Databases (each migration's number is binding)

| Database | Migration | Tables | Synced commits |
|---|---|---|---|
| `agent.db` | 3 (Task 4) | `deliveries` (id PK, target_lane, target_worker, sticky, bound_session, text, state, waiting_reason, waiting_since, queued_at, not_after, typed_at, typed_session, delivered_at, why, note, retyped, updated_at) | storing a delivery (`synced()`); a `started` key as before |
| `fleet.db` | 5 (Task 7) | `lane_deliveries` (id PK, node, target, state, body JSON, alerted, updated_at; never the text; `deliveries` is the hook bus's table already); `sticky_lanes` (name PK, node, at); `lane_events` (seq PK autoincrement, node, window, lane, session_id, event, at, body JSON, to_manager: 0 waiting, 1 sent, NULL not for the manager, delivery_id) | the intake (hooks and lane events), joins, revocations, keys and connection epochs; nothing else (§6, ruling 62) |
| hub `morndo.db` | 13 (Task 12) | `manager_deliveries` (delivery_id PK, kind "answer" or "command", escalation_id, ask, choice, endpoint_id, session_id, request_id, queued_at, state, updated_at) | as the hub's other tables (`NORMAL`) |

### Agent internals shared by Tasks 4 to 6

```ts
// apps/node-agent/src/deliveries/store.ts (Task 4)
export class DeliveryStore {
  constructor(db: Database.Database, now: () => number);
  store(d: { id: string; target: DeliveryTarget; text: string; ttlMs: number; boundSession: string | null }): { delivery: Delivery; fresh: boolean } | { conflict: true };
  get(id: string): Delivery | null;
  head(lane: { lane: string } | { workerId: string }): Delivery | null;     // the oldest not final for that target
  open(): Delivery[];                                                       // every delivery not final
  recentFinal(sinceMs: number): Delivery[];
  update(id: string, change: Partial<Pick<Delivery, "state" | "waiting" | "sessionId" | "typedAt" | "deliveredAt" | "why" | "note">> & { retyped?: boolean }): Delivery;
  textOf(id: string): string | null;
  prune(): number;
}
// apps/node-agent/src/deliveries/deliverer.ts (Task 5)
export class Deliverer {
  constructor(d: { store: DeliveryStore; executor: Executor; panes: PaneView; transcripts: TranscriptView; now: () => number;
    emit: (d: Delivery) => void; log: Logger });
  enqueue(args: OpArgs["lane.deliver"]): OpResult["lane.deliver"] | OpError;   // validation, binding, storing
  cancel(id: string): OpResult["delivery.cancel"] | OpError;
  kick(reason: "status" | "hook" | "inventory" | "timer"): void;
  start(): void; stop(): void;
}
```

## Lanes and order

```
wave 0  foundation  1 protocol ─ 2 node-ops ─ 3 fleet-client
wave 1  agent       4 store ─ 5 deliverer ─ 6 ops, policy, lane state
        fleet       7 db and commits ─ 8 deliveries ─ 9 lane events ─ 10 hook bus
        hub         11 issue #20 ─ 12 manager through the queue ─ 13 web states ─ 14 morndo lanes
wave 2  tests       16 drills and fixtures ─ 15 fleet-api.md as tests ─ 17 controls, domain, docs, bench gate
wave 3  owner       18 kira ─ 19 lanes wrapper ─ 20 the manager's helpers      (on the PC, during the rollout)
        rollout     21 runbook, QA, the five steps
```

Within a lane, tasks run in order; lanes of one wave run in parallel. Task 11 depends on nothing here and goes to `main` first, so the rollout's first hub restart already keeps old answers.

## Task index

| Task | Title | Part |
|---|---|---|
| 1 | Protocol: deliveries, lane events, capture, keys by name, session state | [plan/01-foundation.md](plan/01-foundation.md) |
| 2 | node-ops: transcript receipts, menu question, session status, keys and capture | [plan/01-foundation.md](plan/01-foundation.md) |
| 3 | `packages/fleet-client` | [plan/01-foundation.md](plan/01-foundation.md) |
| 4 | Agent: migration 3 and the delivery store | [plan/02-agent.md](plan/02-agent.md) |
| 5 | Agent: the deliverer (trying, confirming, expiring, the retype) | [plan/02-agent.md](plan/02-agent.md) |
| 6 | Agent: delivery ops, launcher and `lane.start`/`lane.stop`, capture and keys, inventory status and lane state events | [plan/02-agent.md](plan/02-agent.md) |
| 7 | Fleet: migration 5, the commit rule, the intake window, `fullfsync` | [plan/03-fleet.md](plan/03-fleet.md) |
| 8 | Fleet: delivery routes, sticky names, the mirror, `delivery_waiting` alerts | [plan/03-fleet.md](plan/03-fleet.md) |
| 9 | Fleet: lane events, published and delivered to the manager | [plan/03-fleet.md](plan/03-fleet.md) |
| 10 | Fleet: the subscriber contract, `subscriber_lagging`, the relay's window from the body | [plan/03-fleet.md](plan/03-fleet.md) |
| 11 | Hub: answers to open asks restored whatever their age (issue #20) | [plan/04-hub-web.md](plan/04-hub-web.md) |
| 12 | Hub: the manager's answers and commands through the queue (migration 13, `MORNDO_MANAGER_QUEUE`) | [plan/04-hub-web.md](plan/04-hub-web.md) |
| 13 | Web: Queued, Delivered and May-have-been-delivered for the manager | [plan/04-hub-web.md](plan/04-hub-web.md) |
| 14 | `morndo lanes` | [plan/04-hub-web.md](plan/04-hub-web.md) |
| 15 | `docs/fleet-api.md`, its examples run as tests | [plan/05-tests-docs.md](plan/05-tests-docs.md) |
| 16 | Drills (test/fleet) and the Claude Code fixtures | [plan/05-tests-docs.md](plan/05-tests-docs.md) |
| 17 | Negative controls, `docs/domain.md`, READMEs, the bench gate | [plan/05-tests-docs.md](plan/05-tests-docs.md) |
| 18 | Outside clients on the fleet | not in this tree |
| 19 | A local lanes command on `morndo lanes` | not in this tree |
| 20 | Manager inbox retirement | not in this tree |
| 21 | Rollout | not in this tree |
