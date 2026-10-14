// A scripted agent for the fleet's tests (spec 9, "Contract": the real fleet against a scripted fake agent). It joins
// with its name and a code, says hello, checks the fleet's signature against the pinned key, proves its own key,
// answers requests with `answer` (by default a minimal valid result of the op), each with its `store` (by default its
// stream id, as the real agent's database) and, once a test sets one, its `storeSeq` (none by default: an agent from
// before the store sequence), and sends events. Like the real agent, it decodes every message from the
// fleet with the protocol's schemas and closes with 1008 on one that doesn't fit.
// Real WebSockets, synthetic data only.
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  FLEET_PROTO, FleetFrames, decodeValue, fleetSigPayload, nodeSigPayload,
  type Delivery, type FleetMessage, type Health, type HookEvent, type OpError, type OpResult, type Pane,
} from "@morndo/protocol";
import { whenTrue } from "./when-true.ts";

export type Closed = { code: number; reason: string };
export type Req = Extract<FleetMessage, { t: "req" }>;
export type Welcome = Extract<FleetMessage, { t: "welcome" }>;
export type Answer = { ok: true; result: unknown } | { ok: false; error: OpError } | "never";
export type AgentKey = { publicKey: string; privateKey: KeyObject };
export type Connected = { ok: true; welcome: Welcome } | { ok: false; closed: Closed; fleetSigOk: boolean | null };

// A text frame's JSON, whatever buffer shape ws hands it in.
export const parseFrame = <T>(raw: RawData): T =>
  JSON.parse((Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)).toString("utf8")) as T;

export const newKey = (): AgentKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey };
};
const sig = (key: AgentKey, payload: string) => sign(null, Buffer.from(payload), key.privateKey).toString("base64");

// A minimal result of each op that fits OP_RESULTS, for an agent whose test doesn't care what it answers.
export const validResult = (op: string, node: string): unknown => {
  const results: { [O in keyof OpResult]: OpResult[O] } = {
    "inventory.get": { panes: [], invVersion: 1 }, "pane.captureMany": { captures: [] }, "pane.frame": { frame: null },
    "pane.keys": { ok: true }, "pane.send": { problem: null, typedAt: 1 }, "op.status": { state: "unknown" },
    "transcript.size": { size: null }, "transcript.read": { bytes: "", eof: true }, "transcript.locate": { offset: null },
    "file.stat": { size: 0, mtime: 0 }, "file.get": { bytes: "", size: 0, eof: true }, "file.put": { path: null },
    "lane.start": { workerId: `${node || "node"}.3fa2c1d0.0` }, "lane.stop": { ok: true }, "worktree.list": { worktrees: [] },
    "worktree.add": { path: "/work" },
    "pane.capture": { text: null, truncated: false },
    "lane.deliver": { delivery: { id: "hub:fake", node: node || "node", target: { lane: "fake" }, state: "queued", queuedAt: 1, notAfter: 2 } },
    "delivery.cancel": { delivery: { id: "hub:fake", node: node || "node", target: { lane: "fake" }, state: "given_up", queuedAt: 1, notAfter: 2, why: "cancelled" } },
    "job.cancel": { ok: true }, "job.notice": { ok: true }, "job.noticeResult": { ok: true },
    "connections.priority": { ok: true }, "connections.role": { ok: true }, "connections.revoke": { ok: true }, "connections.narrow": { ok: true },
  };
  return Object.hasOwn(results, op) ? results[op as keyof OpResult] : {};
};

export const health = (over: Partial<Health> = {}): Health => ({
  memTotal: 8e9, memAvailable: 4e9, psiSome10: 0, psiFull10: 0, diskFreeHome: 1e11, load1: 0.5, tmuxOk: true,
  wallClock: Date.now(), spoolDepth: 0, drops: 0, ...over,
});

export class FakeAgent {
  readonly url: string;
  readonly fleetKey: string;
  key: AgentKey;
  node: string;
  instanceId: string;
  streamId: string;
  store: string;                               // what each res says its done keys live in (the real agent: its stream id)
  storeSeq: number | null = null;              // what each res says of its store's sequence; null: not sent at all
  ws: WebSocket | null = null;
  welcome: Welcome | null = null;
  inbox: FleetMessage[] = [];                  // every message of the current connection, in order, as sent
  reqs: Req[] = [];                            // every request this agent was sent, across connections
  refused: unknown[] = [];                     // messages from the fleet that don't fit the protocol (closed with 1008)
  invVersion = 1;
  answer: (req: Req) => Answer = req => ({ ok: true, result: validResult(req.op, this.node) });
  #waiters = new Set<() => void>();
  #closed: Promise<Closed> = Promise.resolve({ code: 0, reason: "never connected" });

  constructor(o: { url: string; fleetKey: string; node?: string; key?: AgentKey; instanceId?: string; streamId?: string }) {
    this.url = o.url;
    this.fleetKey = o.fleetKey;
    this.node = o.node ?? "";
    this.key = o.key ?? newKey();
    this.instanceId = o.instanceId ?? randomUUID();
    this.streamId = o.streamId ?? randomUUID();
    this.store = this.streamId;
  }

  get closed(): Promise<Closed> { return this.#closed; }
  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  // Opens a socket; resolves once open (true) or refused before opening (false).
  #open(o: { autoPong?: boolean; headers?: Record<string, string> }): Promise<boolean> {
    this.inbox = [];
    this.welcome = null;
    const ws = new WebSocket(this.url, { autoPong: o.autoPong ?? true, headers: o.headers ?? {} });
    this.ws = ws;
    this.#closed = new Promise<Closed>(resolve => ws.on("close", (code, reason) => { this.#wake(); resolve({ code, reason: reason.toString() }); }));
    ws.on("error", () => {});
    ws.on("message", raw => {
      const value = parseFrame<unknown>(raw);
      if (decodeValue(FleetFrames, value).kind !== "ok") {
        this.refused.push(value);
        ws.close(1008, "a malformed or unknown message");
        return;
      }
      const m = value as FleetMessage;                         // as the fleet sent it: a field too many would show
      this.inbox.push(m);
      if (m.t === "req") this.#onReq(m);
      this.#wake();
    });
    return new Promise<boolean>(resolve => {
      ws.once("open", () => resolve(true));
      ws.once("close", () => resolve(false));
    });
  }

  #onReq(req: Req) {
    this.reqs.push(req);
    const a = this.answer(req);
    if (a === "never") return;
    const seq = this.storeSeq === null ? {} : { storeSeq: this.storeSeq };
    this.send(a.ok ? { v: 1, t: "res", id: req.id, invVersion: this.invVersion, store: this.store, ...seq, ok: true, result: a.result }
      : { v: 1, t: "res", id: req.id, invVersion: this.invVersion, store: this.store, ...seq, ok: false, error: a.error });
  }

  #wake() { for (const w of [...this.#waiters]) w(); }

  // Resolves when `ready` is true, including a fact that already happened. The test timeout is the limit.
  when(ready: () => boolean): Promise<void> {
    return whenTrue(ready, fn => {
      this.#waiters.add(fn);
      return () => { this.#waiters.delete(fn); };
    });
  }

  // The first message of this connection that `pick` maps to a value, or null once the socket closes or `ms` pass.
  next<T>(pick: (m: FleetMessage) => T | undefined, ms = 5000): Promise<T | null> {
    return new Promise<T | null>(resolve => {
      const check = () => {
        for (const m of this.inbox) { const v = pick(m); if (v !== undefined) { done(v); return; } }
        if (this.ws?.readyState === WebSocket.CLOSED) done(null);
      };
      const done = (v: T | null) => { clearTimeout(timer); this.#waiters.delete(check); resolve(v); };
      const timer = setTimeout(() => done(null), ms);
      this.#waiters.add(check);
      check();
    });
  }

  send(m: unknown): void { this.ws?.send(typeof m === "string" ? m : JSON.stringify(m)); }

  // `join { node, code, publicKey, agent, proto }`, with the name and the code from the join string. The agent takes
  // that name as its own; the welcome only says it was accepted.
  async join(node: string, code: string, o: { proto?: number[] } = {}): Promise<{ welcome: Welcome | null; closed: Closed }> {
    this.node = node;
    if (!(await this.#open({}))) return { welcome: null, closed: await this.#closed };
    this.send({ v: 1, t: "join", node, code, publicKey: this.key.publicKey, agent: { version: "test-agent/1" }, proto: o.proto ?? [FLEET_PROTO] });
    const welcome = await this.next(m => (m.t === "welcome" ? m : undefined));
    return { welcome, closed: await this.#closed };
  }

  // hello → challenge (the fleet's signature checked against the pinned key) → proof → welcome.
  async connect(o: {
    proto?: number[]; autoPong?: boolean; headers?: Record<string, string>; proof?: "good" | "tampered" | "other-key"; pinned?: string; node?: string;
  } = {}): Promise<Connected> {
    const node = o.node ?? this.node;
    if (!(await this.#open(o))) return { ok: false, closed: await this.#closed, fleetSigOk: null };
    const clientNonce = randomBytes(32).toString("base64url");
    this.send({
      v: 1, t: "hello", node, instanceId: this.instanceId, streamId: this.streamId, proto: o.proto ?? [FLEET_PROTO],
      agent: { version: "test-agent/1" }, claude: { version: null }, caps: ["inventory.get"], clientNonce,
    });
    const challenge = await this.next(m => (m.t === "challenge" ? m : undefined));
    if (!challenge) return { ok: false, closed: await this.#closed, fleetSigOk: null };
    const pinned = createPublicKey({ key: Buffer.from(o.pinned ?? this.fleetKey, "base64"), format: "der", type: "spki" });
    const fleetSigOk = verify(null, Buffer.from(fleetSigPayload(node, clientNonce)), pinned, Buffer.from(challenge.fleetSig, "base64"));
    if (!fleetSigOk) { this.ws?.close(); return { ok: false, closed: { code: -1, reason: "the fleet's signature does not verify" }, fleetSigOk }; }
    let proof = sig(o.proof === "other-key" ? newKey() : this.key, nodeSigPayload(node, challenge.nonce));
    if (o.proof === "tampered") { const b = Buffer.from(proof, "base64"); b[5] = (b[5] ?? 0) ^ 0xff; proof = b.toString("base64"); }
    this.send({ v: 1, t: "proof", sig: proof });
    const welcome = await this.next(m => (m.t === "welcome" ? m : undefined));
    if (!welcome) return { ok: false, closed: await this.#closed, fleetSigOk };
    this.welcome = welcome;
    return { ok: true, welcome };
  }

  // A pane may leave out status and pid, as an agent from before session state does (fleet clients §5).
  inventory(panes: (Omit<Pane, "status" | "pid"> & Partial<Pick<Pane, "status" | "pid">>)[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
  // A delivery's latest state, as the node's queue reports it (fleet clients spec §4.4).
  delivery(d: Delivery): void { this.send({ v: 1, t: "ev.delivery", delivery: d }); }
  health(h: Health = health()): void { this.send({ v: 1, t: "ev.health", health: h }); }

  hook(seq: number, path: HookEvent["path"] = "/hook/stop", body: unknown = { n: seq }, over: Partial<HookEvent> = {}): void {
    const event: HookEvent = { streamId: this.streamId, seq, at: 1_700_000_000_000 + seq, path, node: this.node, window: "lane", body, ...over };
    this.send({ v: 1, t: "ev.hook", event });
  }

  // The highest cumulative ack for this agent's stream on the current connection, waiting until it reaches `seq`.
  acked(seq: number, ms = 5000): Promise<number | null> {
    return this.next(m => (m.t === "ack" && m.streamId === this.streamId && m.seq >= seq ? m.seq : undefined), ms);
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) { this.ws.close(); await this.#closed; }
  }

  terminate(): void { this.ws?.terminate(); }
}
