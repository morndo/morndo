// A fake fleet service for the hub's tests (spec §9: "They run in both legacy and fleet configuration against a fake
// fleet"): the client API (/v1/, spec §5.6, in the wire format of plan.md § Contracts, "Client API") on a temporary
// Unix socket, with nodes made of the test's own ports. Each node keeps the agent's two-phase keys (spec §5.3: started
// before the side effect, done with the reply after, released on a refusal with executed "no"; a repeat of a done key
// gets the stored reply, of a started one "uncertain", and a key reused with other effect-determining arguments is
// "uncertain" too) and checks every expectation right before acting (spec §4), so the hub's fleet adapters meet the
// answers a real agent gives. Each node has a store (its agent database's id) that every answer carries; resetStore()
// is an agent database lost and made anew, its keys gone. Each answer carries the node's store sequence too (one more for
// every keyed op started, final review I2), unless the node is made as an agent from before it (`storeSeq: false`);
// copy() is a copy of its database, and putting it back is a restore in place: the same store, the keys and the sequence
// as they were when copied. The lane registry is the real one's (Task 12): one row per
// name, owned by the first node that claimed it, in conflict while two windows claim it (its workerId null when both are
// on the owner), and routing by a name in conflict is lane_conflict. A test can take a node offline, announce an
// inventory, and put itself in front of any op (to drop an answer after the paste, say). Deliveries (fleet-clients §4,
// §8): the fleet keeps each one and never types it; a test moves it on as a node's deliverer would (moveDelivery), and
// every subscriber hears each change as a `delivery` event. Synthetic data only.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLIENT_API, ERROR_EXECUTED, LIMITS, formatWorkerId, parseWorkerId,
  type Alert, type Delivery, type ErrorCode, type LaneEvent, type OpError, type Pane, type SessionStatus,
} from "@morndo/protocol";
import type { SendProblem, SessionInfo, Terminal } from "@morndo/node-ops";
import type { Sessions, Tmux, TranscriptSource } from "../../src/application/ports.ts";

export type NodeStatus = "online" | "stale" | "offline";
export type Reply = { ok: true; result: unknown } | { ok: false; error: OpError };
export type FleetCall = { op: string; node: string | null; target: Record<string, string>; args: unknown; key: string | null; timeoutMs: number | null };
export type Intercept = (call: FleetCall, next: () => Promise<Reply>) => Promise<Reply>;

export const refusal = (code: ErrorCode, message: string = code): Reply => ({ ok: false, error: { code, executed: ERROR_EXECUTED[code], message } });
// The fleet's answer when the connection to the node dropped while an op was out: it may or may not have happened.
export const LOST: Reply = refusal("uncertain", "the connection to the node dropped");

export async function until(f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`not within ${ms} ms`);
    await new Promise(r => setTimeout(r, 20));
  }
}

// One node's machine as the legacy hub sees it: its ports keyed by tmux pane ids ("%1"). The node names those panes
// `<node>.<server>.<pane>` on the wire.
export type NodeBackend = {
  tmux: Tmux;
  terminal?: Terminal;
  sessions?: Sessions;
  transcripts?: TranscriptSource;
  readFile?: (path: string) => Promise<{ bytes: Uint8Array; mtime: number } | null>;
  inboxDir?: string;
  keyNames?: (pane: string, names: string[]) => Promise<boolean>;      // pane.keys by key name (fleet-clients §5)
  // The session's title and last prompt (its transcript's `ai-title` and `last-prompt`; reconciliation ruling 13).
  topicOf?: (pane: string) => { topic?: string; lastPrompt?: string } | undefined;
};
export type KeyRow = { state: "started" | "done"; hash: string; reply?: Reply };
export type FakeNode = {
  readonly name: string;
  readonly server: string;
  readonly keys: Map<string, KeyRow>;                       // the agent's done keys, for a test to look at
  readonly store: string;                                   // its agent database's id, on every answer
  readonly storeSeq: number | null;                         // its store sequence, on every answer; null: never sent
  resetStore(): void;                                       // the agent database lost: a new store, no keys
  copy(): () => void;                                       // its database copied now; the result puts the copy back in place
  inventory(): Promise<{ panes: Pane[]; invVersion: number }>;
  invVersion(): number;
  handle(op: string, args: unknown, key: string | null): Promise<Reply>;
  file(refOrPath: string): Promise<Uint8Array | null>;
};

const BEFORE_PASTE = new Set<string>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy"] satisfies SendProblem[]);
const ok = (result: unknown): Reply => ({ ok: true, result });

// What decides a keyed op's effect (plan.md, "Behaviour"): never its expectation, its deadline or its request id.
function effectOf(op: string, a: Record<string, unknown>): unknown[] {
  switch (op) {
    case "pane.send": return [op, a.workerId, a.text];
    case "file.put": return [op, a.upload, a.offset];
    case "lane.start": return [op, a.name, a.cwd, a.account, a.resume];
    case "lane.stop": return [op, a.name];
    case "worktree.add": return [op, a.repo, a.name, a.base];
    default: return [op, a];
  }
}

export function localNode(name: string, server: string, b: NodeBackend, o: { storeSeq?: boolean } = {}): FakeNode {
  const keys = new Map<string, KeyRow>();
  let store = randomUUID();
  let seq = 0;                                              // the store sequence: keyed ops started
  const uploads = new Map<string, Buffer[]>();
  let version = 0;
  let last = "";
  const idOf = (pane: string) => {
    const n = /^%(\d{1,9})$/.exec(pane)?.[1];
    return n === undefined ? null : formatWorkerId({ node: name, server, pane: Number(n) });
  };
  // The tmux pane a worker id names on this node, or null: another node, another tmux server, or not a worker id.
  const paneOf = (workerId: string) => {
    const ref = parseWorkerId(workerId);
    return ref && ref.node === name && ref.server === server ? `%${ref.pane}` : null;
  };

  async function inventory(): Promise<{ panes: Pane[]; invVersion: number }> {
    const workers = await b.tmux.listWorkers();
    const sessions = b.sessions ? await b.sessions.byPane() : new Map<string, SessionInfo>();
    const panes: Pane[] = workers.flatMap(w => {
      const workerId = idOf(w.id);
      if (workerId === null) return [];
      const s = sessions.get(w.id);
      const t = b.topicOf?.(w.id);
      return [{
        workerId, window: w.name, cwd: s?.cwd || w.location,
        ...(s ? { sessionId: s.sessionId } : {}), ...(s?.name ? { sessionName: s.name } : {}), ...(s?.version ? { claudeVersion: s.version } : {}),
        status: s?.status ?? null, pid: s ? s.pid : null,
        ...(t?.topic !== undefined ? { topic: t.topic } : {}), ...(t?.lastPrompt !== undefined ? { lastPrompt: t.lastPrompt } : {}),
      }];
    });
    const now = JSON.stringify(panes);
    if (now !== last) { last = now; version++; }
    return { panes, invVersion: version };
  }

  // The agent's check right before acting (spec §4): the same tmux server, the window still named so, and the same
  // session when one is named. Any mismatch is null ("no_pane", nothing done).
  async function expected(workerId: string, expect: unknown): Promise<string | null> {
    const pane = paneOf(workerId);
    const e = (typeof expect === "object" && expect !== null ? expect : {}) as { server?: unknown; window?: unknown; sessionId?: unknown };
    if (pane === null || e.server !== server) return null;
    const p = (await inventory()).panes.find(x => x.workerId === workerId);
    if (!p || p.window !== e.window) return null;
    if (e.sessionId !== undefined && p.sessionId !== e.sessionId) return null;
    return pane;
  }

  async function keyed(key: string | null, op: string, args: unknown, run: () => Promise<Reply>): Promise<Reply> {
    if (key === null) return run();
    const hash = JSON.stringify(effectOf(op, (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>));
    const known = keys.get(key);
    if (known) {
      if (known.hash !== hash) return refusal("uncertain", "this key was used for another request, which may have run");
      return known.state === "done" && known.reply ? known.reply : refusal("uncertain", "started and never finished");
    }
    keys.set(key, { state: "started", hash });
    seq++;
    let reply: Reply;
    try { reply = await run(); }
    catch (e) { return refusal("internal", (e as Error).message); }        // the key stays started: it may have happened
    if (!reply.ok && reply.error.executed === "no") keys.delete(key);
    else keys.set(key, { state: "done", hash, reply });
    return reply;
  }

  async function handle(op: string, args: unknown, key: string | null): Promise<Reply> {
    const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    const str = (k: string) => { const v = a[k]; return typeof v === "string" ? v : ""; };
    const num = (k: string) => { const v = a[k]; return typeof v === "number" ? v : 0; };
    switch (op) {
      case "inventory.get":
        return ok(await inventory());
      case "pane.captureMany": {
        const ids = Array.isArray(a.workerIds) ? a.workerIds.filter((x): x is string => typeof x === "string") : [];
        if (ids.length > LIMITS.captureManyMax) return refusal("too_large");
        const panes = ids.map(paneOf);
        const texts = await b.tmux.captureMany(panes.filter((p): p is string => p !== null));
        return ok({ captures: ids.map((workerId, i) => { const p = panes[i]; return { workerId, text: p ? texts.get(p) ?? null : null, truncated: false }; }) });
      }
      case "pane.frame": {
        const p = paneOf(str("workerId"));
        return ok({ frame: p !== null && b.terminal ? await b.terminal.frame(p) : null });
      }
      case "pane.keys": {
        const p = await expected(str("workerId"), a.expect);
        if (p === null) return refusal("no_pane");
        if (Array.isArray(a.names)) return ok({ ok: b.keyNames ? await b.keyNames(p, a.names.filter((x): x is string => typeof x === "string")) : false });
        return ok({ ok: b.terminal ? await b.terminal.keys(p, str("data")) : false });
      }
      case "pane.capture": {
        const p = paneOf(str("workerId"));
        const screen = p === null ? null : await b.tmux.capture(p);
        return ok({ text: screen === null ? null : screen.split("\n").slice(-Math.max(1, num("lines"))).join("\n"), truncated: false });
      }
      case "pane.send":
        return keyed(key, op, args, async () => {
          const p = await expected(str("workerId"), a.expect);
          if (p === null) return refusal("no_pane");
          const out = await b.tmux.send(p, str("text"), key ?? "");
          if (out.problem !== null && BEFORE_PASTE.has(out.problem)) return refusal(out.problem as ErrorCode);
          if (out.problem === "node_offline") return refusal("node_offline");
          return ok({ problem: out.problem, typedAt: out.typedAt });
        });
      case "op.status": {
        const k = keys.get(str("key"));
        if (!k) return ok({ state: "unknown" });
        return ok(k.state === "done" && k.reply ? { state: "done", outcome: k.reply.ok ? k.reply.result : k.reply.error } : { state: "started" });
      }
      case "transcript.size":
        return ok({ size: b.transcripts ? await b.transcripts.size(str("sessionId")) : null });
      case "transcript.read": {
        const r = b.transcripts ? await b.transcripts.read(str("sessionId"), num("offset"), Math.min(num("max"), LIMITS.chunkBytes)) : null;
        return r ? ok({ bytes: Buffer.from(r.bytes).toString("base64"), eof: r.eof }) : refusal("bad_args", "no such transcript");
      }
      case "transcript.locate":
        return ok({ offset: b.transcripts ? await b.transcripts.locate(str("sessionId"), str("needle")) : null });
      case "file.stat": {
        const f = b.readFile ? await b.readFile(str("path")) : null;
        return f ? ok({ size: f.bytes.length, mtime: f.mtime }) : refusal("denied", "not readable");
      }
      case "file.put":
        return keyed(key, op, args, async () => {
          if (b.inboxDir === undefined) return refusal("denied", "no inbox on this node");
          const id = str("upload");
          const parts = uploads.get(id) ?? [];
          const have = parts.reduce((n, p) => n + p.length, 0);
          if (num("offset") !== have) return refusal("bad_args", "a chunk out of order");
          const chunk = Buffer.from(str("bytes"), "base64");
          if (have + chunk.length > LIMITS.maxFileBytes) { uploads.delete(id); return refusal("too_large"); }
          parts.push(chunk);
          if (a.final !== true) { uploads.set(id, parts); return ok({ path: null }); }
          uploads.delete(id);
          mkdirSync(b.inboxDir, { recursive: true });
          const path = join(b.inboxDir, `${id}-${basename(str("name"))}`);
          writeFileSync(path, Buffer.concat(parts));
          return ok({ path });
        });
      default:
        return refusal("unknown_op", op);
    }
  }

  return {
    name, server, keys, inventory, handle,
    get store() { return store; },
    get storeSeq() { return o.storeSeq === false ? null : seq; },
    resetStore() { store = randomUUID(); keys.clear(); },
    copy() {
      const rows = new Map(keys);
      const at = seq;
      return () => { keys.clear(); for (const [k, r] of rows) keys.set(k, r); seq = at; };
    },
    invVersion: () => version,
    file: async refOrPath => (b.readFile ? (await b.readFile(refOrPath))?.bytes ?? null : null),
  };
}

// A node's machine in memory: panes by tmux id with a window name, a cwd, a screen and maybe a session; what was typed
// into them; transcripts by session and files by path. `problem` makes sends to that pane come back so (a refusal before
// the paste, or "not_submitted" after it). `hold()` makes the next send wait in the pane after its paste until released.
export type MemoryPane = {
  name: string; cwd: string; screen: string; sessionId?: string; problem?: SendProblem | null;
  status?: SessionStatus; pid?: number;                    // its session's, with a session (default "idle", 1)
  topic?: string; lastPrompt?: string;                      // its session's title and last prompt
};
export type MemoryBackend = NodeBackend & {
  panes: Record<string, MemoryPane>;
  typed: { pane: string; text: string; key: string }[];
  keysTyped: { pane: string; data: string }[];
  keyNamesTyped: { pane: string; names: string[] }[];
  typedAt: number | null;                                   // the node's clock for typedAt; null: Date.now()
  hold(): () => void;
};
export function memoryBackend(
  panes: Record<string, MemoryPane>,
  o: { inboxDir?: string; files?: Record<string, Uint8Array>; transcripts?: Record<string, Uint8Array> } = {},
): MemoryBackend {
  let held: Promise<void> | null = null;
  const transcriptOf = (sessionId: string) => o.transcripts?.[sessionId] ?? null;
  const b: MemoryBackend = {
    panes, typed: [], keysTyped: [], keyNamesTyped: [], typedAt: null,
    hold() {
      let release = () => {};
      held = new Promise<void>(r => { release = r; });
      return () => release();
    },
    tmux: {
      listWorkers: async () => Object.entries(b.panes).map(([id, p]) => ({ id, name: p.name, location: p.cwd, node: "local", offline: false })),
      capture: async id => b.panes[id]?.screen ?? null,
      captureMany: async ids => new Map(ids.map(id => [id, b.panes[id]?.screen ?? null])),
      send: async (id, text, key) => {
        const p = b.panes[id];
        if (!p) return { problem: "no_pane", typedAt: 0 };
        if (p.problem && p.problem !== "not_submitted") return { problem: p.problem, typedAt: 0 };
        b.typed.push({ pane: id, text, key });
        const wait = held;
        held = null;
        if (wait) await wait;
        return { problem: p.problem ?? null, typedAt: b.typedAt ?? Date.now() };
      },
    },
    terminal: {
      frame: async id => {
        const p = b.panes[id];
        if (!p) return null;
        const lines = p.screen.split("\n");
        return { cols: 80, rows: lines.length, x: 0, y: 0, cursor: true, lines };
      },
      keys: async (id, data) => {
        if (!b.panes[id]) return false;
        b.keysTyped.push({ pane: id, data });
        return true;
      },
    },
    topicOf: id => {
      const p = b.panes[id];
      return p ? { ...(p.topic !== undefined ? { topic: p.topic } : {}), ...(p.lastPrompt !== undefined ? { lastPrompt: p.lastPrompt } : {}) } : undefined;
    },
    keyNames: async (id, names) => {
      if (!b.panes[id]) return false;
      b.keyNamesTyped.push({ pane: id, names });
      return true;
    },
    sessions: {
      byPane: async () => {
        const out = new Map<string, SessionInfo>();
        for (const [id, p] of Object.entries(b.panes)) {
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: p.pid ?? 1, status: p.status ?? "idle" });
        }
        return out;
      },
    },
    transcripts: {
      size: async sessionId => transcriptOf(sessionId)?.length ?? null,
      read: async (sessionId, offset, max) => {
        const t = transcriptOf(sessionId);
        return t ? { bytes: t.subarray(offset, offset + max), eof: offset + max >= t.length } : null;
      },
      locate: async (sessionId, needle) => {
        const t = transcriptOf(sessionId);
        if (!t) return null;
        const at = Buffer.from(t).indexOf(needle);
        return at === -1 ? null : at;
      },
    },
    readFile: async path => {
      const f = o.files?.[path];
      return f ? { bytes: f, mtime: 1 } : null;
    },
    ...(o.inboxDir !== undefined ? { inboxDir: o.inboxDir } : {}),
  };
  return b;
}

// How GET /v1/files misbehaves: ends cleanly short of x-file-size, is destroyed mid-stream, sends more than x-file-size,
// or has no / a non-numeric x-file-size.
export type FileFault = "truncate" | "abort" | "overrun" | "no-size" | "bad-size";
export type FakeFleet = {
  readonly socketPath: string;
  readonly calls: FleetCall[];                              // every POST /v1/op, in order
  readonly clients: string[];                               // the x-morndo-client header of every request, in order
  readonly fileReads: string[];                             // "<node>:<path>" of every GET /v1/files
  node(name: string): FakeNode;
  setStatus(node: string, status: NodeStatus): Promise<void>;
  revoke(node: string): void;                               // as `morndo-fleet node revoke`: a status event "offline", then gone from /v1/nodes and the lanes
  fileFault(mode: FileFault | null): void;                  // for every file read from now on
  dropEvents(code: number): void;                           // close every events WebSocket with this close code (1013: try again later)
  announce(node: string): Promise<void>;                    // an inventory event with the node's panes now
  raise(alert: Alert): void;                                // served by GET /v1/alerts from now on, and sent as an event
  intercept(op: string, f: Intercept | null): void;
  // Deliveries (fleet-clients §4, §8): what each one is and carries, every POST /v1/deliveries in order, every cancel.
  readonly deliveries: ReadonlyMap<string, { delivery: Delivery; text: string }>;
  readonly deliveryCalls: { id: string; lane: string | null; workerId: string | null; text: string }[];
  readonly cancels: string[];
  moveDelivery(id: string, change: Partial<Delivery>): Delivery;   // as the node's deliverer would; a `delivery` event
  quietDeliveries(quiet: boolean): void;                    // true: no `delivery` events (one sent while unsubscribed)
  // The next n deliveries are stored, and their answer lost: the connection drops ("drop"), or no answer ever comes and
  // the client times out ("hang").
  loseDeliveryAnswers(n: number, how?: "drop" | "hang"): void;
  // The next n POSTs of a delivery are answered uncertain (executed maybe) and not stored.
  refuseDeliveries(n: number): void;
  // true: every GET /v1/deliveries/<id> from now on gets no answer (a fleet stuck on a busy fleet.db); each one's time.
  holdDeliveryReads(hold: boolean): void;
  // Every cancel from now on is answered this long after it arrived (a node slow to answer delivery.cancel).
  delayCancels(ms: number): void;
  readonly deliveryReads: { id: string; at: number }[];
  laneEvent(e: LaneEvent): void;                            // kept for GET /v1/lane-events, and sent as a `lane` event
  subscriberCount(): number;                                // events WebSockets open now
  close(): Promise<void>;
};

// A file the fleet refuses before its first byte (plan.md, "Client API"): the status for the node's error code.
const FILE_STATUS: Partial<Record<ErrorCode, number>> = { bad_args: 400, denied: 403, too_large: 413, node_offline: 503, timeout: 504, uncertain: 502, internal: 502 };

// `stickyLanes`: the fleet's sticky lane names (default ["manager"]), which GET /v1/caps lists (fleet-clients §4.6, §8).
export async function startFakeFleet(o: { nodes: FakeNode[]; api?: number[]; socketPath?: string; stickyLanes?: string[] }): Promise<FakeFleet> {
  const dir = o.socketPath === undefined ? mkdtempSync(join(tmpdir(), "mf-")) : null;
  const socketPath = o.socketPath ?? join(dir ?? "", "fleet.sock");
  const nodes = new Map(o.nodes.map(n => [n.name, n]));
  const status = new Map<string, NodeStatus>(o.nodes.map(n => [n.name, "online"]));
  const lastPanes = new Map<string, Pane[]>();
  const calls: FleetCall[] = [];
  const clients: string[] = [];
  const fileReads: string[] = [];
  const owners = new Map<string, string>();                 // lane name → the node that registered it first
  const intercepts = new Map<string, Intercept>();
  const subscribers = new Set<WebSocket>();
  let fileFault: FileFault | null = null;
  const alerts: Alert[] = [];
  const sticky = o.stickyLanes ?? ["manager"];
  const lastNodeOf = new Map<string, string>();             // a sticky name → the node that last had it (spec §4.6)

  const inventoryOf = async (name: string): Promise<{ panes: Pane[]; invVersion: number }> => {
    const n = nodes.get(name);
    if (!n) return { panes: [], invVersion: 0 };
    if (status.get(name) !== "online") return { panes: lastPanes.get(name) ?? [], invVersion: n.invVersion() };
    const inv = await n.inventory();
    lastPanes.set(name, inv.panes);
    return inv;
  };
  // The lane registry (spec §4, as Task 12's): one row per name, from every node's windows (the last ones known for a
  // node that isn't online). A name belongs to the first node that claimed it and stays its owner while it claims it; a
  // name two windows claim is in conflict, and its workerId is null when both are on the owner.
  async function lanes(): Promise<{ name: string; node: string; workerId: string | null; conflict: boolean }[]> {
    const claims = (await Promise.all([...nodes.keys()].map(async node =>
      (await inventoryOf(node)).panes.map(p => ({ name: p.window, node, workerId: p.workerId }))))).flat();
    const names = [...new Set(claims.map(c => c.name))].sort();
    for (const name of [...owners.keys()]) if (!names.includes(name)) owners.delete(name);
    return names.map(name => {
      const mine = claims.filter(c => c.name === name);
      const owner = mine.some(c => c.node === owners.get(name)) ? owners.get(name) ?? "" : mine[0]?.node ?? "";
      owners.set(name, owner);
      if (sticky.includes(name)) lastNodeOf.set(name, owner);
      const owned = mine.filter(c => c.node === owner);
      return { name, node: owner, workerId: owned.length === 1 ? owned[0]?.workerId ?? null : null, conflict: mine.length > 1 };
    });
  }
  // `store`: the node's store at the moment the request went out; null for the fleet's own refusals before that.
  // `storeSeq`: the node's store sequence once it answered (or an intercept answered for it), as the agent's own answer
  // and the fleet's own after sending both carry one; null when nothing was sent or the node sends none.
  async function op(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target: Record<string, string> = {};
    for (const k of ["workerId", "node", "lane"] as const) { const v = body[k]; if (typeof v === "string") target[k] = v; }
    let args = body.args;
    let name = target.node ?? (target.workerId !== undefined ? parseWorkerId(target.workerId)?.node : undefined) ?? null;
    let refused: Reply | null = null;
    if (target.lane !== undefined) {
      const lane = (await lanes()).find(l => l.name === target.lane);
      if (!lane) refused = refusal("no_pane", "no such lane");
      else if (lane.conflict || lane.workerId === null) refused = refusal("lane_conflict", "two windows claim this lane");
      else {
        name = lane.node;
        const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const owner = nodes.get(lane.node);
        if ((body.op === "pane.send" || body.op === "pane.keys") && a.expect === undefined && owner) {
          args = { ...a, workerId: a.workerId ?? lane.workerId, expect: { server: owner.server, window: lane.name } };
        }
      }
    }
    const call: FleetCall = {
      op: String(body.op), node: name, target, args,
      key: typeof body.key === "string" ? body.key : null, timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : null,
    };
    calls.push(call);
    if (refused) return { ...refused, store: null, storeSeq: null };
    const n = name === null ? undefined : nodes.get(name);
    if (!n || name === null) return { ...refusal("no_pane", "no such node"), store: null, storeSeq: null };
    if (status.get(name) !== "online") return { ...refusal("node_offline", "the node is not online"), store: null, storeSeq: null };
    const store = n.store;
    const next = () => n.handle(call.op, call.args, call.key);
    const f = intercepts.get(call.op);
    const reply = f ? await f(call, next) : await next();
    return { ...reply, invVersion: n.invVersion(), store, ...(n.storeSeq === null ? {} : { storeSeq: n.storeSeq }) };
  }

  // Deliveries (fleet-clients §4, §8; plan.md Contracts, "Client API routes"; reconciliation ruling 3): stored here, never
  // typed. A delivery to a sticky name whose window is gone goes to the node that last had it. A refusal is 200
  // { ok: false, error } (the client API's mapping for op refusals); an id the fleet doesn't know is 404 no_such_delivery.
  const deliveries = new Map<string, { delivery: Delivery; text: string }>();
  const deliveryCalls: { id: string; lane: string | null; workerId: string | null; text: string }[] = [];
  const cancels: string[] = [];
  const laneEvents: LaneEvent[] = [];
  let quiet = false;
  let lose = 0;
  let loseBy: "drop" | "hang" = "drop";
  let refuseDeliver = 0;
  let holdReads = false;
  let cancelDelayMs = 0;
  const deliveryReads: { id: string; at: number }[] = [];
  const stale = (d: Delivery) => status.get(d.node) !== "online";
  const deliveryEvent = (d: Delivery) => { if (!quiet) broadcast({ t: "delivery", node: d.node, body: { ...d, stale: stale(d) } }); };
  const refused = (code: ErrorCode, message: string = code) => ({ status: 200, body: { ok: false, error: { code, executed: ERROR_EXECUTED[code], message } } });
  const unknownDelivery = { status: 404, body: { error: "no_such_delivery" } };
  const withoutWaiting = (d: Delivery): Delivery => { const { waiting: _w, ...rest } = d; return rest; };
  // null: stored, and its answer is to be lost.
  async function deliver(b: Record<string, unknown>): Promise<{ status: number; body: unknown } | null> {
    const id = typeof b.id === "string" ? b.id : "";
    const text = typeof b.text === "string" ? b.text : "";
    const lane = typeof b.lane === "string" ? b.lane : null;
    const workerId = typeof b.workerId === "string" ? b.workerId : null;
    if (!/^[a-z]+:/.test(id) || id.length > LIMITS.maxDeliveryId || !text || text.length > LIMITS.maxSendText || (lane === null) === (workerId === null)) return refused("bad_args");
    deliveryCalls.push({ id, lane, workerId, text });
    if (refuseDeliver > 0) { refuseDeliver--; return refused("uncertain", "the fleet stopped while the delivery was in flight"); }
    const target = lane !== null ? { lane } : { workerId: workerId ?? "" };
    const known = deliveries.get(id);
    if (known) {
      const same = known.text === text && JSON.stringify(known.delivery.target) === JSON.stringify(target);
      return same ? { status: 200, body: { ok: true, delivery: known.delivery } } : refused("id_conflict", "this id names another delivery");
    }
    let node: string | null = null;
    if (lane !== null) {
      const row = (await lanes()).find(l => l.name === lane);
      if (row?.conflict) return refused("lane_conflict", "two windows claim this lane");
      node = row?.node ?? (sticky.includes(lane) ? lastNodeOf.get(lane) ?? null : null);
    } else node = parseWorkerId(workerId ?? "")?.node ?? null;
    if (node === null || !nodes.has(node)) return refused("no_pane", "no such lane");
    if (status.get(node) !== "online") return refused("node_offline", "the node is not online");
    const at = Date.now();
    const delivery: Delivery = { id, node, target, state: "queued", queuedAt: at, notAfter: at + (typeof b.ttlMs === "number" ? b.ttlMs : LIMITS.deliveryTtlMs) };
    deliveries.set(id, { delivery, text });
    deliveryEvent(delivery);
    if (lose > 0) { lose--; return null; }
    return { status: 200, body: { ok: true, delivery } };
  }
  function cancel(id: string): { status: number; body: unknown } {
    cancels.push(id);
    const d = deliveries.get(id);
    if (!d) return unknownDelivery;
    if (stale(d.delivery)) return refused("node_offline", "the node is not online");
    if (d.delivery.state !== "queued") return refused("already_typed", "it was typed already");
    d.delivery = { ...withoutWaiting(d.delivery), state: "given_up", why: "cancelled" };
    deliveryEvent(d.delivery);
    return { status: 200, body: { ok: true, delivery: d.delivery } };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fleet");
    clients.push(String(req.headers["x-morndo-client"] ?? ""));
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const body = async () => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    };
    if (req.method === "GET" && url.pathname === "/v1/caps") return json(200, { api: o.api ?? [CLIENT_API], stickyLanes: sticky });
    if (req.method === "POST" && url.pathname === "/v1/deliveries") {
      const r = await deliver(await body());
      // Stored, and the answer lost on its way: as a fleet that stops after it published the change (its event first).
      if (r === null) { if (loseBy === "drop") setTimeout(() => req.socket.destroy(), 50); return; }
      return json(r.status, r.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/deliveries") {
      const lane = url.searchParams.get("lane");
      const state = url.searchParams.get("state");
      const since = Date.now() - LIMITS.deliveryKeepMs;          // the newest 1000 of the last 7 days
      const all = [...deliveries.values()].map(d => d.delivery)
        .filter(d => d.queuedAt >= since && (lane === null || ("lane" in d.target && d.target.lane === lane)) && (state === null || d.state === state))
        .sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 1000).reverse();   // the newest 1000, oldest first, as the real fleet answers
      return json(200, { deliveries: all.map(d => ({ ...d, stale: stale(d) })) });
    }
    const one = /^\/v1\/deliveries\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (one && req.method === "GET" && one[2] === undefined) {
      deliveryReads.push({ id: decodeURIComponent(one[1] ?? ""), at: Date.now() });
      if (holdReads) return;                                // no answer: the client's own timeout ends it
      const d = deliveries.get(decodeURIComponent(one[1] ?? ""));
      return d ? json(200, { delivery: d.delivery, stale: stale(d.delivery) }) : json(unknownDelivery.status, unknownDelivery.body);
    }
    if (one && req.method === "POST" && one[2] !== undefined) {
      if (cancelDelayMs > 0) await new Promise(r => setTimeout(r, cancelDelayMs));
      const r = cancel(decodeURIComponent(one[1] ?? ""));
      return json(r.status, r.body);
    }
    if (req.method === "GET" && url.pathname === "/v1/lane-events") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json(200, { events: laneEvents.filter(e => e.seq > since).slice(0, 1000) });
    }
    if (req.method === "GET" && url.pathname === "/v1/nodes") {
      return json(200, [...nodes.keys()].map(name => ({ name, status: status.get(name) ?? "offline", health: null, agent: "fake" })));
    }
    if (req.method === "GET" && url.pathname === "/v1/lanes") return json(200, await lanes());
    if (req.method === "GET" && url.pathname === "/v1/alerts") return json(200, alerts);
    if (req.method === "POST" && url.pathname === "/v1/op") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return json(200, await op(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
    }
    const file = /^\/v1\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && file) {
      const name = decodeURIComponent(file[1] ?? "");
      const path = decodeURIComponent(file[2] ?? "");
      fileReads.push(`${name}:${path}`);
      const refuse = (r: Reply) => json(r.ok ? 500 : FILE_STATUS[r.error.code] ?? 404, r);
      const n = nodes.get(name);
      if (!n || status.get(name) !== "online") return refuse(refusal("node_offline"));
      const bytes = await n.file(path);
      if (!bytes) return refuse(refusal("denied", "not readable"));
      // As the real route (files-route.ts): a chunked body with `x-file-size`, never a content-length. A fault is a
      // non-conforming fleet, or one whose file.get failed mid-stream (the real route destroys the response then).
      const headers: Record<string, string> = { "content-type": "application/octet-stream" };
      if (fileFault !== "no-size") headers["x-file-size"] = fileFault === "bad-size" ? "lots" : String(fileFault === "truncate" ? bytes.length + 1000 : bytes.length);
      res.writeHead(200, headers);
      const body = fileFault === "overrun" ? Buffer.concat([bytes, Buffer.alloc(1000, 120)]) : bytes;
      const stopAt = fileFault === "abort" ? Math.floor(bytes.length / 2) : body.length;
      for (let i = 0; i < stopAt; i += 65_536) res.write(body.subarray(i, Math.min(i + 65_536, stopAt)));
      if (fileFault === "abort") { setTimeout(() => res.destroy(new Error("file.get failed")), 20); return; }
      return res.end();
    }
    return json(404, { error: "no such route" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  const wss = new WebSocketServer({ noServer: true });
  const send = (ws: WebSocket, e: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  const broadcast = (e: unknown) => { for (const ws of subscribers) send(ws, e); };
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://fleet").pathname !== "/v1/events") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      subscribers.add(ws);
      ws.on("close", () => subscribers.delete(ws));
      ws.on("error", () => {});
      // State first, as the fleet does (spec §5.4, ADR-0012 "State over events"): every node's status, every online
      // node's inventory.
      void (async () => {
        try {
          for (const name of nodes.keys()) {
            send(ws, { t: "status", node: name, body: { status: status.get(name) } });
            if (status.get(name) === "online") send(ws, { t: "inventory", node: name, body: await inventoryOf(name) });
          }
        } catch { /* a node's backend failed: the test sees it elsewhere */ }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });

  return {
    socketPath, calls, clients, fileReads,
    node(name) {
      const n = nodes.get(name);
      if (!n) throw new Error(`no node ${name}`);
      return n;
    },
    async setStatus(name, s) {
      status.set(name, s);
      broadcast({ t: "status", node: name, body: { status: s } });
      if (s === "online") broadcast({ t: "inventory", node: name, body: await inventoryOf(name) });
    },
    revoke(name) {
      broadcast({ t: "status", node: name, body: { status: "offline" } });
      nodes.delete(name);
      status.delete(name);
      lastPanes.delete(name);
    },
    fileFault(mode) { fileFault = mode; },
    dropEvents(code) { for (const ws of [...subscribers]) ws.close(code); },
    async announce(name) { broadcast({ t: "inventory", node: name, body: await inventoryOf(name) }); },
    raise(alert) { alerts.push(alert); broadcast({ t: "alert", node: alert.node ?? "", body: alert }); },
    intercept(opName, f) { if (f) intercepts.set(opName, f); else intercepts.delete(opName); },
    deliveries, deliveryCalls, cancels,
    moveDelivery(id, change) {
      const d = deliveries.get(id);
      if (!d) throw new Error(`no delivery ${id}`);
      const moved = { ...d.delivery, ...change };
      d.delivery = change.state !== undefined && change.state !== "queued" && change.waiting === undefined ? withoutWaiting(moved) : moved;
      deliveryEvent(d.delivery);
      return d.delivery;
    },
    quietDeliveries(q) { quiet = q; },
    loseDeliveryAnswers(n, how = "drop") { lose = n; loseBy = how; },
    refuseDeliveries(n) { refuseDeliver = n; },
    holdDeliveryReads(hold) { holdReads = hold; },
    delayCancels(ms) { cancelDelayMs = ms; },
    deliveryReads,
    laneEvent(e) { laneEvents.push(e); broadcast({ t: "lane", node: e.node, body: e }); },
    subscriberCount: () => subscribers.size,
    async close() {
      for (const ws of subscribers) ws.terminate();
      wss.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      else rmSync(socketPath, { force: true });
    },
  };
}
