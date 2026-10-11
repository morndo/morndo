// The hub's ports over the fleet service (ADR-0012; docs/design/fleet-core/README.md §3.1, §4, §5).
// - The view: every node's status and panes, kept by the fleet's events and checked again on each poll; the roster is
//   every node's panes (two windows of one name are both listed), and the lane registry says which names are in conflict.
// - The ports: each one is typed ops through the FleetClient.
// - Worker ids are `<node>.<server>.<pane>` (packages/protocol worker-id.ts). An id that isn't one, a legacy `%N` among
//   them, is no pane here.
// - Keys are the caller's, namespaced "hub:" (spec §5.3, "Keys are namespaced by client").
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Frame, SendProblem, SessionInfo } from "@morndo/node-ops";
import { JobViewSchema, LIMITS, SEND_PROBLEMS, parseWorkerId, type Expect, type JobView, type OpArgs, type OpResult, type Pane } from "@morndo/protocol";
import { NoticeOutbox, type NoticeDelivery } from "../application/job-notice-outbox.ts";
import { JobResync } from "../application/job-resync.ts";
import {
  SEND_REFUSALS, SendInDoubt, SourceUnavailable,
  type HubPorts, type NodeStates, type RemoteFiles, type SendOutcome, type SendRefused, type SendStatus, type Sessions, type Terminal, type Tmux, type TranscriptSource, type UploadSink,
} from "../application/ports.ts";
import { FleetOpFailed, FleetUnavailable, type FleetClient, type FleetEvent, type FleetLane, type NodeStatus, type OpAnswer } from "./fleet-client.ts";
import { log } from "./log.ts";
import { stagedUploadName } from "./uploads.ts";
import { perKeyLimit } from "./per-key-limit.ts";

export type FleetTimeouts = { listMs: number; captureMs: number; sendMs: number; keysMs: number; frameMs: number; statusMs: number; transcriptMs: number; fileMs: number };
// What each op may take before the fleet answers `timeout` itself (spec §5.3, deadlines; counted from when the fleet
// queued it). A poll waits at most captureMs for a node's screens, so one slow node never holds the others for longer
// than that (spec §3.1). listMs is a background inventory refresh's: a listing waits for it at most
// LIMITS.inventoryWaitMs (300 ms), and its answer is applied whenever it lands.
export const FLEET_TIMEOUTS: FleetTimeouts = {
  listMs: 2000, captureMs: 1200, sendMs: 10_000, keysMs: 3000, frameMs: 3000, statusMs: 3000, transcriptMs: 5000, fileMs: 10_000,
};

// The hub's own store of file copies (files.ts): it hashes a file at a path, keeps it and serves it by id.
export type LocalFileStore = {
  register(path: string, origin?: { key: string; mtimeMs: number }): { id: string | null; size: number | null } | Promise<{ id: string | null; size: number | null }>;
  known?(key: string): { id: string; size: number; mtimeMs: number } | null;
};

export type FleetPorts = HubPorts & {
  sessions: Sessions; transcripts: TranscriptSource; sendStatus: SendStatus; nodeStates: NodeStates;
  nodeStatus(node: string): NodeStatus | null;              // null: not heard of yet
  conflicted(name: string): boolean;                        // the view's word on a lane name: the registry's, kept current by conflict events
  start(): Promise<void>;                                   // subscribe to the events, and a first look at the nodes
  stop(): void;
};

type Copy = { id: string | null; size: number | null };
const NO_COPY: Copy = { id: null, size: null };
const COPIES_KEPT = 5000;
const COPIES_PER_NODE = 4;                                      // under the fleet's bulk queue (1 running + 8 waiting, spec §5.2), leaving room for transcript reads
const hubKey = (key: string) => `hub:${key}`;
// Refusals the agent answers before anything reached the pane (executed "no", the key released): a retry may type.
const BEFORE_PASTE = new Set<string>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy"] satisfies SendProblem[]);
const SEND_PROBLEMS_SET = new Set<string>(SEND_PROBLEMS);
const REFUSED = new Set<string>(SEND_REFUSALS);
const STATUSES = new Set<string>(["online", "stale", "offline"]);
// A node that can't answer now: its transcript is SourceUnavailable, not gone (spec §3.1).
const NOT_NOW = new Set<string>(["node_offline", "timeout", "busy", "uncertain", "internal"]);
// `p`, waited for at most `ms`; whatever it comes to (late, failed) is left to it.
const within = (p: Promise<unknown>, ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  p.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown) => v === undefined || typeof v === "string";
const isPane = (v: unknown): v is Pane =>
  isRecord(v) && typeof v.workerId === "string" && typeof v.window === "string" && typeof v.cwd === "string"
  && optional(v.sessionId) && optional(v.sessionName) && optional(v.title) && optional(v.claudeVersion);
const isFrame = (v: unknown): v is Frame =>
  isRecord(v) && [v.cols, v.rows, v.x, v.y].every(n => typeof n === "number") && typeof v.cursor === "boolean"
  && Array.isArray(v.lines) && v.lines.every(l => typeof l === "string");

// What the hub knows of the nodes: each one's status, its panes from its latest full inventory, and the lane registry's
// rows (one per name, `conflict` while two windows claim it).
class NodeView {
  #status = new Map<string, NodeStatus>();
  #panes = new Map<string, Map<string, Pane>>();            // node → worker id → its pane
  #lanes: FleetLane[] = [];
  #conflicted = new Set<string>();                          // lane names in conflict
  #inventoryEvents = new Map<string, number>();             // node → inventory events applied: an answer asked before one may be older

  status(node: string): NodeStatus | null { return this.#status.get(node) ?? null; }
  states(): ReadonlyMap<string, NodeStatus> { return new Map(this.#status); }
  setStatus(node: string, status: NodeStatus) { this.#status.set(node, status); }
  // Only the nodes the fleet lists now (GET /v1/nodes: every registered node, a revoked one never): what was known of any
  // other goes, so a revoked node's workers are never listed and nothing is routed to them (FL4).
  retain(names: ReadonlySet<string>) {
    for (const node of [...this.#status.keys()]) if (!names.has(node)) this.#status.delete(node);
    for (const node of [...this.#panes.keys()]) if (!names.has(node)) this.#panes.delete(node);
  }
  has(node: string) { return this.#panes.has(node); }
  inventoryEvents(node: string): number { return this.#inventoryEvents.get(node) ?? 0; }
  // A full inventory replaces what was known of the node; a pane of another node in it is never taken.
  setPanes(node: string, panes: unknown) {
    if (!Array.isArray(panes)) return;
    const known = new Map<string, Pane>();
    for (const p of panes) if (isPane(p) && parseWorkerId(p.workerId)?.node === node) known.set(p.workerId, p);
    this.#panes.set(node, known);
  }
  pane(workerId: string): Pane | null {
    const ref = parseWorkerId(workerId);
    return ref ? this.#panes.get(ref.node)?.get(workerId) ?? null : null;
  }
  all(): Pane[] { return [...this.#panes.values()].flatMap(m => [...m.values()]); }
  setLanes(lanes: FleetLane[]) { this.#lanes = lanes; this.#conflicted = new Set(lanes.filter(l => l.conflict).map(l => l.name)); }
  lanes(): FleetLane[] { return this.#lanes; }
  conflicted(name: string) { return this.#conflicted.has(name); }
  nodeOfSession(sessionId: string): string | null {
    for (const [node, panes] of this.#panes) for (const p of panes.values()) if (p.sessionId === sessionId) return node;
    return null;
  }
  apply(e: FleetEvent) {
    if (e.t === "status" && isRecord(e.body) && typeof e.body.status === "string" && STATUSES.has(e.body.status)) this.setStatus(e.node, e.body.status as NodeStatus);
    else if (e.t === "inventory" && isRecord(e.body)) { this.#inventoryEvents.set(e.node, this.inventoryEvents(e.node) + 1); this.setPanes(e.node, e.body.panes); }
    else if (e.t === "conflict" && isRecord(e.body) && typeof e.body.name === "string" && Array.isArray(e.body.nodes)) {
      if (e.body.nodes.length) this.#conflicted.add(e.body.name); else this.#conflicted.delete(e.body.name);
    }
  }
}

export type JobSink = {
  replace(list: { jobs: JobView[]; stale: boolean }): void;
  merge(list: { jobs: JobView[]; stale: boolean }, seen: readonly JobView[]): void;
  apply(raw: unknown, quiet?: boolean): void;
  reportNotice(fn: (job: JobView, notice: "commented" | "given_up") => void): void;
  unackedNotices(): NoticeDelivery[];
  ackNotice(node: string, id: string): void;
};

export function fleetPorts(client: FleetClient, o: { files: LocalFileStore | null; stagingDir: string; timeouts?: Partial<FleetTimeouts>; jobs?: JobSink }): FleetPorts {
  const t: FleetTimeouts = { ...FLEET_TIMEOUTS, ...o.timeouts };
  const view = new NodeView();
  let unsubscribe = () => {};
  let noticeTimer: ReturnType<typeof setInterval> | null = null;

  // A node's inventory asked for again, one refresh per node at a time. Its answer is applied when it lands, whether or
  // not anyone still waits for it.
  const refreshing = new Map<string, Promise<void>>();
  function refreshInventory(node: string): Promise<void> {
    let p = refreshing.get(node);
    if (!p) {
      const asked = view.inventoryEvents(node);
      p = client.op({ node }, "inventory.get", {}, { timeoutMs: t.listMs }).then(r => {
        // Inventory is latest-wins (spec §5.4). The answer and the node's events come over two sockets, so an event that
        // landed while this was asked may be newer than the answer, which would roll the view back (an old session, so
        // sends refused no_pane). Such an answer is dropped: the agent sends any read newer than its last event within its
        // 2 s poll (node-agent events.ts), so nothing newer is lost for longer than that.
        if (r.ok) { if (view.inventoryEvents(node) === asked) view.setPanes(node, r.result.panes); view.setStatus(node, "online"); }
        else if (r.error.code === "node_offline") view.setStatus(node, "offline");
      }).finally(() => { refreshing.delete(node); });
      refreshing.set(node, p);
    }
    return p;
  }
  // The pane a worker id names, from its node's latest inventory; asked of the node once when it isn't there yet.
  async function paneOf(workerId: string): Promise<Pane | null> {
    const ref = parseWorkerId(workerId);
    if (!ref) return null;
    const known = view.pane(workerId);
    if (known) return known;
    await refreshInventory(ref.node);
    return view.pane(workerId);
  }
  // A pane whose send its node refused no_pane, asked of the node anew (after any refresh already under way, which may
  // predate the refusal): the same pane under another Claude Code session since the hub's inventory (a /clear, /resume
  // or a restart in it starts one), or null: gone, renamed, the same session, or the node can't be asked now.
  async function sameWindowNewSession(workerId: string, sent: Pane): Promise<Pane | null> {
    const node = parseWorkerId(workerId)?.node;
    if (node === undefined) return null;
    try { await refreshing.get(node)?.catch(() => {}); await refreshInventory(node); } catch { return null; }
    const now = view.pane(workerId);
    return now && now.window === sent.window && now.sessionId !== sent.sessionId ? now : null;
  }
  // Polling skips a node the fleet doesn't call online, at once (spec §3.1); a node not heard of yet is asked.
  const polled = (node: string) => { const s = view.status(node); return s === null || s === "online"; };

  const tmux: Tmux = {
    // Every window of every node, from each node's inventory, with its node (spec §4): two windows of one name are both
    // listed, and `conflict` is the lane registry's word on that name. An inventory that is missing, or behind the registry
    // (a new pane, a renamed or closed window), is asked for again, every node at once; the listing waits for each at
    // most LIMITS.inventoryWaitMs, and a slower answer is applied when it lands, so a slow or hung node never holds the
    // listing (spec §3.1). A node the hub has no inventory of (offline since the hub started) is listed from the
    // registry's rows, offline.
    async listWorkers() {
      const [lanes, nodes] = await Promise.all([client.lanes(), client.nodes()]);
      view.retain(new Set(nodes.map(n => n.name)));
      for (const n of nodes) view.setStatus(n.name, n.status);
      view.setLanes(lanes);
      const names = new Set(lanes.map(l => l.name));
      const behind = new Set<string>();
      for (const n of nodes) if (n.status === "online" && !view.has(n.name)) behind.add(n.name);
      for (const l of lanes) {
        if (l.workerId === null || view.status(l.node) !== "online") continue;
        if (view.pane(l.workerId)?.window !== l.name) behind.add(l.node);
      }
      for (const p of view.all()) {
        const node = parseWorkerId(p.workerId)?.node ?? "";
        if (view.status(node) === "online" && !names.has(p.window)) behind.add(node);
      }
      await Promise.all([...behind].map(node => within(refreshInventory(node), LIMITS.inventoryWaitMs)));
      const worker = (id: string, name: string, cwd: string, node: string) => ({
        id, name, location: basename(cwd) || cwd, node, offline: view.status(node) !== "online", conflict: view.conflicted(name),
      });
      const listed = view.all().map(p => worker(p.workerId, p.window, p.cwd, parseWorkerId(p.workerId)?.node ?? ""));
      for (const l of lanes) {
        if (l.workerId !== null && !view.has(l.node) && parseWorkerId(l.workerId)?.node === l.node) listed.push(worker(l.workerId, l.name, "", l.node));
      }
      return listed;
    },
    async capture(id) { return (await tmux.captureMany([id])).get(id) ?? null; },
    async captureMany(ids) {
      const out = new Map<string, string | null>(ids.map(id => [id, null]));
      const byNode = new Map<string, string[]>();
      for (const id of ids) {
        const node = parseWorkerId(id)?.node;
        if (node !== undefined) byNode.set(node, [...(byNode.get(node) ?? []), id]);
      }
      await Promise.allSettled([...byNode].map(async ([node, list]) => {
        if (!polled(node)) return;
        for (let i = 0; i < list.length; i += LIMITS.captureManyMax) {
          const r = await client.op({ node }, "pane.captureMany", { workerIds: list.slice(i, i + LIMITS.captureManyMax) }, { timeoutMs: t.captureMs });
          if (!r.ok) { if (r.error.code === "node_offline") view.setStatus(node, "offline"); return; }
          for (const c of r.result.captures) if (out.has(c.workerId)) out.set(c.workerId, typeof c.text === "string" ? c.text : null);
        }
      }));
      return out;
    },
    async send(id, text, key) {
      const refused = (problem: SendOutcome["problem"]): SendOutcome => ({ problem, typedAt: 0 });
      const ref = parseWorkerId(id);
      if (!ref) return refused("no_pane");
      let pane: Pane | null;
      try { pane = await paneOf(id); }
      catch (e) { if (e instanceof FleetUnavailable) return refused("node_offline"); throw e; }   // nothing was sent yet
      if (!pane) { const s = view.status(ref.node); return refused(s === "offline" || s === "stale" ? "node_offline" : "no_pane"); }
      const expectOf = (p: Pane): Expect => ({ server: ref.server, window: p.window, ...(p.sessionId !== undefined ? { sessionId: p.sessionId } : {}) });
      const sendTo = (p: Pane) => client.op({ workerId: id }, "pane.send", { workerId: id, text, expect: expectOf(p) }, { key: hubKey(key), timeoutMs: t.sendMs });
      let r: OpAnswer<"pane.send">;
      try {
        r = await sendTo(pane);
        // The node checks the session against Claude Code's live registry, and the hub's comes from its last inventory: a
        // /clear starts a new session in the same pane (Claude Code's SessionStart "clear"), so a refusal right after one
        // is the hub's view behind, not another lane. Once, with the node's inventory now, and only while the server and
        // the window still match: the same key, since a retry with a refreshed expectation is the same request (spec §5.3).
        if (!r.ok && r.error.code === "no_pane" && pane.sessionId !== undefined) {
          const now = await sameWindowNewSession(id, pane);
          if (now) r = await sendTo(now);
        }
      }
      catch (e) {
        if (e instanceof FleetUnavailable && !e.reached) return refused("node_offline");
        // The fleet took it and never answered: it may be in the pane, and no store said so.
        if (e instanceof FleetUnavailable) throw new SendInDoubt(null, `pane.send to ${id}: ${e.message}`, { cause: e });
        throw e;
      }
      // The store it went to and that store's sequence go with every outcome: a send in doubt keeps both (spec §3.1;
      // final review I2).
      const wentTo = { store: r.store, storeSeq: r.storeSeq };
      if (r.ok) {
        const { problem, typedAt } = r.result;
        if ((problem === null || SEND_PROBLEMS_SET.has(problem)) && typeof typedAt === "number") return { problem, typedAt, ...wentTo };
        throw new SendInDoubt(r.store, "pane.send: an answer this hub doesn't know", { storeSeq: r.storeSeq });
      }
      const e = r.error;
      // It may be in the pane: the caller keeps it in doubt, with the store it went to (spec §3.1). A code that is itself
      // "uncertain" is in doubt whatever its executed says.
      if (e.executed === "maybe" || e.code === "uncertain") throw new SendInDoubt(r.store, `pane.send: ${e.code}: ${e.message}`, { storeSeq: r.storeSeq });
      if (BEFORE_PASTE.has(e.code)) return refused(e.code as SendProblem);
      if (e.code === "node_offline") { view.setStatus(ref.node, "offline"); return refused("node_offline"); }
      if (e.code === "timeout") return refused("busy");                     // the deadline came before typing began
      // Any other error says nothing ran (executed "no": denied, bad_args, too_large, an agent's internal before the side
      // effect): a refusal the caller sees and releases its row for, never a throw that leaves the send in doubt for ever
      // (final review M1, widened by ruling: ADR-0012 decision 7).
      if (REFUSED.has(e.code)) return refused(e.code as SendRefused);
      throw new FleetOpFailed("pane.send", e);                              // unreached: every error code is mapped above
    },
  };

  const terminal: Terminal = {
    // A pane gone (no_pane, or the node's own null) is null, which closes the view. A frame its node can't give now (a
    // timeout, the node offline or busy, the fleet unreachable) is "unavailable": the view stays open and asks again on
    // its next tick (final review M5; before, any failure closed it as "pane gone"). Any other refusal is thrown.
    async frame(id) {
      if (!parseWorkerId(id)) return null;
      let r: OpAnswer<"pane.frame">;
      try { r = await client.op({ workerId: id }, "pane.frame", { workerId: id }, { timeoutMs: t.frameMs }); }
      catch (e) { if (e instanceof FleetUnavailable) return "unavailable"; throw e; }
      if (r.ok) return isFrame(r.result.frame) ? r.result.frame : null;
      if (r.error.code === "no_pane") return null;
      if (NOT_NOW.has(r.error.code)) return "unavailable";
      throw new FleetOpFailed("pane.frame", r.error);
    },
    // Keystrokes are never retried (no key): an answer that may have come after they were typed ("maybe", or the fleet
    // took them and never answered) is "uncertain", which the app shows as "may have been typed", never as refused.
    async keys(id, data) {
      const ref = parseWorkerId(id);
      if (!ref || !data || data.length > LIMITS.maxKeys) return false;
      let pane: Pane | null;
      try { pane = await paneOf(id); } catch { return false; }                    // nothing was sent yet
      if (!pane) return false;
      // No session in the expectation: keys are typed watching the screen, and a /clear typed a moment ago starts a new one.
      let r: OpAnswer<"pane.keys">;
      try { r = await client.op({ workerId: id }, "pane.keys", { workerId: id, data, expect: { server: ref.server, window: pane.window } }, { timeoutMs: t.keysMs }); }
      catch (e) { if (e instanceof FleetUnavailable) return e.reached ? "uncertain" : false; throw e; }
      if (r.ok) return r.result.ok === true;
      return r.error.executed === "maybe" ? "uncertain" : false;
    },
  };

  const sessions: Sessions = {
    async byPane() {
      const out = new Map<string, SessionInfo>();
      for (const p of view.all()) {
        if (p.sessionId === undefined) continue;
        // The session's name from Claude Code's registry, as legacy shows it: never the pane's terminal title ("✳ <task>").
        out.set(p.workerId, { sessionId: p.sessionId, name: p.sessionName ?? null, pane: p.workerId, cwd: p.cwd, version: p.claudeVersion ?? null, pid: 0 });
      }
      return out;
    },
  };

  // A transcript lives on the node whose pane runs its session. null: no such transcript (gone). A node that can't answer
  // now (offline, slow, the fleet down) is SourceUnavailable: the hub's follow keeps its place, and the next poll asks
  // again (spec §3.1).
  async function transcriptOp<O extends "transcript.size" | "transcript.read" | "transcript.locate">(node: string, op: O, args: OpArgs[O]): Promise<OpResult[O] | null> {
    let r: OpAnswer<O>;
    try { r = await client.op({ node }, op, args, { timeoutMs: t.transcriptMs }); }
    catch (e) { if (e instanceof FleetUnavailable) throw new SourceUnavailable(`${op} on ${node}: ${e.message}`, { cause: e }); throw e; }
    if (r.ok) return r.result;
    if (NOT_NOW.has(r.error.code)) throw new SourceUnavailable(`${op} on ${node}: ${r.error.code}`);
    return null;                                                 // refused (bad_args, denied, no_pane): nothing to read
  }
  const transcripts: TranscriptSource = {
    async size(sessionId) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      const r = await transcriptOp(node, "transcript.size", { sessionId });
      return r && typeof r.size === "number" ? r.size : null;
    },
    async read(sessionId, offset, max) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      // At most one chunk per op (spec §5.2): a caller asking for more gets a short read and asks again from there.
      const r = await transcriptOp(node, "transcript.read", { sessionId, offset, max: Math.min(max, LIMITS.chunkBytes) });
      if (!r || typeof r.bytes !== "string") return null;
      return { bytes: Buffer.from(r.bytes, "base64"), eof: r.eof === true };
    },
    async locate(sessionId, needle) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      const r = await transcriptOp(node, "transcript.locate", { sessionId, needle });
      return r && typeof r.offset === "number" ? r.offset : null;
    },
  };

  // A file a worker's message names, copied from its node into the hub's own store (files.ts).
  // 1. Ask for its size and time first, so an unchanged file isn't copied again.
  // 2. Stream it in chunks (GET /v1/files) into a staging file named as the original.
  // 3. Hand the staging file to the store, which hashes it, keeps it and serves it by id; then delete the staging file.
  // The node applies today's rules before anything is read (spec §5.3: symlinks resolved, deny roots, secret names, 25 MiB).
  mkdirSync(o.stagingDir, { recursive: true, mode: 0o700 });
  const copies = new Map<string, { size: number; mtime: number; copy: Copy }>();   // node and path → its last copy
  const copying = new Map<string, Promise<Copy>>();
  async function copyFrom(node: string, path: string): Promise<Copy> {
    const k = `${node}\0${path}`;
    const stored = o.files?.known?.(`fleet:${k}`);
    const known = copies.get(k) ?? (stored ? { size: stored.size, mtime: stored.mtimeMs, copy: { id: stored.id, size: stored.size } } : undefined);
    try {
      const st = await client.op({ node }, "file.stat", { path }, { timeoutMs: t.fileMs });
      if (!st.ok) return known?.copy ?? NO_COPY;                 // gone, refused or offline: the copy, if any (as files.ts)
      const { size, mtime } = st.result;
      if (size > LIMITS.maxFileBytes) return { id: null, size };
      if (known && known.size === size && known.mtime === mtime) return known.copy;
      if (!o.files) return NO_COPY;
      const dir = join(o.stagingDir, createHash("sha256").update(k).digest("hex").slice(0, 32));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const staged = join(dir, basename(path));
        const fh = await open(staged, "w", 0o600);
        let total = 0;
        try {
          for await (const chunk of client.fileStream(node, path)) {
            total += chunk.length;
            if (total > LIMITS.maxFileBytes) return { id: null, size: total };      // it grew past the cap while copied
            await fh.write(chunk);
          }
        } finally { await fh.close(); }
        const copy = await o.files.register(staged, { key: `fleet:${k}`, mtimeMs: mtime });
        copies.set(k, { size, mtime, copy });
        while (copies.size > COPIES_KEPT) copies.delete(copies.keys().next().value as string);
        return copy;
      } finally { await rm(dir, { recursive: true, force: true }); }
    } catch (e) {
      log.warn(`a file from ${node} was not copied: ${(e as Error).message}`);
      return known?.copy ?? NO_COPY;
    }
  }
  const oneAtATime = perKeyLimit(COPIES_PER_NODE);
  const files: RemoteFiles = {
    register(workerId, path) {
      const node = parseWorkerId(workerId)?.node;
      if (node === undefined) return Promise.resolve(NO_COPY);
      const k = `${node}\0${path}`;
      const running = copying.get(k);
      if (running) return running;
      const p = oneAtATime(node, () => copyFrom(node, path)).finally(() => copying.delete(k));
      copying.set(k, p);
      return p;
    },
  };

  // An image the principal attached, put on the node of the worker it goes to (spec §3.1, Uploads), in chunks of at most
  // 256 KiB, each keyed `upload:<id>:<chunk>`. A chunk asked again after a lost answer gets the node's stored outcome.
  type ChunkResult = { ok: true; path: string | null } | { ok: false; problem: "no_pane" | "too_large" | "node_offline" | "not_allowed"; restart?: true };
  async function putChunk(node: string, args: OpArgs["file.put"], key: string): Promise<ChunkResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r: OpAnswer<"file.put">;
      try { r = await client.op({ node }, "file.put", args, { key, timeoutMs: t.fileMs }); }
      catch { continue; }                                       // the fleet didn't answer: the same key again
      if (r.ok) return { ok: true, path: typeof r.result.path === "string" ? r.result.path : null };
      if (r.error.code === "node_offline" || r.error.code === "too_large" || r.error.code === "not_allowed") return { ok: false, problem: r.error.code };
      if (r.error.executed === "maybe") continue;
      log.warn(`an image for ${node} was refused: ${r.error.code}`);
      return { ok: false, problem: "no_pane", ...(r.error.code === "bad_args" ? { restart: true as const } : {}) };
    }
    return { ok: false, problem: "node_offline" };
  }
  // A transfer is named by the upload's id. When the node refuses a chunk for its offset (its partial expired while the
  // chunk keys it answers from are still kept, spec §5.3), the whole image goes again under a new name, so new keys
  // and a new partial; at most twice. The first name is the upload's own, so a finished upload still answers from its keys.
  const uploads: UploadSink = {
    async stage(upload, workerId) {
      const node = parseWorkerId(workerId)?.node;
      if (node === undefined) return { ok: false, problem: "no_pane" };
      let bytes: Buffer;
      try { bytes = await readFile(upload.path); }
      catch { log.warn("an attached image is gone from the hub's inbox"); return { ok: false, problem: "no_pane" }; }
      if (bytes.length > LIMITS.maxFileBytes) return { ok: false, problem: "too_large" };
      const chunks = Math.max(1, Math.ceil(bytes.length / LIMITS.chunkBytes));
      let last: ChunkResult = { ok: false, problem: "no_pane" };
      for (let generation = 0; generation <= 2; generation++) {
        const transfer = generation === 0 ? upload.id : `${upload.id}r${generation}`;
        let restart = false;
        for (let i = 0; i < chunks; i++) {
          const offset = i * LIMITS.chunkBytes;
          const final = i === chunks - 1;
          const part = bytes.subarray(offset, offset + LIMITS.chunkBytes).toString("base64");
          const r = await putChunk(node, { upload: transfer, offset, bytes: part, final, name: stagedUploadName(upload.path) }, hubKey(`upload:${transfer}:${i}`));
          if (!r.ok) { last = r; restart = r.restart === true; break; }
          if (final) return r.path === null ? { ok: false, problem: "no_pane" } : { ok: true, path: r.path };
        }
        if (!restart) break;
      }
      return last.ok ? { ok: false, problem: "no_pane" } : { ok: false, problem: last.problem };
    },
  };

  // What the node knows of a key (spec §3.1, "Uncertain becomes resolvable"). op.status answers a done key with the op's
  // stored result, for pane.send `{ problem, typedAt }` (plan.md, "Behaviour the agent and the fleet agree on").
  // - "done" only for a send that was typed and submitted, with the node's own typedAt.
  // - One the node recorded with a problem (pasted, not submitted) stays in doubt ("started"), as a local "started" row does.
  // - "unknown" with the store that answered and its sequence now: the caller compares them with the store its send went
  //   to and the sequence kept with it.
  // - Not a node's worker id (a legacy %N row), or a node that can't be asked: "offline".
  const sendStatus: SendStatus = async (id, key) => {
    const node = parseWorkerId(id)?.node;
    if (node === undefined) return { state: "offline" };
    let r: OpAnswer<"op.status">;
    try { r = await client.op({ node }, "op.status", { key: hubKey(key) }, { timeoutMs: t.statusMs }); }
    catch { return { state: "offline" }; }
    if (!r.ok) return { state: "offline" };
    const { state, outcome } = r.result;
    if (state === "done") {
      return isRecord(outcome) && outcome.problem === null && typeof outcome.typedAt === "number" ? { state: "done", typedAt: outcome.typedAt } : { state: "started" };
    }
    if (state === "unknown") return { state: "unknown", store: r.store, storeSeq: r.storeSeq };
    return state === "started" ? { state } : { state: "offline" };
  };
  // Which nodes answer now, as the view knows them (the fleet's status events, and each poll's GET /v1/nodes).
  const nodeStates: NodeStates = async () => view.states();

  return {
    tmux, terminal, sessions, transcripts, files, uploads, sendStatus, nodeStates,
    nodeStatus: node => view.status(node),
    conflicted: name => view.conflicted(name),
    async start() {
      // The fleet replays only status, inventory and health on a new subscription: an `alert` or `conflict` event sent
      // while the hub was disconnected (a 1013 backpressure close, say) is not replayed. So every open, the first and each
      // reconnect, reads the nodes and the lane registry again. A failed read is logged; the next poll asks again.
      // Events that land while GET /v1/jobs is in flight. The answer and the socket are two channels, so the answer can
      // be older than an event already applied. The merge keeps the newer row per job. One read at a time: a second
      // connect waits, and each read has its own buffer, so one's finish cannot drop the events of the other.
      const noticeOutbox = new NoticeOutbox();
      const drainNotices = () => {
        const pending = o.jobs?.unackedNotices() ?? [];
        void noticeOutbox.deliver(pending, async row => {
          try {
            const answered = await client.op({ node: row.node }, "job.noticeResult", { id: row.id, notice: row.notice });
            return answered.ok;
          } catch (e) {
            log.warn(`fleet: reporting a job notice failed (${(e as Error).message})`);
            return false;
          }
        }, row => o.jobs?.ackNotice(row.node, row.id));
      };
      o.jobs?.reportNotice(() => { drainNotices(); });
      drainNotices();
      noticeTimer = setInterval(drainNotices, 60_000);
      noticeTimer.unref?.();
      const jobsSync = new JobResync<JobView>();
      const resync = () => jobsSync.run(async () => {
        try { const nodes = await client.nodes(); view.retain(new Set(nodes.map(n => n.name))); for (const n of nodes) view.setStatus(n.name, n.status); }
        catch (e) { log.warn(`fleet: reading the nodes failed (${(e as Error).message}); each poll asks again`); }
        try { view.setLanes(await client.lanes()); }
        catch (e) { log.warn(`fleet: reading the lanes failed (${(e as Error).message}); each poll asks again`); }
        if (!o.jobs) return null;
        try { return await client.jobs(); }
        catch (e) { log.warn(`fleet: reading the jobs failed (${(e as Error).message}); the next connect asks again`); return null; }
      }, (list, seen) => { if (list && o.jobs) o.jobs.merge(list, seen); });
      unsubscribe = client.events(e => {
        view.apply(e);
        if (e.t !== "job" || !o.jobs) return;
        const parsed = JobViewSchema.safeParse(e.body);
        if (parsed.success) jobsSync.note(parsed.data);
        o.jobs.apply(e.body, jobsSync.listing);
      }, { onOpen: () => { void resync(); } });
      await resync();
    },
    stop() {
      if (noticeTimer) clearInterval(noticeTimer);
      unsubscribe();
      rmSync(o.stagingDir, { recursive: true, force: true });
    },
  };
}
