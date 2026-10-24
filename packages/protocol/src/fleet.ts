// The fleet's agent channel (docs/design/fleet-core/README.md §5, ADR-0012): one WebSocket per node between its agent
// and the fleet service, JSON messages `{ v: 1, t, … }`, both directions, validated with zod/mini on both sides. Here:
// the protocol versions, every limit the spec sets (LIMITS, the one place they live), the typed operations with their
// arguments and results, the events, the handshake's signing payloads and the join string. Fleet clients (sub-project
// 2, docs/design/fleet-clients/README.md) add the delivery queue (§4), keys by name and the larger capture (§5), each
// pane's session state (§5) and lane events (§7).
// What a node is asked to do (op arguments) is strict, with limits: the agent acts on it. What a node reports (results,
// events) is checked for shape; each message is bounded by maxMessageBytes anyway.
import { JOB_ID, NOTICE_MAX, RUN_PHASES, parseEngine, type PendingTask, type PendingWake, type Run } from "@morndo/domain";
import { EvJob } from "./jobs.ts";
import * as z from "./z.ts";
import { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand } from "./connections.ts";
import { SEMVER } from "./releases.ts";
import { NODE_NAME, WORKER_ID } from "./worker-id.ts";
import type { TurnStatus } from "./lane-status.ts";

export const FLEET_PROTO = 1;            // the agent channel; accepted: [FLEET_PROTO - 1, FLEET_PROTO] ∩ ≥ 1
export const CLIENT_API = 1;             // the client API's routes: /v1/

export const LIMITS = {
  // messages: each at most 512 KiB; both ends set `maxPayload` to 1 MiB; bulk data in chunks of 256 KiB before base64
  maxMessageBytes: 524_288, maxPayload: 1_048_576, chunkBytes: 262_144,
  // content: files 25 MiB (as the hub's own copies, MAX_FILE_BYTES), typed text, keystrokes, panes per capture, a needle
  // memory (ADR-0031): one skill file, and the files of one memory.sync part, under maxMessageBytes with room for JSON
  memorySkillBytes: 32_768, memoryPartBytes: 393_216, memoryPartsMax: 64,
  maxFileBytes: 26_214_400, maxSendText: 8000, maxKeys: 4096, captureManyMax: 64, captureBytesPerPane: 6144, maxNeedle: 200,
  // a message the principal types (pane.send, lane.deliver): 100,000 characters, what the app's HTTP send already took
  // (~25,000 tokens; anything bigger is a file to upload, maxFileBytes), not the 8,000 of the rest of the typed text
  maxMessageText: 100_000,
  // streaming: hook events unacknowledged in flight
  replayWindow: 256,
  // timing: pings, liveness (the agent's timeout is two missed pings plus slack), health and inventory, and what an
  // agent keeps back from a deadline
  pingMs: 15_000, agentPingTimeoutMs: 35_000, healthMs: 30_000, inventoryPollMs: 2000, deadlineMarginMs: 250,
  // instances (§5.2): how long the fleet waits for the live connection's pong before it admits another instance, and how
  // often a refused (4409) agent tries again (±20 % jitter); how long the hub's listing waits for one node's inventory
  instancePongMs: 3000, conflictRetryMs: 300_000, inventoryWaitMs: 300,
  // queues and buffers: bulk ops waiting per node (one more is busy), unsent events before a client's events socket is
  // closed (1013), and joins and hellos per source address before any key work (10 at once, one more every 6 s)
  bulkQueueMax: 8, eventsBufferBytes: 8_388_608, handshakeBurst: 10, handshakeRefillMs: 6000,
  // lifetimes and caps of what is kept (the spool's bytes count the relay's copies and the upload inbox too); audit
  // rows, alerts included, 90 days
  joinCodeTtlMs: 600_000, doneKeyTtlMs: 604_800_000, outboxKeepMs: 86_400_000, deadLetterAttempts: 20,
  subscriberBacklog: 50_000, spoolMaxEvents: 100_000, spoolMaxBytes: 268_435_456, relayFileKeepMs: 86_400_000, auditKeepMs: 7_776_000_000,
  // the delivery queue (fleet clients §4): an id's length, how long a delivery may wait by default (a client sends a
  // duration, ttlMs, which the node turns into notAfter on its own clock: Review Focus 3), how often the head of a
  // lane is tried at least, the waiting alerts (once each), how long final deliveries are kept, how long a pane that
  // has just started may have no Claude Code session yet before a delivery to it is refused, how long a typed or
  // held delivery waiting for its receipt holds the next one to its lane back (§4.3), and how long the fleet waits
  // for a node's answer to lane.deliver before it gives up. It mirrors the delivery only when that answer comes.
  maxDeliveryId: 200, deliveryTtlMs: 86_400_000, deliveryTryMs: 5000, deliveryAlertMs: [120_000, 900_000, 3_600_000],
  deliveryKeepMs: 604_800_000, deliveryStartGraceMs: 120_000, deliveryReceiptHoldMs: 60_000, deliveryOpTimeoutMs: 15_000,
  // pane.capture (§5): lines asked for, and the text it answers with (one bulk chunk), counted as its JSON-escaped size
  captureMaxLines: 2000, captureMaxBytes: 262_144,
  // lane events (§7) and the fleet's commits (§6): the manager's batch window, how long lane events are kept, the
  // intake window that shares one synced commit, when a subscriber counts as lagging, and how long lane.stop waits
  laneEventBatchMs: 3000, laneEventKeepMs: 604_800_000, intakeWindowMs: 25, subscriberLagMs: 60_000, laneStopWaitMs: 30_000,
} as const;

// Close codes on the agent channel (§5.2).
export const CLOSE = { badProof: 4401, forbidden: 4403, conflict: 4409, unsupported: 4426 } as const;

// Where an agent may dial (§8): TLS (wss://) anywhere, and plain ws:// only to this machine's loopback, where nothing
// crosses a network (Tailscale Serve terminates TLS in front of the fleet, so a node elsewhere dials wss://). The host is
// read without URL(), which this package's types don't have: 127.x.x.x, localhost or [::1], then a port, a path or the
// end, so "ws://127.0.0.1.nip.io" and "ws://127.0.0.1@evil.example" are refused.
const LOOPBACK_WS = /^ws:\/\/(?:127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|localhost|\[::1\])(?::\d{1,5})?(?:\/[!-~]*)?$/;
export function fleetUrlOk(url: string): boolean {
  return /^wss:\/\/[!-~]+$/.test(url) || LOOPBACK_WS.test(url);
}

export type Expect = { server: string; window: string; sessionId?: string };
// id_conflict: a delivery id already used with another target or text; no_session: a delivery to a pane with no live
// Claude Code session, that is no session file or its process gone (fleet clients §4.1); already_typed:
// delivery.cancel of a delivery past `queued` (§4.3).
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal"
  | "updating" | "not_allowed" | "id_conflict" | "no_session" | "already_typed";
export type Executed = "no" | "maybe";
// Whether the side effect may have happened (§5.3): "no" is safe to retry. Only an answer that may have come after the
// side effect started is "maybe".
export const ERROR_EXECUTED: Record<ErrorCode, Executed> = {
  bad_args: "no", unknown_op: "no", denied: "no", no_pane: "no", menu_open: "no", no_input_box: "no", draft_present: "no",
  busy: "no", name_taken: "no", lane_conflict: "no", too_large: "no", timeout: "no", node_offline: "no", uncertain: "maybe", internal: "maybe",
  updating: "no", not_allowed: "no",
  id_conflict: "no", no_session: "no", already_typed: "no",
};
export type OpError = { code: ErrorCode; executed: Executed; message: string };

// A Claude Code session's state, as its session file (~/.claude/sessions/<pid>.json) says it: Claude Code's own value,
// undocumented (seen on 2.1.293 and 2.1.294: busy, idle, waiting, shell). "shell": Claude Code is alive and running a
// shell command (seen at its prompt with a background shell), not exited. A live session takes deliveries whatever its
// status (§4.1).
export const SESSION_STATUSES = ["busy", "idle", "waiting", "shell"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
// `title`: the pane's terminal title (tmux pane_title); `sessionName`: the name Claude Code's session registry gives the
// session running there (what legacy shows as the session's name). `status`: that session's state (null without a
// session); `pid`: the process its session file names, Claude Code's own, as `lanes --json` reports it and claude-pool
// reads it (null without a session). `topic` and `lastPrompt`: the session's latest `ai-title` and `last-prompt`
// transcript entries (Claude Code cuts the prompt to about 200 characters), which the agent keeps from its transcript
// reads; kira shows `title || lastPrompt` and the title (fleet clients §5).
export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; sessionName?: string; title?: string;
  claudeVersion?: string; status: SessionStatus | null; pid: number | null; topic?: string; lastPrompt?: string };

// Keys a client may press by name (pane.keys `names`, §5): tmux key names (tmux(1), "KEY BINDINGS"), an allow-list.
// None starts with "-" or ends in ";", so none reads as a flag or a command separator on tmux's command line.
export const KEY_NAMES = ["Enter", "Escape", "Tab", "BSpace", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-s", "C-u", "Space", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

// The delivery queue (fleet clients §4). A delivery's `target` as the node keeps it: a lane name (sticky or bound to
// the session it had when queued) or a worker ID. Times are the node's clock.
export type DeliveryState = "queued" | "typed" | "held" | "delivered" | "uncertain" | "given_up";
// The states that end a delivery (§4.3): it is never moved again, and nothing more of it is typed. The one definition
// the fleet, the node and every client read (review #13).
export const FINAL_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set<DeliveryState>(["delivered", "uncertain", "given_up"]);
// unavailable: the node couldn't read or type the pane just now (tmux didn't answer, a capture failed); it tries again.
export type WaitingReason = "menu_open" | "draft_present" | "no_input_box" | "busy" | "no_pane" | "no_session" | "earlier" | "unavailable";
export type GiveUpReason = "expired" | "cancelled" | "gone" | "refused";
// What the fleet asks a node to queue: a lane name with whether it is sticky (the fleet's stickyLanes), or a worker ID.
export type DeliveryTarget = { lane: string; sticky: boolean } | { workerId: string };
export type Delivery = {
  id: string; node: string; target: { lane: string } | { workerId: string };
  state: DeliveryState; queuedAt: number; notAfter: number;
  waiting?: { reason: WaitingReason; since: number };
  sessionId?: string;                                                  // bound (a non-sticky name) or typed into
  typedAt?: number; deliveredAt?: number;
  why?: GiveUpReason; note?: string;                                   // note: e.g. "typed, never seen taken"
  // The node stashed the lane's draft so this delivery could go in (#64): text left unsent in the input box, unchanged
  // since `since`, put away with Claude Code's stash (Ctrl+S) at `at`, `chars` long, a copy of what the box showed at `copy`
  // on the node. The text itself never leaves the node.
  stashed?: DraftStash;
};
export type DraftStash = { at: number; since: number; chars: number; copy: string };

export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add" | "pane.capture" | "lane.deliver" | "delivery.cancel" | "memory.sync"
  | "job.cancel" | "job.notice" | "job.noticeResult"
  | "connections.priority" | "connections.role" | "connections.revoke" | "connections.narrow" | "update.apply";
// What a lane runs on, as lane.start answers it (reliable lanes §3.3): the engine layer's entry (provider:model[@effort]),
// the Role it was picked for, and the entries the resolver passed over first, each with its reason (none: the first choice).
export type LaneEngine = { entry: string; role?: string; skipped?: { entry: string; reason: string }[] };
export const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export type OpArgs = {
  "inventory.get": Record<string, never>;
  "pane.captureMany": { workerIds: string[] };
  "pane.frame": { workerId: string };
  "pane.keys": { workerId: string; data?: string; names?: KeyName[]; expect: Expect };   // exactly one of data and names
  "pane.send": { workerId: string; text: string; expect: Expect };
  "op.status": { key: string };
  "transcript.size": { sessionId: string };
  "transcript.read": { sessionId: string; offset: number; max: number };
  "transcript.locate": { sessionId: string; needle: string };
  "file.stat": { path?: string; ref?: string };
  "file.get": { path?: string; ref?: string; offset: number; max: number };
  "file.put": { upload: string; offset: number; bytes: string /* base64 */; final: boolean; name: string };
  // role or engine, at most one (reliable lanes §3.3): what the lane runs on; reason: why an engine was named instead of the
  // node's default role, for the audit.
  "lane.start": { name: string; cwd: string; account?: string; resume?: string; prompt?: string; role?: string; engine?: string; reason?: string };
  "lane.stop": { name: string; mode?: "exit" | "kill"; keepWindow?: boolean };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };
  "pane.capture": { workerId: string; lines: number; attributes?: boolean; join?: boolean };   // join: tmux -J, default true
  "lane.deliver": { id: string; target: DeliveryTarget; text: string; ttlMs?: number };
  "delivery.cancel": { id: string };
  // Memory's skill files for this node (ADR-0031), in parts: the node stages each part under the version and, once it holds
  // all of them, replaces its own skills (names starting `morndo-mem-`) with exactly these. No command, no path.
  "memory.sync": { version: string; part: number; parts: number; files: { name: string; content: string }[] };
  // The id, and the token whose lane owns it. No command.
  "job.cancel": { id: string; token: string };
  // One notice id, the lane that types it, and the text that lane stores. No command.
  "job.notice": { id: string; lane: string; text: string };
  // What the hub's board did with a task notice. The fleet and the node keep the same state.
  "job.noticeResult": { id: string; notice: "commented" | "given_up" };
  "connections.priority": z.output<typeof PriorityCommand>;
  "connections.role": z.output<typeof RoleCommand>;
  "connections.revoke": z.output<typeof RevokeCommand>;
  "connections.narrow": z.output<typeof NarrowCommand>;
  // What the control plane asks a node to move to (updates §5.4): the Version of the Rollout. The fleet refuses the op
  // before it is sent when the Version is above its own running one (RL11) or the Rollout is halted (RL12).
  // `attempt`: the fleet's own id for this ask, which it sets (a caller's is replaced): the id the node's updater
  // reports a rollback of it under (review of #107, round 4).
  "update.apply": { version: string; attempt?: string };
};
export type OpResult = {
  "inventory.get": { panes: Pane[]; invVersion: number };
  "pane.captureMany": { captures: { workerId: string; text: string | null; truncated: boolean }[] };
  "pane.frame": { frame: { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] } | null };
  "pane.keys": { ok: boolean };
  "pane.send": { problem: "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy" | null; typedAt: number };
  "op.status": { state: "unknown" | "started" | "done"; outcome?: unknown };
  "transcript.size": { size: number | null };
  "transcript.read": { bytes: string /* base64 */; eof: boolean };
  "transcript.locate": { offset: number | null };
  "file.stat": { size: number; mtime: number };
  "file.get": { bytes: string; size: number; eof: boolean };
  "file.put": { path: string | null };
  "lane.start": { workerId: string; waiting?: "trust"; prompt?: string /* the first prompt's delivery id */; engine?: LaneEngine };
  "lane.stop": { ok: true };
  "worktree.list": { worktrees: { path: string; branch: string | null }[] };
  "worktree.add": { path: string };
  "pane.capture": { text: string | null; truncated: boolean };
  "lane.deliver": { delivery: Delivery };
  "delivery.cancel": { delivery: Delivery };
  "memory.sync": { committed: boolean; written: number; removed: number; skillDirs: string[]; conflicts: string[] };
  "job.cancel": { ok: true };
  "job.notice": { ok: true };
  "job.noticeResult": { ok: true };
  "connections.priority": { ok: true };
  "connections.role": { ok: true };
  "connections.revoke": { ok: true };
  "connections.narrow": { ok: true };
  // The node took the ask: it queued or started the move to the Version (updates §5.4). What became of it arrives with
  // the next health (state rolled_back, applying, …), never in this answer.
  "update.apply": { accepted: true };
};
// Ops with a side effect, which carry a caller's idempotency key (§5.3). Keystrokes carry none: they are never retried.
// Nor do lane.deliver and delivery.cancel: a delivery's id is its idempotency (fleet clients §4.1), and its typing runs
// inside the agent under the id as a done key (§4.3), a retype under `${id}#2`.
export const KEYED_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "pane.send", "file.put", "lane.start", "lane.stop", "worktree.add", "job.notice", "memory.sync",
  "connections.priority", "connections.role", "connections.revoke", "connections.narrow", "update.apply",
]);
// A fresh passkey. Narrowing (off, a lower budget, a deny) is not in this set. update.apply moves a whole node to
// another Version, so it takes one too (updates §5.4).
export const STEP_UP_OPS: ReadonlySet<OpName> = new Set<OpName>(["connections.priority", "connections.role", "connections.revoke", "update.apply"]);

// A node's updater as its health reports it (updates §6.3, §7): the state of the domain's own state machine (§5.4),
// the Version it reports from, and — for the states that have one — the Version it was moving to, why it left it and
// which check failed. `version` is what runs now: the Version before `target` once it swapped, the good one after a
// rollback.
export type NodeUpdateHealth = {
  state: "current" | "staged" | "waiting" | "applying" | "rolled_back" | "rollback_failed";
  version: string; target?: string; reason?: string; failedCheck?: string;
  // The updater's own id of the Update this report is about (its update.db row): a rollback counts once by it, not
  // by its Version, so a second real rollback of the same Version after a resume halts again (review of #107).
  attempt?: string;
};
export type Health = { memTotal: number; memAvailable: number; psiSome10: number | null; psiFull10: number | null;
  diskFreeHome: number; load1: number; tmuxOk: boolean; wallClock: number; spoolDepth: number; drops: number;
  jobs?: string;
  // The node's UTC offset in minutes now (east positive, so UTC+2 is 120): the time its lanes' wake-up schedules are
  // written in (ADR-0032, R3). Absent from an older node: its wake-ups get no fire time.
  tzOffsetMin?: number;
  // What the node's updater reports, when the node has one (updates §6.3, §7): absent from an older node, whose update
  // reads as null, never as a malformed health.
  update?: NodeUpdateHealth };

// The status word the fleet gives a node (fleet clients §2.3): online, its agent connected; stale, its health went
// quiet; offline, its agent gone.
export const FLEET_NODE_STATUSES = ["online", "stale", "offline"] as const;
export type FleetNodeStatus = (typeof FLEET_NODE_STATUSES)[number];
// One row of GET /v1/nodes, as every client reads it (the hub's updates view among them, §8.1): the machine's name
// and status, its last health report, the Version its agent said and the commit it runs (null before it said one),
// the protocol versions its hello named (null when it is not connected), and its updater's last report (null before
// any). A fleet from before updates sends the first four only — a client reads the rest as null, never as a mismatch.
export type FleetNode = {
  name: string;
  status: FleetNodeStatus;
  health: Health | null;
  agent: string | null;
  commit: string | null;
  proto: number[] | null;
  update: NodeUpdateHealth | null;
};
// "/lane": a lane state event the node made from its session state (fleet clients §7), carried and replayed like a hook.
// Its body: { event: "needs_input" | "answered"; sessionId: string | null; question?: string }.
export type HookEvent = { streamId: string; seq: number; at: number;
  path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file" | "/lane";
  node: string; window: string | null; late?: true; body: unknown };

// A lane event (fleet clients §7), built by the fleet per node and window from the hooks and each node's session state.
// `seq` is the fleet's own (lane_events), so a client reads on with GET /v1/lane-events?since=<seq>.
// Reliable lanes (design §3.1, §3.2): a `finished` whose status line says WAITING carries `waitingOn` and `until` (ms, the
// lease's end); `stale` is the fleet's own, made when a lane's last turn passed its deadline with nothing since: `reason`
// says which deadline (`waiting`: a wait or background work; `no_status`: no status line; `no_turn_end`: the session went
// from working to idle and no turn end reached the fleet), `since` is that turn's end and `stalls` how many stale events
// the lane had since it last ended DONE, BLOCKED or NEEDS DECISION.
// A lane's last turn as the fleet's lane watch holds it (GET /v1/lane-watch, reliable lanes §3.2): when it ended, its
// status, its deadline (null: none, the orchestrator's to act on), why it has one, what it waits on, whether a stale event
// was made for it, and the stale events since the lane last settled.
export type LaneWatchEntry = {
  node: string; window: string; at: number; status: TurnStatus | null; deadline: number | null; reason?: "waiting" | "no_status";
  waitingOn?: string; stale: boolean; stalls: number;
};
export type LaneEventName = "finished" | "needs_input" | "answered" | "stop_failure" | "stale";
export type LaneEvent = { v: 1; t: "lane"; seq: number; event: LaneEventName; node: string;
  window: string | null; lane: string | null; sessionId?: string; at: number;
  status?: "done" | "blocked" | "needs_decision" | "waiting" | null; firstLine?: string; bg?: number; crons?: number; question?: string; error?: string;
  waitingOn?: string; until?: number; reason?: "waiting" | "no_status" | "no_turn_end"; since?: number; stalls?: number;
  // ADR-0032 (R6): what a `finished` left pending, at most 8 of each: a background task by its type and a redacted
  // description of at most 80 characters, a wake-up by its schedule. Never a command or a prompt.
  tasks?: PendingTask[]; wakes?: PendingWake[] };

// A lane's Run as the fleet derives it (ADR-0032; domain run.ts): GET /v1/runs and the `run` event.
export type RunView = Run;

// What the fleet service raises for the owner (spec §5.2, §5.4, §5.6, §7, §8): kept as audit rows, served oldest first by
// the client API's GET /v1/alerts and sent as the "alert" event. `detail` is per kind (plan Contracts, "Alerts").
// delivery_waiting: a delivery still queued, typed or held after 2, 15 and 60 minutes (fleet clients §4.5);
// subscriber_lagging: a subscriber's oldest undelivered event is older than 60 s (§6);
// draft_stashed: a node stashed a lane's unsent draft so its deliveries could go in (#64);
// the updates design (§7): rollout_halted — a Rollout halted, by a node's rollback or by hand; update_rolled_back — a
// node rolled a Version back; update_rollback_failed — a rollback that did not reach the good Version;
// update_skew_blocked — the control plane held its apply while a joined node's agent protocol falls outside the
// target's range (RL11): nothing ran, and the hold names the nodes.
// journal_unreadable: a line of the fleet's revocation journal it could not read and skipped (updates design §11.5).
export const ALERT_KINDS = ["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter", "backlog_full", "unrouted_hook",
  "job_failed", "job_unnoticed", "connection", "delivery_waiting", "subscriber_lagging", "engine_fallback", "draft_stashed",
  "rollout_halted", "update_rolled_back", "update_rollback_failed", "update_skew_blocked",
  "journal_unreadable"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type Alert = { id: number; at: number; node: string | null; kind: AlertKind; detail: Record<string, unknown> };
// The alerts the app pushes (the owner, 2026-10-12): a node's key may be stolen (a new source, a second instance), events
// are lost or piling up for a subscriber, or a message has waited a quarter of an hour (2 minutes is in-app only); and
// text the owner left unsent was moved out of a lane's input box (#64). The hub's push and the app's marking both read
// this one rule.
export function urgentAlert(a: { kind: string; detail: Record<string, unknown> }): boolean {
  switch (a.kind) {
    case "source_changed": case "instance_conflict": case "dead_letter": case "backlog_full": case "draft_stashed": return true;
    // The updates design (§7): a Rollout halted and a rollback that failed stop every node's updates until the owner
    // acts, and a node that rolled back is the fleet off its committed Version — each is a now, not a morning read.
    // update_skew_blocked stays quiet: the ask was refused, nothing ran (RL11), and the record is enough.
    case "rollout_halted": case "update_rolled_back": case "update_rollback_failed": return true;
    // a revocation the journal holds may not have been applied again: someone should look
    case "journal_unreadable": return true;
    case "delivery_waiting": return typeof a.detail.minutes === "number" && a.detail.minutes >= 15;
    default: return false;
  }
}

// ---- the pieces messages are made of

// Memory's skill names (ADR-0031): the Agent Skills name rule, and always Memory's own prefix, so a node never touches
// another skill.
export const MEMORY_SKILL_NAME = /^morndo-mem-(?!-)(?!.*--)[a-z0-9-]{1,53}(?<!-)$/;
const v = z.literal(1);
const text = () => z.string();                                              // node → fleet: shape only
const label = () => z.string().check(z.maxLength(200));
// The commit a build was made from (a stamped tree or a git HEAD). An older agent says none.
const buildCommit = () => z.string().check(z.regex(/^[0-9a-f]{40}$/));
// A Version on the fleet channel: the same rule as the signed documents (releases.ts' SEMVER, SemVer 2.0.0).
const semver = () => z.string().check(z.regex(SEMVER));
// A Release's Version as the Rollout names it: SemVer without build metadata. Precedence ignores build metadata
// (SemVer 2.0.0 §10), so "0.4.2+x" and "0.4.2" are one Version; the Rollout's words refuse the second spelling at the
// edge so no halt can be stepped around by a spelling (review of #107).
// An attempt id the fleet issues: 16 random bytes, base64url (crypto.randomBytes), so nobody can guess one.
export const ATTEMPT_ID = /^[A-Za-z0-9_-]{22,64}$/;
const attemptId = () => z.string().check(z.regex(ATTEMPT_ID));
// What a node may follow, and the attempt id it reports a rollback of it under (welcome, the rollout message).
const offer = () => z.object({ version: releaseVersion(), attempt: attemptId() });
const releaseVersion = () => z.string().check(z.regex(SEMVER), z.refine(v => !v.includes("+"), "a Release's Version carries no build metadata"));
const count = () => z.int().check(z.gte(0));
const nodeName = () => z.string().check(z.regex(NODE_NAME));
const workerId = () => z.string().check(z.regex(WORKER_ID));
// A Claude Code session ID names a transcript file on the node (`<id>.jsonl`): no dot, no slash, so never a path.
const sessionId = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{1,128}$/));
const absolutePath = () => z.string().check(z.maxLength(4096), z.refine(p => p.startsWith("/") && !p.includes("\0"), "an absolute path"));
// A token an agent hands out (a relay file's ref, an upload's id): URL-safe, never a path.
const token = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{1,64}$/));
// lane.start's typed fields become arguments of `claude-as <account> --resume <id>` on the node: neither may start with
// "-", so no value can pass as a flag (--dangerously-skip-permissions, --fork-session). An account is a short name of
// lower-case letters, digits and "-"; a resume id is a Claude Code session ID, a UUID.
const account = () => z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,31}$/));
// A Role (ADR-0013) is a word of the engine layer's settings; an engine is its entry text, provider:model[@effort]. The node
// passes them to the engine layer's CLI as single arguments (execFile, no shell), and neither may start with "-".
const roleName = () => z.string().check(z.regex(ROLE_NAME));
const engineEntry = () => z.string().check(z.maxLength(200), z.refine(e => !e.startsWith("-") && parseEngine(e) !== null, "provider:model[@effort]"));
const reason = () => z.string().check(z.regex(/^[^\p{Cc}]{1,200}$/u));
const LaneEngineSchema = z.object({
  entry: label(), role: z.exactOptional(label()), skipped: z.exactOptional(z.array(z.object({ entry: label(), reason: label() })).check(z.maxLength(32))),
});
// A lane is a tmux window: its name may hold spaces, unicode, dots and slashes, never a control character.
const windowName = () => z.string().check(z.regex(/^[^\p{Cc}]{1,200}$/u));
const offset = () => z.int().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));
const chunkMax = () => z.int().check(z.gte(1), z.lte(LIMITS.chunkBytes));
const base64Chunk = () => z.base64().check(z.maxLength(4 * Math.ceil(LIMITS.chunkBytes / 3)));
// 16 to 64 random bytes, base64url: the handshake's nonces.
const nonce = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{22,86}$/));
// An Ed25519 signature (64 bytes) and an Ed25519 public key as SPKI DER (44 bytes), base64 (Node's `sign(null, …)`,
// `export({ format: "der", type: "spki" })`; https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-06).
export const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const signature = () => z.string().check(z.regex(ED25519_SIGNATURE));
const ed25519Spki = () => z.string().check(z.regex(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/));
const joinCode = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{22}$/));   // 128 bits, base64url
// An idempotency key, namespaced by its client ("hub:…", "kira:…", "lanes:…").
const opKey = () => z.string().check(z.regex(/^[a-z]+:/), z.maxLength(512));
const reqId = () => z.string().check(z.minLength(1), z.maxLength(64));
const protoList = () => z.array(z.int().check(z.gte(1))).check(z.minLength(1), z.maxLength(8));

const ExpectSchema = z.object({
  server: z.string().check(z.regex(/^[0-9a-f]{8}$/)), window: windowName(), sessionId: z.exactOptional(sessionId()),
});
// One of a path or a ref (a file the hook relay copied), never both.
const oneFile = (a: { path?: string; ref?: string }) => (a.path === undefined) !== (a.ref === undefined);
// A worktree's name or base: a git branch name (git-check-ref-format(1), --branch), in a form never laxer than git's:
// ASCII letters, digits, ".", "_", "-" and "/"; not starting with "-", "." or "/"; no "..", "//", "/." or "@{"; no
// component ending in ".lock"; not ending in "/" or "."; not "HEAD"; at most 200 characters. The agent asks git itself
// as well (`git check-ref-format --branch`).
const refName = () => z.string().check(z.regex(/^(?![-/.]|HEAD$)(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/));
// A message the principal types into a lane (pane.send, lane.deliver) and a lane's first prompt (lane.start), up to
// maxMessageText, and only to an agent that said it takes one (CAP_LONG_TEXT); the lane-event parts stay at maxSendText.
const messageText = () => z.string().check(z.minLength(1), z.maxLength(LIMITS.maxMessageText));
// A delivery's id (fleet clients §4.1), chosen by its client and namespaced like a key ("hub:…", "kira:…"; the client a-z,
// at most 16 letters, §8), at most 200 characters, no control character. It is also the done key its typing runs under,
// and `${id}#2` the one retype's (§4.3), so an id never ends in "#" and digits: "hub:x#2" would meet the retype of "hub:x".
const deliveryId = () => z.string().check(z.regex(/^[a-z]{1,16}:[^\p{Cc}]+$/u), z.maxLength(LIMITS.maxDeliveryId),
  z.refine(id => !/#\d+$/.test(id), "an id that is not a retype's key"));
// Exactly one kind of target: one naming both a lane and a worker ID fits neither branch (strict objects), so it is
// refused, never read as one of the two.
const DeliveryTargetSchema = z.union([z.strictObject({ lane: windowName(), sticky: z.boolean() }), z.strictObject({ workerId: workerId() })]);

export const OP_NAMES = [
  "inventory.get", "pane.captureMany", "pane.frame", "pane.keys", "pane.send", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "file.put",
  "lane.start", "lane.stop", "worktree.list", "worktree.add", "pane.capture", "lane.deliver", "delivery.cancel", "memory.sync",
  "job.cancel", "job.notice", "job.noticeResult",
  "connections.priority", "connections.role", "connections.revoke", "connections.narrow", "update.apply",
] as const satisfies readonly OpName[];

// Each op's arguments, as the agent accepts them (fleet → agent: strict).
export const OP_ARGS = {
  "inventory.get": z.record(z.string(), z.never()),
  "pane.captureMany": z.object({ workerIds: z.array(workerId()).check(z.maxLength(LIMITS.captureManyMax)) }),
  "pane.frame": z.object({ workerId: workerId() }),
  // Literal text (data) or tmux key names (names), exactly one (fleet clients §5).
  "pane.keys": z.object({
    workerId: workerId(), data: z.exactOptional(z.string().check(z.minLength(1), z.maxLength(LIMITS.maxKeys))),
    names: z.exactOptional(z.array(z.enum(KEY_NAMES)).check(z.minLength(1), z.maxLength(LIMITS.maxKeys))), expect: ExpectSchema,
  }).check(z.refine(a => (a.data === undefined) !== (a.names === undefined), "data or names, exactly one")),
  "pane.send": z.object({ workerId: workerId(), text: messageText(), expect: ExpectSchema }),
  "op.status": z.object({ key: opKey() }),
  "transcript.size": z.object({ sessionId: sessionId() }),
  "transcript.read": z.object({ sessionId: sessionId(), offset: offset(), max: chunkMax() }),
  "transcript.locate": z.object({ sessionId: sessionId(), needle: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxNeedle)) }),
  "file.stat": z.object({ path: z.exactOptional(absolutePath()), ref: z.exactOptional(token()) }).check(z.refine(oneFile, "a path or a ref")),
  "file.get": z.object({ path: z.exactOptional(absolutePath()), ref: z.exactOptional(token()), offset: offset(), max: chunkMax() })
    .check(z.refine(oneFile, "a path or a ref")),
  "file.put": z.object({
    upload: token(), offset: z.int().check(z.gte(0), z.lte(LIMITS.maxFileBytes)), bytes: base64Chunk(), final: z.boolean(),
    name: z.string().check(z.minLength(1), z.maxLength(255), z.refine(n => !n.includes("/") && !n.includes("\0"), "a file name")),
  }),
  "lane.start": z.object({ name: windowName(), cwd: absolutePath(), account: z.exactOptional(account()), resume: z.exactOptional(z.uuid()),
    prompt: z.exactOptional(messageText()), role: z.exactOptional(roleName()), engine: z.exactOptional(engineEntry()), reason: z.exactOptional(reason()),
  }).check(z.refine(a => a.role === undefined || a.engine === undefined, "role or engine, not both")),
  "lane.stop": z.object({ name: windowName(), mode: z.exactOptional(z.enum(["exit", "kill"])), keepWindow: z.exactOptional(z.boolean()) }),
  "worktree.list": z.object({ repo: absolutePath() }),
  "worktree.add": z.object({ repo: absolutePath(), name: refName(), base: refName() }),
  "pane.capture": z.object({
    workerId: workerId(), lines: z.int().check(z.gte(1), z.lte(LIMITS.captureMaxLines)), attributes: z.exactOptional(z.boolean()), join: z.exactOptional(z.boolean()),
  }),
  // ttlMs, never a clock time: the node turns it into notAfter on its own clock (Review Focus 3). At most the 7 days a
  // final delivery is kept.
  "lane.deliver": z.object({
    id: deliveryId(), target: DeliveryTargetSchema, text: messageText(), ttlMs: z.exactOptional(z.int().check(z.gte(1), z.lte(LIMITS.deliveryKeepMs))),
  }),
  "delivery.cancel": z.object({ id: deliveryId() }),
  "memory.sync": z.object({
    version: z.string().check(z.regex(/^[a-f0-9]{16,64}$/)),
    part: z.int().check(z.gte(0), z.lt(LIMITS.memoryPartsMax)),
    parts: z.int().check(z.gte(1), z.lte(LIMITS.memoryPartsMax)),
    files: z.array(z.object({
      name: z.string().check(z.regex(MEMORY_SKILL_NAME)),
      content: z.string().check(z.maxLength(LIMITS.memorySkillBytes)),
    })).check(z.maxLength(400)),
  }).check(z.refine(a => a.part < a.parts, "part below parts")),
  "job.cancel": z.object({ id: z.string().check(z.regex(JOB_ID)), token: z.string().check(z.minLength(1), z.maxLength(512)) }),
  "job.notice": z.object({
    id: z.string().check(z.minLength(1), z.maxLength(240), z.regex(/^[A-Za-z0-9:_-]+$/)),
    lane: windowName(), text: z.string().check(z.maxLength(NOTICE_MAX)),
  }),
  "job.noticeResult": z.object({ id: z.string().check(z.regex(JOB_ID)), notice: z.enum(["commented", "given_up"]) }),
  "connections.priority": PriorityCommand,
  "connections.role": RoleCommand,
  "connections.revoke": RevokeCommand,
  "connections.narrow": NarrowCommand,
  "update.apply": z.object({ version: releaseVersion(), attempt: z.exactOptional(attemptId()) }),
} satisfies Record<OpName, z.ZodMiniType>;

const PaneSchema = z.object({
  workerId: workerId(), window: text(), cwd: text(),
  sessionId: z.exactOptional(text()), sessionName: z.exactOptional(text()), title: z.exactOptional(text()), claudeVersion: z.exactOptional(text()),
  topic: z.exactOptional(text()), lastPrompt: z.exactOptional(text()),
  // An agent from before session state sends neither, and Claude Code may one day write a status this protocol doesn't
  // know: either reads as null, never as a malformed inventory. A default "short-circuit[s] the parsing process. If the
  // input is undefined, the default value is eagerly returned"; any other value goes through the transform (zod 4.6.5,
  // https://zod.dev/api#defaults and #transforms, read 2026-10-08).
  status: z._default(z.pipe(z.unknown(), z.transform((s): SessionStatus | null => ((SESSION_STATUSES as readonly unknown[]).includes(s) ? s as SessionStatus : null))), null),
  pid: z._default(z.pipe(z.unknown(), z.transform((p): number | null => (typeof p === "number" && Number.isSafeInteger(p) && p >= 1 ? p : null))), null),
});
export const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;

const DELIVERY_STATES = ["queued", "typed", "held", "delivered", "uncertain", "given_up"] as const satisfies readonly DeliveryState[];
const WAITING_REASONS = ["menu_open", "draft_present", "no_input_box", "busy", "no_pane", "no_session", "earlier", "unavailable"] as const satisfies readonly WaitingReason[];
const GIVE_UP_REASONS = ["expired", "cancelled", "gone", "refused"] as const satisfies readonly GiveUpReason[];
// A delivery as its node reports it (agent → fleet: shape), and as the fleet passes it on to clients (§4.4, §8).
export const DeliverySchema = z.object({
  id: label(), node: nodeName(), target: z.union([z.object({ lane: text() }), z.object({ workerId: workerId() })]),
  state: z.enum(DELIVERY_STATES), queuedAt: z.number(), notAfter: z.number(),
  waiting: z.exactOptional(z.object({ reason: z.enum(WAITING_REASONS), since: z.number() })),
  sessionId: z.exactOptional(text()), typedAt: z.exactOptional(z.number()), deliveredAt: z.exactOptional(z.number()),
  why: z.exactOptional(z.enum(GIVE_UP_REASONS)), note: z.exactOptional(label()),
  stashed: z.exactOptional(z.object({ at: z.number(), since: z.number(), chars: count(), copy: text() })),
});

// Each op's result, as the fleet accepts it (agent → fleet: shape).
export const OP_RESULTS = {
  "inventory.get": z.object({ panes: z.array(PaneSchema), invVersion: count() }),
  "pane.captureMany": z.object({ captures: z.array(z.object({ workerId: workerId(), text: z.nullable(text()), truncated: z.boolean() })) }),
  "pane.frame": z.object({
    frame: z.nullable(z.object({ cols: count(), rows: count(), x: count(), y: count(), cursor: z.boolean(), lines: z.array(text()) })),
  }),
  "pane.keys": z.object({ ok: z.boolean() }),
  "pane.send": z.object({ problem: z.nullable(z.enum(SEND_PROBLEMS)), typedAt: z.number() }),
  "op.status": z.object({ state: z.enum(["unknown", "started", "done"]), outcome: z.exactOptional(z.unknown()) }),
  "transcript.size": z.object({ size: z.nullable(count()) }),
  "transcript.read": z.object({ bytes: base64Chunk(), eof: z.boolean() }),
  "transcript.locate": z.object({ offset: z.nullable(count()) }),
  "file.stat": z.object({ size: count(), mtime: z.number() }),
  "file.get": z.object({ bytes: base64Chunk(), size: count(), eof: z.boolean() }),
  "file.put": z.object({ path: z.nullable(text()) }),
  "lane.start": z.object({ workerId: workerId(), waiting: z.exactOptional(z.literal("trust")), prompt: z.exactOptional(label()), engine: z.exactOptional(LaneEngineSchema) }),
  "lane.stop": z.object({ ok: z.literal(true) }),
  "worktree.list": z.object({ worktrees: z.array(z.object({ path: text(), branch: z.nullable(text()) })) }),
  "worktree.add": z.object({ path: text() }),
  "pane.capture": z.object({ text: z.nullable(text()), truncated: z.boolean() }),
  "lane.deliver": z.object({ delivery: DeliverySchema }),
  "delivery.cancel": z.object({ delivery: DeliverySchema }),
  "memory.sync": z.object({ committed: z.boolean(), written: count(), removed: count(), skillDirs: z.array(text()), conflicts: z.array(text()) }),
  "job.cancel": z.object({ ok: z.literal(true) }),
  "job.notice": z.object({ ok: z.literal(true) }),
  "job.noticeResult": z.object({ ok: z.literal(true) }),
  "connections.priority": z.object({ ok: z.literal(true) }),
  "connections.role": z.object({ ok: z.literal(true) }),
  "connections.revoke": z.object({ ok: z.literal(true) }),
  "connections.narrow": z.object({ ok: z.literal(true) }),
  "update.apply": z.object({ accepted: z.literal(true) }),
} satisfies Record<OpName, z.ZodMiniType>;

const ERROR_CODES = Object.keys(ERROR_EXECUTED) as ErrorCode[];
// A code a newer agent (or fleet) adds reads as "internal" and, whatever `executed` it came with, as "maybe": it may
// have run (§5.3), so nothing is retried on a guess. A known code keeps the `executed` it was sent with. Every end that
// reads an op's error reads it with this, so the hub and the fleet agree on a code neither knows.
export function readOpError(code: string, executed: Executed, message: string): OpError {
  return ERROR_CODES.includes(code as ErrorCode) ? { code: code as ErrorCode, executed, message } : { code: "internal", executed: "maybe", message };
}
const OpErrorSchema = z.pipe(
  z.object({ code: z.string(), executed: z.enum(["no", "maybe"]), message: text() }),
  z.transform((e): OpError => readOpError(e.code, e.executed, e.message)),
);

// A node's updater state as its health carries it (updates §6.3): the states of the domain's own state machine (§5.4).
// What a node reports is checked for shape here; whether a state may follow another is the domain's, on the node.
const UPDATE_HEALTH_FIELDS = {
  state: z.enum(["current", "staged", "waiting", "applying", "rolled_back", "rollback_failed"]),
  version: releaseVersion(), target: z.exactOptional(releaseVersion()), reason: z.exactOptional(label()), failedCheck: z.exactOptional(label()),
  attempt: z.exactOptional(z.string().check(z.regex(/^[A-Za-z0-9._:-]{1,64}$/))),
};
export const UpdateHealthSchema = z.object(UPDATE_HEALTH_FIELDS);
// What a machine's updater last did, as it writes it to ~/.local/state/morndo-update/state.json (updates §7): a node's
// agent reports it in its health; on the control plane the fleet reads it itself, so the control plane's own
// rollback halts its Rollout without a route anyone else could call (review of #107). `at`: when it was written.
// `soakMinutes` rides a `current` record: the commit's own soak (§4.5), the one number the fleet cannot know itself —
// absent is the domain's default.
export type UpdateStateFile = NodeUpdateHealth & { at: number; soakMinutes?: number };
export const UpdateStateFileSchema = z.strictObject({
  ...UPDATE_HEALTH_FIELDS,
  at: z.number(),
  soakMinutes: z.exactOptional(z.int().check(z.gte(0), z.lte(10_080))),
});
const HealthSchema = z.object({
  memTotal: z.number(), memAvailable: z.number(), psiSome10: z.nullable(z.number()), psiFull10: z.nullable(z.number()),
  diskFreeHome: z.number(), load1: z.number(), tmuxOk: z.boolean(), wallClock: z.number(), spoolDepth: count(), drops: count(),
  jobs: z.exactOptional(z.string()), tzOffsetMin: z.exactOptional(z.int().check(z.gte(-840), z.lte(840))),
  update: z.exactOptional(UpdateHealthSchema),
});
const HookEventSchema = z.object({
  streamId: z.uuid(), seq: z.int().check(z.gte(1)), at: z.number(),
  path: z.enum(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file", "/lane"]),
  node: nodeName(), window: z.nullable(text()), late: z.exactOptional(z.literal(true)), body: z.unknown(),
});

const PendingTaskSchema = z.object({ type: label(), label: label() });
const PendingWakeSchema = z.object({ schedule: label(), recurring: z.boolean() });

// The body of a "/lane" hook event: a lane state event the node made from its session's status (fleet clients §7).
export type LaneStateBody = { event: "needs_input" | "answered"; sessionId: string | null; question?: string };
export const LaneStateBodySchema = z.object({
  event: z.enum(["needs_input", "answered"]), sessionId: z.nullable(text()), question: z.exactOptional(label()),
});
// A lane event as the fleet publishes and serves it (§7, §8).
export const LaneEventSchema = z.object({
  v, t: z.literal("lane"), seq: z.int().check(z.gte(1)), event: z.enum(["finished", "needs_input", "answered", "stop_failure", "stale"]),
  node: nodeName(), window: z.nullable(text()), lane: z.nullable(text()), sessionId: z.exactOptional(text()), at: z.number(),
  status: z.exactOptional(z.nullable(z.enum(["done", "blocked", "needs_decision", "waiting"]))), firstLine: z.exactOptional(text()),
  bg: z.exactOptional(count()), crons: z.exactOptional(count()), question: z.exactOptional(text()), error: z.exactOptional(text()),
  waitingOn: z.exactOptional(text()), until: z.exactOptional(z.number()), reason: z.exactOptional(z.enum(["waiting", "no_status", "no_turn_end"])),
  since: z.exactOptional(z.number()), stalls: z.exactOptional(count()),
  tasks: z.exactOptional(z.array(PendingTaskSchema).check(z.maxLength(8))), wakes: z.exactOptional(z.array(PendingWakeSchema).check(z.maxLength(8))),
});
const RUN_WAIT = z.discriminatedUnion("on", [
  z.object({ on: z.literal("background"), tasks: z.array(PendingTaskSchema).check(z.maxLength(8)) }),
  z.object({ on: z.literal("wakeup"), next: z.nullable(z.number()) }),
  z.object({ on: z.literal("job"), jobs: z.array(z.object({ id: text(), name: text() })) }),
  z.object({ on: z.literal("declared"), what: z.nullable(text()) }),
]);
// A Run as the fleet serves it (GET /v1/runs: { runs }; the `run` event's body). A client decodes each and drops one it
// can't read.
export const RunViewSchema = z.object({
  lane: text(), node: nodeName(), sessionId: z.exactOptional(text()), phase: z.enum(RUN_PHASES), wait: z.exactOptional(RUN_WAIT),
  deadline: z.nullable(z.number()), overdue: z.boolean(), outcome: z.exactOptional(z.enum(["done", "blocked", "needs_decision", "no_status"])),
  line: z.exactOptional(text()), question: z.exactOptional(text()), since: z.number(), source: z.enum(["hook", "session", "job", "status"]),
});

// ---- messages, agent → fleet

// Once per node (§5.1): the code from the join string, bound to `node`, and the key the node made.
export const Join = z.object({
  v, t: z.literal("join"), node: nodeName(), code: joinCode(), publicKey: ed25519Spki(), agent: z.object({ version: label() }), proto: protoList(),
});
// A capability a hello may carry beside its ops: this agent takes pane.send and lane.deliver text up to
// LIMITS.maxMessageText. A node that has not said it gets no message over maxSendText.
export const CAP_LONG_TEXT = "long-text";
// Two of the updates design (§7): CAP_ROLLOUT — this agent takes the `rollout` message, the Rollout as it stands; a
// node that has not said it is sent none and stays connected. CAP_UPDATE — this node's policy allows the update.apply
// op; without it the op answers unknown_op, as an agent that never knew it.
export const CAP_ROLLOUT = "rollout";
export const CAP_UPDATE = "update";

// The Rollout as the fleet carries it (updates §4.2, §4.3, §7): the one Version in flight, when the control plane
// committed it (null: not yet — a Version nobody committed), how long a Version soaks before the next follows (§4.5),
// and, when a node's rollback halted it (RL12), who halted it, why and when. `haltedBy` is a node name (the machine
// whose rollback or whose owner's hand stopped it).
export type RolloutWire = {
  version: string; controlPlaneCommittedAt: number | null; soakMinutes: number; halted: boolean;
  haltedBy: string | null; haltReason: string | null; haltedAt: number | null;
};
export const RolloutWireSchema = z.object({
  version: releaseVersion(), controlPlaneCommittedAt: z.nullable(z.number()), soakMinutes: z.int().check(z.gte(0), z.lte(10_080)),
  halted: z.boolean(), haltedBy: z.nullable(nodeName()), haltReason: z.nullable(label()), haltedAt: z.nullable(z.number()),
});

// The fleet view file (updates §6.7, §7): ~/.local/state/morndo-node/fleet-view.json, what the node agent last heard
// from the fleet — the build the control plane runs, the Rollout as it stands, and the offer the fleet made this node
// (the Version it may take and the attempt id it reports a rollback of it under, §5.4) — with the moment it was
// heard. The agent writes it; the node's updater reads it. `controlPlane` null: a fleet that ran no control plane said
// so; `offer` null: the last word carried no offer, and a node without one applies nothing. Strict: anything else is
// not a view, never a guess at what it might have meant.
export type FleetViewFile = {
  observedAt: number;
  controlPlane: { version: string; commit: string | null } | null;
  rollout: RolloutWire | null;
  offer: { version: string; attempt: string } | null;
};
export const FleetViewFileSchema = z.strictObject({
  observedAt: z.number(),
  controlPlane: z.nullable(z.object({ version: semver(), commit: z.nullable(buildCommit()) })),
  rollout: z.nullable(RolloutWireSchema),
  offer: z.nullable(offer()),
});

// Every connection (§5.2). `caps`: the ops this node's policy allows, and capabilities beside them (CAP_LONG_TEXT;
// strings: a newer agent's are ignored, not refused).
export const Hello = z.object({
  v, t: z.literal("hello"), node: nodeName(), instanceId: z.uuid(), streamId: z.uuid(), proto: protoList(),
  agent: z.object({ version: label(), commit: z.exactOptional(buildCommit()) }), claude: z.object({ version: z.nullable(label()) }),
  caps: z.array(label()).check(z.maxLength(64)), clientNonce: nonce(),
});
export const Proof = z.object({ v, t: z.literal("proof"), sig: signature() });
// An op's answer: `result` is checked against OP_RESULTS by whoever knows which op `id` asked for. `store`: the stream
// id of the agent database that answers, where its done keys live (a new or restored database is a new store), so a
// caller asking op.status can tell that the keys it asks about may be gone. `storeSeq`: how many keyed ops that database
// has started when it answers (one more with each `started`, never lowered), so a database put back from an older copy,
// which keeps its store, answers a lower number than its callers saw before (final review I2). Optional: an agent from
// before it omits it, and a caller then compares stores only.
export const Res = z.discriminatedUnion("ok", [
  z.object({ v, t: z.literal("res"), id: reqId(), invVersion: count(), storeSeq: z.exactOptional(count()), store: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.object({ v, t: z.literal("res"), id: reqId(), invVersion: count(), storeSeq: z.exactOptional(count()), store: z.uuid(), ok: z.literal(false), error: OpErrorSchema }),
]);
export const EvHook = z.object({ v, t: z.literal("ev.hook"), event: HookEventSchema });
export const EvInventory = z.object({ v, t: z.literal("ev.inventory"), panes: z.array(PaneSchema), invVersion: count() });
export const EvHealth = z.object({ v, t: z.literal("ev.health"), health: HealthSchema });
// The latest state of one delivery (fleet clients §4.4): on every change, and after every (re)connect for each one not
// final and the final ones of the last hour. Latest wins, as the inventory.
export const EvDelivery = z.object({ v, t: z.literal("ev.delivery"), delivery: DeliverySchema });

// ---- messages, fleet → agent

export const Challenge = z.object({ v, t: z.literal("challenge"), nonce: nonce(), fleetSig: signature() });
// `storeSeqSeen`: the highest store sequence the fleet has seen from the hello's store (fleet.db keeps it). An agent
// whose own is lower was put back from an older copy, and starts a new store before it runs anything. Optional: a
// fleet from before it omits it, and an agent from before it ignores it. `controlPlane` and `rollout` (updates §7):
// the build this fleet runs and the Rollout as it stands — optional, so a fleet from before them, and the join
// placeholder welcome that says only that the node was accepted, stay what they were.
export const Welcome = z.object({
  v, t: z.literal("welcome"), connEpoch: z.int().check(z.gte(1)), ackSeq: count(), streamKnown: z.boolean(), storeSeqSeen: z.exactOptional(count()),
  controlPlane: z.exactOptional(z.object({ version: semver(), commit: z.nullable(buildCommit()) })),
  rollout: z.exactOptional(z.nullable(RolloutWireSchema)),
  // The Rollout this node may follow and the attempt id the fleet issued it for that (absent: nothing to follow).
  offer: z.exactOptional(offer()),
});
// `op` is any name here: one the agent doesn't know is answered `unknown_op`, and arguments that don't fit OP_ARGS
// `bad_args`, never dropped as a malformed message.
export const Req = z.object({
  v, t: z.literal("req"), id: reqId(), op: z.string().check(z.minLength(1), z.maxLength(64)), args: z.unknown(),
  timeoutMs: z.int().check(z.gte(1), z.lte(600_000)), key: z.exactOptional(opKey()),
});
// Hook events up to `seq` of `streamId` are stored (cumulative).
export const Ack = z.object({ v, t: z.literal("ack"), streamId: z.uuid(), seq: count() });
// The Rollout as it stands, on every change of it (updates §7): committed, halted, resumed. Only to agents whose hello
// carried CAP_ROLLOUT; an agent from before the updates design would close on a frame it does not know.
export const EvRollout = z.object({ v, t: z.literal("rollout"), rollout: RolloutWireSchema, offer: z.exactOptional(offer()) });

export const AgentMessage = z.discriminatedUnion("t", [Join, Hello, Proof, Res, EvHook, EvInventory, EvHealth, EvDelivery, EvJob]);
export const FleetMessage = z.discriminatedUnion("t", [Challenge, Welcome, Req, Ack, EvRollout]);
export type AgentMessage = z.output<typeof AgentMessage>;
export type FleetMessage = z.output<typeof FleetMessage>;
// The same messages by `t`, for decode() (decode.ts): a `t` nobody knows is told apart from a malformed message, so
// it is answered with an error (§5), never ignored.
export const AgentFrames = {
  join: Join, hello: Hello, proof: Proof, res: Res, "ev.hook": EvHook, "ev.inventory": EvInventory, "ev.health": EvHealth, "ev.delivery": EvDelivery,
  job: EvJob,
};
export const FleetFrames = { challenge: Challenge, welcome: Welcome, req: Req, ack: Ack, rollout: EvRollout };

// ---- the handshake (§5.2): what each side signs. The prefix keeps one side's signature from passing as the other's.

const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
function payload(side: "fleet" | "node", node: string, nonceValue: string): string {
  if (!NODE_NAME.test(node) || !NONCE.test(nonceValue)) throw new TypeError("a signing payload needs a node name and a base64url nonce");
  return `morndo-fleet/1/${side}\n${node}\n${nonceValue}`;
}
export function fleetSigPayload(node: string, clientNonce: string): string { return payload("fleet", node, clientNonce); }
export function nodeSigPayload(node: string, nonce: string): string { return payload("node", node, nonce); }

// ---- the join string (§5.1): what `morndo-fleet node add <name>` prints and `morndo-node join` takes.

export type JoinString = { url: string; fleetKey: string /* spki DER base64 */; code: string /* base64url, 16 bytes */; node: string };
const JOIN_PREFIX = "morndo-join:1:";
const JoinStringSchema = z.object({
  url: z.string().check(z.maxLength(2048), z.refine(fleetUrlOk, "wss://, or ws:// to this machine")), fleetKey: ed25519Spki(), code: joinCode(), node: nodeName(),
});

// base64url and UTF-8 with only what ECMAScript itself has: this package also runs in the browser, and its types
// include neither Buffer nor TextEncoder (tsconfig: lib esnext, no types).
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function toBase64url(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += B64URL.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += B64URL.charAt(n & 63);
  }
  return out;
}
function fromBase64url(s: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of s) {
    acc = ((acc << 6) | B64URL.indexOf(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
// encodeURIComponent writes a string's UTF-8 bytes as %XX (all but a few ASCII characters, which stay as they are).
const utf8 = (s: string) => (encodeURIComponent(s).match(/%[0-9A-F]{2}|[^%]/g) ?? []).map(p => (p.length === 3 ? parseInt(p.slice(1), 16) : p.charCodeAt(0)));
const fromUtf8 = (bytes: readonly number[]) => decodeURIComponent(bytes.map(b => `%${b.toString(16).padStart(2, "0")}`).join(""));

// "morndo-join:1:" + base64url(JSON). A JoinString that couldn't be parsed back is a bug in the caller: it throws.
export function formatJoinString(j: JoinString): string {
  const r = z.safeParse(JoinStringSchema, j);
  if (!r.success) throw new TypeError("not a join string: a wss:// URL (ws:// only to this machine), an Ed25519 key, a 16-byte code and a node name");
  return JOIN_PREFIX + toBase64url(utf8(JSON.stringify({ url: j.url, fleetKey: j.fleetKey, code: j.code, node: j.node })));
}

// As the owner pastes it: whitespace anywhere (a trailing newline, a line a terminal wrapped) and quotes around it,
// straight or typographic, are dropped; none of them can be part of the string itself. Anything else that doesn't
// decode to a whole join string, a truncated one above all, is null.
export function parseJoinString(s: string): JoinString | null {
  const t = s.replace(/\s+/g, "").replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  if (!t.startsWith(JOIN_PREFIX)) return null;
  const bytes = fromBase64url(t.slice(JOIN_PREFIX.length));
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(fromUtf8(bytes)); } catch { return null; }
  const r = z.safeParse(JoinStringSchema, value);
  return r.success ? r.data : null;
}

// The schemas decode to exactly the types above (checked at compile time), so a decoded value needs no cast.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<(typeof OP_NAMES)[number], OpName>>(true);
check<Same<{ [O in OpName]: z.output<(typeof OP_ARGS)[O]> }, OpArgs>>(true);
check<Same<{ [O in OpName]: z.output<(typeof OP_RESULTS)[O]> }, OpResult>>(true);
check<Same<z.output<typeof ExpectSchema>, Expect>>(true);
check<Same<z.output<typeof PaneSchema>, Pane>>(true);
check<Same<z.output<typeof OpErrorSchema>, OpError>>(true);
check<Same<z.output<typeof HealthSchema>, Health>>(true);
check<Same<z.output<typeof HookEventSchema>, HookEvent>>(true);
check<Same<z.output<typeof JoinStringSchema>, JoinString>>(true);
check<Same<z.output<typeof DeliverySchema>, Delivery>>(true);
check<Same<z.output<typeof DeliveryTargetSchema>, DeliveryTarget>>(true);
check<Same<z.output<typeof LaneEventSchema>, LaneEvent>>(true);
check<Same<z.output<typeof RunViewSchema>, RunView>>(true);
check<Same<z.output<typeof LaneStateBodySchema>, LaneStateBody>>(true);
check<Same<z.output<typeof RolloutWireSchema>, RolloutWire>>(true);
check<Same<z.output<typeof UpdateHealthSchema>, NodeUpdateHealth>>(true);
check<Same<z.output<typeof FleetViewFileSchema>, FleetViewFile>>(true);
check<Same<z.output<typeof UpdateStateFileSchema>, UpdateStateFile>>(true);
check<Same<(typeof SESSION_STATUSES)[number], SessionStatus>>(true);
