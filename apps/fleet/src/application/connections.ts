// The live agent connections (spec 5.2): one per node, the instance rules, liveness and node status, and the latest
// inventory and health each node reported.
//   - The same instanceId replaces its older connection (a reconnect); its waiting requests carry over.
//   - A different instanceId while one is live: the live connection is pinged, and the newcomer waits up to
//     LIMITS.instancePongMs for its pong, without holding up any other node. No pong: the old connection is half-open
//     or its agent hung, so it is terminated and the newcomer admitted (a crash can't lock a node out). A pong: the
//     newcomer is refused (4409), with one alert per refused instance for as long as that live connection lasts, so two
//     agents with one key never flap.
//   - A different instance is accepted at once once the old connection closed or missed its pong (stale).
//   - Every admission takes the next connEpoch from fleet.db: a fencing token that only grows.
// Requests: control ops go out at once; bulk ops (transcript.read, file.get, file.put) one at a time per node, so a
// control message never waits behind more than one bulk chunk (spec 5.2). At most LIMITS.bulkQueueMax wait behind the
// one in flight (one more is `busy`, executed: no), and a waiting op's timeoutMs runs from when it was queued: it
// answers `timeout` (executed: no) if its turn doesn't come in time, and is sent with what is left of it.
// Liveness: a ping every LIMITS.pingMs; a connection that hasn't answered the previous ping is stale and terminated.
// Status: online after a welcome, stale from the first missed pong until terminated, offline once closed. The same
// sweep re-checks that each node is still registered, so a revocation made while the service runs (the console writes
// fleet.db directly) takes effect within one interval, for a node that is offline too (its lanes go: `onRevoked`).
import { CAP_LONG_TEXT, CAP_ROLLOUT, CAP_UPDATE, CLOSE, LIMITS, type FleetMessage, type Health, type NodeUpdateHealth, type OpName, type Pane, type RolloutWire } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { Logger } from "../adapters/log.ts";
import type { NodesStore } from "../adapters/nodes-store.ts";
import type { EventHub } from "./events.ts";
import { BULK_OPS, RESULT_SLACK_MS, Requests, failed, type Outcome, type Res, type StoreSeqs } from "./requests.ts";

export type NodeStatus = "online" | "stale" | "offline";
export type NodeView = { name: string; status: NodeStatus; health: Health | null; agent: string | null; commit: string | null;
  // The protocol versions the node's hello named (null: not connected) and its updater's last report (null: none — an
  // older node, or one that has not applied anything), updates §7.
  proto: number[] | null; update: NodeUpdateHealth | null };

// What the transport gives for one authenticated socket.
export type Peer = { send(m: FleetMessage): void; ping(): void; close(code: number, reason: string): void; terminate(): void; open(): boolean };
export type Admission = {
  node: string; instanceId: string; streamId: string; peer: Peer; source: string; agentVersion: string; agentCommit: string | null; claudeVersion: string | null; caps: string[];
  proto: number[];                                        // the hello's, kept for GET /v1/nodes while it is connected
};

type Live = Admission & {
  epoch: number; alive: boolean; stale: boolean; nextReq: number; pingAt: number | null; rttMs: number | null;
  clockAlerted: boolean; refusedAlerted: Set<string>; pongWaiters: Set<(answered: boolean) => void>;
};
type Latest = { inventory: { panes: Pane[]; invVersion: number } | null; health: Health | null };
type Queued = { op: OpName; args: unknown; o: { key?: string; timeoutMs: number }; at: number; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout> };
type BulkQueue = { running: boolean; waiting: Queued[] };

export const CLOCK_ALERT_MS = 2000;                      // spec 5.4: alert when the offset exceeds 2 s
export const REPLACED = 1000;                            // a normal close: the same instance opened a newer connection
const INSTANCE_ROUNDS = 3;                               // instance checks for one hello, if the live connection keeps changing

export class Connections {
  #live = new Map<string, Live>();
  #latest = new Map<string, Latest>();
  #nodes: NodesStore;
  #audit: Audit;
  #events: EventHub;
  #log: Logger;
  #now: () => number;
  #mono: () => number;
  #pingMs: number;
  #instancePongMs: number;
  #onRevoked: (node: string) => void;
  #updates: { aboveOwn(version: string): boolean; halted(version: string): boolean; issue?(node: string, version: string): string } | null;
  #revocations = new Map<string, number>();             // node → the revokedAt already acted on
  #sweep: ReturnType<typeof setInterval> | null = null;
  #bulk = new Map<string, BulkQueue>();
  readonly requests: Requests;

  constructor(p: {
    nodes: NodesStore; audit: Audit; events: EventHub; log: Logger; now?: () => number; mono?: () => number; pingMs?: number;
    resultSlackMs?: number; instancePongMs?: number; onRevoked?: (node: string) => void;
    // The updates design's two rules (§5.4), injected so this service holds none of the Rollout: whether a Version is
    // above the one this control plane runs (RL11), and whether the Rollout of a Version is halted (RL12). Null in
    // tests that ask for none of it.
    updatePolicy?: { aboveOwn(version: string): boolean; halted(version: string): boolean; issue?(node: string, version: string): string };
    storeSeqs: StoreSeqs;                                 // fleet.db's
  }) {
    this.#nodes = p.nodes;
    this.#audit = p.audit;
    this.#events = p.events;
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
    this.#mono = p.mono ?? (() => performance.now());
    this.#pingMs = p.pingMs ?? LIMITS.pingMs;
    this.#instancePongMs = p.instancePongMs ?? LIMITS.instancePongMs;
    this.#onRevoked = p.onRevoked ?? (() => {});
    this.#updates = p.updatePolicy ?? null;
    for (const n of this.#nodes.list()) if (n.revokedAt !== null) this.#revocations.set(n.name, n.revokedAt);   // done at start
    this.requests = new Requests((node, instanceId) => this.#live.get(node)?.instanceId === instanceId, p.resultSlackMs ?? RESULT_SLACK_MS, p.storeSeqs);
  }

  start(): void {
    this.#sweep ??= setInterval(() => {
      try { this.sweep(); } catch (e) { this.#log.error("liveness sweep failed; trying again at the next ping", e); }
    }, this.#pingMs);
  }

  stop(): void {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    for (const c of this.#live.values()) { c.peer.close(1001, "fleet service stopping"); this.#answered(c, false); }
    this.#live.clear();
    for (const [node, q] of this.#bulk) for (const w of q.waiting.splice(0)) { clearTimeout(w.timer); w.resolve(failed("node_offline", `${w.op} on ${node}: the fleet service is stopping`)); }
    this.requests.drop(null);
  }

  // Applies the instance rules. On admission `welcome(epoch)` runs before anyone hears the node is online, so the
  // welcome is the first message on the new connection. Waits (at most instancePongMs per round) only when another
  // instance's connection is live and has to show that it still answers.
  async admit(a: Admission, welcome: (epoch: number) => void): Promise<{ ok: true; epoch: number } | { ok: false; revoked?: true }> {
    for (let round = 0; round < INSTANCE_ROUNDS; round++) {
      const cur = this.#live.get(a.node);
      if (!cur || cur.instanceId === a.instanceId || cur.stale) return this.#admitNow(a, welcome);
      const answered = await this.#check(cur);
      if (!a.peer.open()) return { ok: false };           // the newcomer went away while it waited
      if (this.#live.get(a.node) !== cur) continue;        // the live one closed or was replaced meanwhile: look again
      if (!answered) {
        this.#log.warn(`node ${a.node}: instance ${cur.instanceId.slice(0, 8)} missed the instance check; ${a.instanceId.slice(0, 8)} takes over`);
        this.#audit.record("fleet", "conn.replaced", a.node, { old: cur.instanceId, new: a.instanceId, source: a.source });
        // Admitted in this round, whichever it is: #admitNow terminates the silent connection (another instance) once
        // fleet.db took the admission. Going round again ended the last round with the silent one gone and the newcomer
        // refused 4409 too, a node with no connection (B6 V42; spec 5.2: "an unclean restart can't lock the node out").
        return this.#admitNow(a, welcome);
      }
      if (!cur.refusedAlerted.has(a.instanceId)) {
        cur.refusedAlerted.add(a.instanceId);
        this.#audit.alert("instance_conflict", a.node, { live: cur.instanceId, refused: a.instanceId, source: a.source });
      }
      return { ok: false };
    }
    return { ok: false };
  }

  // Pings a live connection outside the sweep: true when it answers within instancePongMs, false when it doesn't or
  // closes first.
  #check(c: Live): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const done = (answered: boolean) => { clearTimeout(timer); c.pongWaiters.delete(done); resolve(answered); };
      const timer = setTimeout(() => done(false), this.#instancePongMs);
      c.pongWaiters.add(done);
      c.peer.ping();
    });
  }

  #answered(c: Live, answered: boolean): void { for (const w of [...c.pongWaiters]) w(answered); }

  #admitNow(a: Admission, welcome: (epoch: number) => void): { ok: true; epoch: number } | { ok: false; revoked?: true } {
    if (!a.peer.open()) return { ok: false };
    // The node may have been revoked while the instance check waited: revoke() closed the old connection, and the
    // newcomer must not come in behind it.
    if (!this.#nodes.active(a.node)) return { ok: false, revoked: true };
    // fleet.db first: a write it refuses (busy past its timeout, or full) throws here, before anything in memory
    // changed, so the live connection stays live, routed and announced, and only the newcomer is closed (1011) (B6
    // V41). An epoch taken by an admission that then failed is skipped: the fencing token still only grows.
    const epoch = this.#nodes.nextEpoch(a.node);
    const previous = this.#nodes.recordSource(a.node, a.source);
    if (previous !== null) this.#audit.alert("source_changed", a.node, { from: previous, to: a.source });
    this.#nodes.seen(a.node, a.agentVersion, a.proto);
    this.#audit.record("agent", "conn.admitted", a.node, { instanceId: a.instanceId, epoch, source: a.source });
    const cur = this.#live.get(a.node);
    if (cur) {
      this.#live.delete(a.node);                         // its close is then not taken for the node going offline
      this.#answered(cur, false);
      if (cur.instanceId === a.instanceId) cur.peer.close(REPLACED, "replaced by a newer connection of this instance");
      else cur.peer.terminate();
    }
    this.requests.admitted(a.node, a.instanceId);
    this.#live.set(a.node, {
      ...a, epoch, alive: true, stale: false, nextReq: 0, pingAt: null, rttMs: null, clockAlerted: false, refusedAlerted: new Set(), pongWaiters: new Set(),
    });
    welcome(epoch);
    this.#log.info(`node ${a.node} online (instance ${a.instanceId.slice(0, 8)}, epoch ${epoch})`);
    this.#status(a.node, "online");
    return { ok: true, epoch };
  }

  closed(node: string, peer: Peer): void {
    const c = this.#live.get(node);
    if (!c || c.peer !== peer) return;                   // a replaced or refused connection
    this.#live.delete(node);
    this.#answered(c, false);
    this.requests.connectionLost(node, c.instanceId);
    this.#log.info(`node ${node} offline`);
    this.#status(node, "offline");
  }

  pong(node: string, peer: Peer): void {
    const c = this.#live.get(node);
    if (!c || c.peer !== peer) return;
    c.alive = true;
    if (c.pingAt !== null) { c.rttMs = this.#mono() - c.pingAt; c.pingAt = null; }   // the sweep's ping, once
    this.#answered(c, true);
  }

  // fleet.db busy or full (another writer holds its lock, a full disk) must not stop the pings: each node's reads and
  // writes here are tried on their own, logged when they fail, and a node whose registration can't be read stays
  // connected until a sweep can read it.
  sweep(): void {
    for (const [node, c] of [...this.#live]) {
      let active = true;
      try { active = this.#nodes.active(node) !== null; } catch (e) { this.#log.error(`liveness sweep: could not read node ${node}'s registration (fleet.db busy?)`, e); }
      if (!active) { this.revoke(node); continue; }
      if (!c.alive) {
        c.stale = true;
        this.#status(node, "stale");
        c.peer.terminate();                              // its close follows and marks the node offline
        continue;
      }
      c.alive = false;
      c.pingAt = this.#mono();
      c.peer.ping();
      try { this.#nodes.seen(node); } catch (e) { this.#log.error(`liveness sweep: could not record node ${node} as seen (fleet.db busy or full?)`, e); }
    }
    // Revocations written to fleet.db while the service runs, of nodes that aren't connected (the console's `node
    // revoke` when the service didn't answer it): their lanes and latest reports go too.
    try {
      for (const n of this.#nodes.list()) if (n.revokedAt !== null && this.#revocations.get(n.name) !== n.revokedAt) this.revoke(n.name);
    } catch (e) { this.#log.error("liveness sweep: could not read the nodes for revocations (fleet.db busy?)", e); }
  }

  // A revoked node: its connection closes (4403), its waiting requests end, and what is known of it goes (its latest
  // inventory and health here, its lanes through onRevoked).
  revoke(node: string): void {
    const row = this.#nodes.node(node);
    if (row?.revokedAt !== null && row?.revokedAt !== undefined) this.#revocations.set(node, row.revokedAt);
    const c = this.#live.get(node);
    this.requests.drop(node);
    if (c) {
      this.#live.delete(node);
      this.#answered(c, false);
      c.peer.close(CLOSE.forbidden, "revoked");
      this.#status(node, "offline");
    }
    this.forget(node);
    this.#onRevoked(node);
  }

  status(node: string): NodeStatus {
    const c = this.#live.get(node);
    return !c ? "offline" : c.stale ? "stale" : "online";
  }

  request(node: string, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    // A message, and a lane's first prompt, over the old bound go only to a live node whose hello said it takes one
    // (CAP_LONG_TEXT): an older agent would refuse them bad_args after 8,000, so the fleet refuses them here,
    // unknown_op (an old end reads that code safely), and nothing is sent. A node not live (offline or stale) keeps its
    // own answer.
    const c = this.#live.get(node);
    // update.apply (updates §5.4) is refused the same way, on three counts: a live node whose hello never said
    // CAP_UPDATE answers unknown_op, as an agent that never knew the op; a Version above the control plane's own is
    // the skew RL11 refuses; a halted Rollout takes no asks until it is resumed (RL12). All before anything is sent,
    // so every refusal answers executed: no.
    if (op === "update.apply" && c !== undefined && !c.stale && this.#updates !== null) {
      const version = typeof args === "object" && args !== null ? (args as { version?: unknown }).version : undefined;
      if (typeof version !== "string")
        return Promise.resolve(failed("bad_args", "update.apply needs a version"));
      {
        if (!c.caps.includes(CAP_UPDATE))
          return Promise.resolve(failed("unknown_op", `${node}'s agent has no update.apply; update Morndo on it`));
        if (this.#updates.aboveOwn(version))
          return Promise.resolve(failed("not_allowed", `update.apply on ${node} for ${version}: a node never runs a Version newer than its control plane (RL11)`));
        const runs = this.latest(node).health?.update?.version;
        if (runs !== undefined && this.#updates.aboveOwn(runs))
          return Promise.resolve(failed("not_allowed", `update.apply on ${node}: it runs ${runs}, above the control plane's own; it moves only once the control plane catches up, or roll it back on ${node} by hand (morndo update --rollback)`));
        if (this.#updates.halted(version))
          return Promise.resolve(failed("not_allowed", `update.apply on ${node} for ${version}: the Rollout of ${version} is halted: resume it first (RL12)`));
        // The fleet's own attempt id for this ask, replacing any the caller sent: the id that node's rollback of it is
        // reported under, and the only one that halts (review of #107, round 4).
        const attempt = this.#updates.issue?.(node, version);
        if (attempt !== undefined) args = { ...(args as Record<string, unknown>), version, attempt };
      }
    }
    const text = (op === "pane.send" || op === "lane.deliver" || op === "lane.start") && typeof args === "object" && args !== null
      ? (args as { text?: unknown; prompt?: unknown })[op === "lane.start" ? "prompt" : "text"] : undefined;
    if (typeof text === "string" && text.length > LIMITS.maxSendText && c !== undefined && !c.stale && !c.caps.includes(CAP_LONG_TEXT))
      return Promise.resolve(failed("unknown_op", op === "lane.start"
        ? `${node}'s agent takes a first prompt of at most ${LIMITS.maxSendText} characters; update Morndo on it`
        : `${node}'s agent takes messages of at most ${LIMITS.maxSendText} characters; update Morndo on it`));
    if (!BULK_OPS.has(op)) return this.#send(node, op, args, o);
    const q = this.#bulk.get(node) ?? { running: false, waiting: [] };
    this.#bulk.set(node, q);
    if (!q.running) {
      q.running = true;
      return this.#runBulk(node, q, this.#send(node, op, args, o));
    }
    if (q.waiting.length >= LIMITS.bulkQueueMax) {
      return Promise.resolve(failed("busy", `${op} on ${node}: ${q.waiting.length} bulk transfers already wait for this node; not sent`));
    }
    return new Promise<Outcome>(resolve => {
      const w: Queued = {
        op, args, o, at: this.#mono(), resolve,
        timer: setTimeout(() => {
          const i = q.waiting.indexOf(w);
          if (i === -1) return;
          q.waiting.splice(i, 1);
          resolve(failed("timeout", `${op} on ${node}: its turn didn't come within ${o.timeoutMs} ms; not sent`));
        }, o.timeoutMs),
      };
      q.waiting.push(w);
    });
  }

  // When the bulk op in flight ends, the next one waiting goes, with what is left of its own timeout.
  #runBulk(node: string, q: BulkQueue, run: Promise<Outcome>): Promise<Outcome> {
    void run.finally(() => {
      for (let w = q.waiting.shift(); w !== undefined; w = q.waiting.shift()) {
        clearTimeout(w.timer);
        const left = Math.floor(w.o.timeoutMs - (this.#mono() - w.at));
        if (left <= LIMITS.deadlineMarginMs) { w.resolve(failed("timeout", `${w.op} on ${node}: too little of its ${w.o.timeoutMs} ms left when its turn came; not sent`)); continue; }
        const next = this.#send(node, w.op, w.args, { ...w.o, timeoutMs: left });
        void next.then(o => w.resolve(o));
        void this.#runBulk(node, q, next);
        return;
      }
      q.running = false;
      if (this.#bulk.get(node) === q) this.#bulk.delete(node);
    });
    return run;
  }

  #send(node: string, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    const c = this.#live.get(node);
    if (!c || c.stale) return Promise.resolve(failed("node_offline", `node ${node} is ${this.status(node)}`));
    // A socket already closing (ws readyState CLOSING: "The connection is in the process of closing") takes no more
    // frames: the session would drop this one unsent, and a side-effecting op would answer uncertain at its deadline.
    // Nothing is sent, so the answer is node_offline, executed: no (B6 V40).
    if (!c.peer.open()) return Promise.resolve(failed("node_offline", `node ${node}'s connection is closing`));
    const ch = { node, instanceId: c.instanceId, store: c.streamId, id: `${c.epoch}.${++c.nextReq}`, send: (m: FleetMessage) => c.peer.send(m) };
    return this.requests.send(ch, op, args, o);
  }

  // The highest store sequence `store` of `node` has shown (fleet.db's in the service), for the welcome's storeSeqSeen.
  storeSeqSeen(node: string, store: string): number | null { return this.requests.highestSeq(node, store); }

  result(node: string, instanceId: string, res: Res): void {
    const r = this.requests.result(node, instanceId, res);
    if (r === "unknown") this.#log.debug(`node ${node}: a result for ${res.id}, which no longer waits; dropped`);
    if (r === "foreign") this.#log.warn(`node ${node}: a result for ${res.id} from another instance; dropped`);
  }

  inventory(node: string, panes: Pane[], invVersion: number): void {
    this.#latestOf(node).inventory = { panes, invVersion };
    this.#events.emit({ t: "inventory", node, body: { panes, invVersion } });
  }

  // Stores the latest health and compares the node's clock with ours, allowing for the last ping's round trip.
  health(node: string, h: Health): void {
    this.#latestOf(node).health = h;
    this.#events.emit({ t: "health", node, body: h });
    const c = this.#live.get(node);
    if (!c) return;
    const offsetMs = h.wallClock - this.#now();
    const off = Math.abs(offsetMs) > CLOCK_ALERT_MS + (c.rttMs ?? 0);
    if (off && !c.clockAlerted) this.#audit.alert("clock_offset", node, { offsetMs: Math.round(offsetMs) });
    c.clockAlerted = off;
  }

  latest(node: string): Latest {
    return this.#latest.get(node) ?? { inventory: null, health: null };
  }

  // Every registered (not revoked) node, with its status, latest health, agent version, the protocol versions its
  // hello named (null: not connected) and its updater's last report (null: none).
  list(): NodeView[] {
    return this.#nodes.list().filter(n => n.revokedAt === null).map(n => ({
      name: n.name, status: this.status(n.name), health: this.latest(n.name).health, agent: this.#live.get(n.name)?.agentVersion ?? n.agentVersion,
      commit: this.#live.get(n.name)?.agentCommit ?? null,
      // live, or the last hello's while offline (review of #111): an offline node still speaks those (RL11)
      proto: this.#live.get(n.name)?.proto ?? n.lastProto, update: this.latest(n.name).health?.update ?? null,
    }));
  }

  // The Rollout as it now stands, to every live agent whose hello said it takes one (CAP_ROLLOUT), each with its own
  // offer (what it may follow, and the attempt id it reports a rollback of it under; none while there is nothing to
  // follow); an agent from before the updates design is sent nothing — it would close on a frame it doesn't know.
  pushRollout(rollout: RolloutWire, offerFor: (node: string) => { version: string; attempt: string } | null = () => null): void {
    for (const c of this.#live.values()) {
      if (c.stale || !c.caps.includes(CAP_ROLLOUT) || !c.peer.open()) continue;
      const offer = offerFor(c.node);
      c.peer.send({ v: 1, t: "rollout", rollout, ...(offer === null ? {} : { offer }) });
    }
  }

  // The live instance of a node, for tests and status: null when offline.
  liveInstance(node: string): { instanceId: string; epoch: number } | null {
    const c = this.#live.get(node);
    return c ? { instanceId: c.instanceId, epoch: c.epoch } : null;
  }

  forget(node: string): void { this.#latest.delete(node); }

  #latestOf(node: string): Latest {
    let l = this.#latest.get(node);
    if (!l) { l = { inventory: null, health: null }; this.#latest.set(node, l); }
    return l;
  }

  #status(node: string, status: NodeStatus): void {
    this.#events.emit({ t: "status", node, body: { status } });
  }
}
