// The fleet's agent channel (docs/design/fleet-core/README.md §5, ADR-0012): one WebSocket per node between its agent
// and the fleet service, JSON messages `{ v: 1, t, … }`, both directions, validated with zod/mini on both sides. Here:
// the protocol versions, every limit the spec sets (LIMITS, the one place they live), the typed operations with their
// arguments and results, the events, the handshake's signing payloads and the join string.
// What a node is asked to do (op arguments) is strict, with limits: the agent acts on it. What a node reports (results,
// events) is checked for shape; each message is bounded by maxMessageBytes anyway.
import { JOB_ID, NOTICE_MAX } from "@morndo/domain";
import { EvJob } from "./jobs.ts";
import * as z from "./z.ts";
import { NarrowCommand, PriorityCommand, RevokeCommand, RoleCommand } from "./connections.ts";
import { NODE_NAME, WORKER_ID } from "./worker-id.ts";

export const FLEET_PROTO = 1;            // the agent channel; accepted: [FLEET_PROTO - 1, FLEET_PROTO] ∩ ≥ 1
export const CLIENT_API = 1;             // the client API's routes: /v1/

export const LIMITS = {
  // messages: each at most 512 KiB; both ends set `maxPayload` to 1 MiB; bulk data in chunks of 256 KiB before base64
  maxMessageBytes: 524_288, maxPayload: 1_048_576, chunkBytes: 262_144,
  // content: files 25 MiB (as the hub's own copies, MAX_FILE_BYTES), typed text, keystrokes, panes per capture, a needle
  maxFileBytes: 26_214_400, maxSendText: 8000, maxKeys: 4096, captureManyMax: 64, captureBytesPerPane: 6144, maxNeedle: 200,
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
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal"
  | "updating";
export type Executed = "no" | "maybe";
// Whether the side effect may have happened (§5.3): "no" is safe to retry. Only an answer that may have come after the
// side effect started is "maybe".
export const ERROR_EXECUTED: Record<ErrorCode, Executed> = {
  bad_args: "no", unknown_op: "no", denied: "no", no_pane: "no", menu_open: "no", no_input_box: "no", draft_present: "no",
  busy: "no", name_taken: "no", lane_conflict: "no", too_large: "no", timeout: "no", node_offline: "no", uncertain: "maybe", internal: "maybe",
  updating: "no",
};
export type OpError = { code: ErrorCode; executed: Executed; message: string };

// `title`: the pane's terminal title (tmux pane_title); `sessionName`: the name Claude Code's session registry gives the
// session running there (what legacy shows as the session's name).
export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; sessionName?: string; title?: string; claudeVersion?: string };
export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add" | "job.cancel" | "job.notice" | "job.noticeResult"
  | "connections.priority" | "connections.role" | "connections.revoke" | "connections.narrow";
export type OpArgs = {
  "inventory.get": Record<string, never>;
  "pane.captureMany": { workerIds: string[] };
  "pane.frame": { workerId: string };
  "pane.keys": { workerId: string; data: string; expect: Expect };
  "pane.send": { workerId: string; text: string; expect: Expect };
  "op.status": { key: string };
  "transcript.size": { sessionId: string };
  "transcript.read": { sessionId: string; offset: number; max: number };
  "transcript.locate": { sessionId: string; needle: string };
  "file.stat": { path?: string; ref?: string };
  "file.get": { path?: string; ref?: string; offset: number; max: number };
  "file.put": { upload: string; offset: number; bytes: string /* base64 */; final: boolean; name: string };
  "lane.start": { name: string; cwd: string; account?: string; resume?: string };
  "lane.stop": { name: string };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };
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
  "lane.start": { workerId: string };
  "lane.stop": { ok: true };
  "worktree.list": { worktrees: { path: string; branch: string | null }[] };
  "worktree.add": { path: string };
  "job.cancel": { ok: true };
  "job.notice": { ok: true };
  "job.noticeResult": { ok: true };
  "connections.priority": { ok: true };
  "connections.role": { ok: true };
  "connections.revoke": { ok: true };
  "connections.narrow": { ok: true };
};
// Ops with a side effect, which carry a caller's idempotency key (§5.3). Keystrokes carry none: they are never retried.
export const KEYED_OPS: ReadonlySet<OpName> = new Set<OpName>([
  "pane.send", "file.put", "lane.start", "lane.stop", "worktree.add", "job.notice",
  "connections.priority", "connections.role", "connections.revoke", "connections.narrow",
]);
// A fresh passkey. Narrowing (off, a lower budget, a deny) is not in this set.
export const STEP_UP_OPS: ReadonlySet<OpName> = new Set<OpName>(["connections.priority", "connections.role", "connections.revoke"]);

export type Health = { memTotal: number; memAvailable: number; psiSome10: number | null; psiFull10: number | null;
  diskFreeHome: number; load1: number; tmuxOk: boolean; wallClock: number; spoolDepth: number; drops: number;
  jobs?: string };
export type HookEvent = { streamId: string; seq: number; at: number; path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file";
  node: string; window: string | null; late?: true; body: unknown };

// What the fleet service raises for the owner (spec §5.2, §5.4, §5.6, §7, §8): kept as audit rows, served oldest first by
// the client API's GET /v1/alerts and sent as the "alert" event. `detail` is per kind (plan Contracts, "Alerts").
export const ALERT_KINDS = ["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter", "backlog_full", "unrouted_hook",
  "job_failed", "job_unnoticed", "connection"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type Alert = { id: number; at: number; node: string | null; kind: AlertKind; detail: Record<string, unknown> };

// ---- the pieces messages are made of

const v = z.literal(1);
const text = () => z.string();                                              // node → fleet: shape only
const label = () => z.string().check(z.maxLength(200));
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
// A lane is a tmux window: its name may hold spaces, unicode, dots and slashes, never a control character.
const windowName = () => z.string().check(z.regex(/^[^\p{Cc}]{1,200}$/u));
const offset = () => z.int().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));
const chunkMax = () => z.int().check(z.gte(1), z.lte(LIMITS.chunkBytes));
const base64Chunk = () => z.base64().check(z.maxLength(4 * Math.ceil(LIMITS.chunkBytes / 3)));
// 16 to 64 random bytes, base64url: the handshake's nonces.
const nonce = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{22,86}$/));
// An Ed25519 signature (64 bytes) and an Ed25519 public key as SPKI DER (44 bytes), base64 (Node's `sign(null, …)`,
// `export({ format: "der", type: "spki" })`; https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-06).
const signature = () => z.string().check(z.regex(/^[A-Za-z0-9+/]{86}==$/));
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

export const OP_NAMES = [
  "inventory.get", "pane.captureMany", "pane.frame", "pane.keys", "pane.send", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "file.put",
  "lane.start", "lane.stop", "worktree.list", "worktree.add", "job.cancel", "job.notice", "job.noticeResult",
  "connections.priority", "connections.role", "connections.revoke", "connections.narrow",
] as const satisfies readonly OpName[];

// Each op's arguments, as the agent accepts them (fleet → agent: strict).
export const OP_ARGS = {
  "inventory.get": z.record(z.string(), z.never()),
  "pane.captureMany": z.object({ workerIds: z.array(workerId()).check(z.maxLength(LIMITS.captureManyMax)) }),
  "pane.frame": z.object({ workerId: workerId() }),
  "pane.keys": z.object({ workerId: workerId(), data: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxKeys)), expect: ExpectSchema }),
  "pane.send": z.object({ workerId: workerId(), text: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxSendText)), expect: ExpectSchema }),
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
  "lane.start": z.object({ name: windowName(), cwd: absolutePath(), account: z.exactOptional(account()), resume: z.exactOptional(z.uuid()) }),
  "lane.stop": z.object({ name: windowName() }),
  "worktree.list": z.object({ repo: absolutePath() }),
  "worktree.add": z.object({ repo: absolutePath(), name: refName(), base: refName() }),
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
} satisfies Record<OpName, z.ZodMiniType>;

const PaneSchema = z.object({
  workerId: workerId(), window: text(), cwd: text(),
  sessionId: z.exactOptional(text()), sessionName: z.exactOptional(text()), title: z.exactOptional(text()), claudeVersion: z.exactOptional(text()),
});
export const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;

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
  "lane.start": z.object({ workerId: workerId() }),
  "lane.stop": z.object({ ok: z.literal(true) }),
  "worktree.list": z.object({ worktrees: z.array(z.object({ path: text(), branch: z.nullable(text()) })) }),
  "worktree.add": z.object({ path: text() }),
  "job.cancel": z.object({ ok: z.literal(true) }),
  "job.notice": z.object({ ok: z.literal(true) }),
  "job.noticeResult": z.object({ ok: z.literal(true) }),
  "connections.priority": z.object({ ok: z.literal(true) }),
  "connections.role": z.object({ ok: z.literal(true) }),
  "connections.revoke": z.object({ ok: z.literal(true) }),
  "connections.narrow": z.object({ ok: z.literal(true) }),
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

const HealthSchema = z.object({
  memTotal: z.number(), memAvailable: z.number(), psiSome10: z.nullable(z.number()), psiFull10: z.nullable(z.number()),
  diskFreeHome: z.number(), load1: z.number(), tmuxOk: z.boolean(), wallClock: z.number(), spoolDepth: count(), drops: count(),
  jobs: z.exactOptional(z.string()),
});
const HookEventSchema = z.object({
  streamId: z.uuid(), seq: z.int().check(z.gte(1)), at: z.number(),
  path: z.enum(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"]),
  node: nodeName(), window: z.nullable(text()), late: z.exactOptional(z.literal(true)), body: z.unknown(),
});

// ---- messages, agent → fleet

// Once per node (§5.1): the code from the join string, bound to `node`, and the key the node made.
export const Join = z.object({
  v, t: z.literal("join"), node: nodeName(), code: joinCode(), publicKey: ed25519Spki(), agent: z.object({ version: label() }), proto: protoList(),
});
// Every connection (§5.2). `caps`: the ops this node's policy allows (strings: a newer agent's are ignored, not refused).
export const Hello = z.object({
  v, t: z.literal("hello"), node: nodeName(), instanceId: z.uuid(), streamId: z.uuid(), proto: protoList(),
  agent: z.object({ version: label() }), claude: z.object({ version: z.nullable(label()) }),
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

// ---- messages, fleet → agent

export const Challenge = z.object({ v, t: z.literal("challenge"), nonce: nonce(), fleetSig: signature() });
// `storeSeqSeen`: the highest store sequence the fleet has seen from the hello's store (fleet.db keeps it). An agent
// whose own is lower was put back from an older copy, and starts a new store before it runs anything. Optional: a
// fleet from before it omits it, and an agent from before it ignores it.
export const Welcome = z.object({
  v, t: z.literal("welcome"), connEpoch: z.int().check(z.gte(1)), ackSeq: count(), streamKnown: z.boolean(), storeSeqSeen: z.exactOptional(count()),
});
// `op` is any name here: one the agent doesn't know is answered `unknown_op`, and arguments that don't fit OP_ARGS
// `bad_args`, never dropped as a malformed message.
export const Req = z.object({
  v, t: z.literal("req"), id: reqId(), op: z.string().check(z.minLength(1), z.maxLength(64)), args: z.unknown(),
  timeoutMs: z.int().check(z.gte(1), z.lte(600_000)), key: z.exactOptional(opKey()),
});
// Hook events up to `seq` of `streamId` are stored (cumulative).
export const Ack = z.object({ v, t: z.literal("ack"), streamId: z.uuid(), seq: count() });

export const AgentMessage = z.discriminatedUnion("t", [Join, Hello, Proof, Res, EvHook, EvInventory, EvHealth, EvJob]);
export const FleetMessage = z.discriminatedUnion("t", [Challenge, Welcome, Req, Ack]);
export type AgentMessage = z.output<typeof AgentMessage>;
export type FleetMessage = z.output<typeof FleetMessage>;
// The same messages by `t`, for decode() (decode.ts): a `t` nobody knows is told apart from a malformed message, so
// it is answered with an error (§5), never ignored.
export const AgentFrames = { join: Join, hello: Hello, proof: Proof, res: Res, "ev.hook": EvHook, "ev.inventory": EvInventory, "ev.health": EvHealth, job: EvJob };
export const FleetFrames = { challenge: Challenge, welcome: Welcome, req: Req, ack: Ack };

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
