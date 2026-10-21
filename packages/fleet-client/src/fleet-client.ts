// The TypeScript client of the fleet service's client API (ADR-0012; docs/design/fleet-core/README.md §5.6; fleet clients,
// docs/design/fleet-clients/README.md §8): HTTP and one WebSocket over the fleet's Unix socket. Moved out of the hub
// (fleet clients, Task 3) for the hub, `morndo lanes` and kira; it imports only @morndo/protocol, node:* and ws.
// - Requests use node:http with `socketPath` ("Unix domain socket. Cannot be used if one of host or port is specified",
//   https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06). A new Agent per
//   request, because a kept-alive socket the fleet closed while idle fails a request after it was written, and a send
//   would be in doubt for nothing. The agent keeps the socket's connect error: a path the system refuses is EINVAL on
//   the socket and then a reset on the request (Node 24).
// - Events: a WebSocket to ws://fleet/v1/events whose connection is the same Unix socket, opened by ws's createConnection
//   option ("opts.createConnection || …netConnect", ws 8.22.0 lib/websocket.js), never an IPC URL: that carries the path
//   through new URL() (a space or a non-ASCII letter percent-encoded, cut at ':', a '#' throws). Reconnects with backoff.
// - ws, not Node's own WebSocket: Node's is undici's, whose docs give it no way to dial a Unix socket
//   (https://nodejs.org/docs/latest-v24.x/api/globals.html#websocket, read 2026-10-08).
// Every answer is checked for shape: one that isn't the client API is the fleet's fault and is never guessed at. Every
// request names this client (`x-morndo-client`, "hub" unless the caller names another, §8), which the fleet's audit
// records with each op it sends to a node and each delivery.
import { Agent, request, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { WebSocket } from "ws";
import {
  CLIENT_API, DeliverySchema, JobsListSchema, LaneEventSchema, LIMITS, parseBody, readOpError, redactText, RunViewSchema, toLogFormat, type Alert, type AlertKind,
  type Delivery, type DeliveryState, type Health, type JobsList, type LaneEvent, type LaneWatchEntry, type OpArgs, type OpError, type OpName, type OpResult,
  type RunView,
} from "@morndo/protocol";

export type NodeStatus = "online" | "stale" | "offline";
// Where the client says what went wrong with its events (a frame it couldn't read, a listener that threw). The hub passes
// its own logger; without one, a line goes to stderr, redacted as the services' own logs are (protocol redact.ts).
export type FleetLog = { warn(message: string, error?: unknown): void; error(message: string, error?: unknown): void };
const stderrLog = (level: "warn" | "error") => (message: string, error?: unknown) => {
  process.stderr.write(`${redactText(`[fleet-client] ${level}: ${message}${error === undefined ? "" : `\n${toLogFormat(error)}`}`, homedir())}\n`);
};
const STDERR_LOG: FleetLog = { warn: stderrLog("warn"), error: stderrLog("error") };
// `commit`: the commit the node's build reports (B11, for the board's "merged, not live"); absent or null when it names none.
export type FleetNode = { name: string; status: NodeStatus; health: Health | null; agent: string | null; commit?: string | null };
export type FleetLane = { name: string; node: string; workerId: string | null; conflict: boolean };
// `alert`: its body is an Alert, and `node` is the alert's node or "". `delivery`, `lane` (fleet clients §4.4, §7) and
// `run` (a lane's Run, ADR-0032): their bodies are checked here, so they come typed.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert" | "job"; node: string; body: unknown }
  | { t: "delivery"; node: string; body: Delivery & { stale: boolean } }
  | { t: "lane"; node: string; body: LaneEvent }
  | { t: "run"; node: string; body: RunView };
// A delivery as the fleet serves it: its latest state, and whether its node is offline now (stale).
export type FleetDelivery = Delivery & { stale: boolean };
export type OpTarget = { workerId: string } | { node: string } | { lane: string };
// The ops a client sends through op(): every op but the two of the delivery queue.
export type ClientOp = Exclude<OpName, "lane.deliver" | "delivery.cancel">;
const DELIVERY_OPS = new Set<string>(["lane.deliver", "delivery.cancel"]);
// `store`: the store of the node that answered (the agent database its keys live in, plan.md "Behaviour"); null on a
// refusal made before anything was sent to a node. `storeSeq`: that store's sequence (final review I2), the agent's own
// on its answers and the highest the fleet saw from that store on the fleet's own; null when there is none (nothing was
// sent, an agent or a fleet from before it).
export type OpAnswer<O extends OpName> = { ok: true; result: OpResult[O]; invVersion: number; store: string; storeSeq: number | null }
  | { ok: false; error: OpError; store: string | null; storeSeq: number | null };

// The fleet couldn't be asked, or didn't answer in time. `reached` is false when the request never left this process
// (no socket there, refused, no permission): nothing can have been done. True otherwise: it may have been.
export class FleetUnavailable extends Error {
  readonly reached: boolean;
  constructor(message: string, reached: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "FleetUnavailable";
    this.reached = reached;
  }
}
// The socket answered, but not as the client API does (another service there, or a fleet of another version).
export class FleetMismatch extends Error {
  constructor(message: string) { super(message); this.name = "FleetMismatch"; }
}
// An op the fleet refused, or answered "maybe" for, where the caller can't go on with a plain value: the node's error.
export class FleetOpFailed extends Error {
  readonly error: OpError;
  constructor(op: string, error: OpError) {
    super(`${op}: ${error.code}: ${error.message}`);
    this.name = "FleetOpFailed";
    this.error = error;
  }
}

// The connect itself failed, so nothing was sent. EINVAL: a socket path over the system's limit (104 bytes on macOS).
// Node 24 emits that EINVAL on the socket and then ECONNRESET on the request. The socket's code is the one that counts.
const NOT_SENT = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTDIR", "ENOTSOCK", "EINVAL", "ENAMETOOLONG"]);

function dialing(): { agent: Agent; code(): string } {
  const seen = { code: "" };
  const agent = new Agent({ keepAlive: false });
  const open = agent.createConnection.bind(agent);
  agent.createConnection = (options, callback) => {
    const socket = open(options, callback);
    if (socket) socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code) seen.code = error.code; });
    return socket;
  };
  return { agent, code: () => seen.code };
}
const MAX_ANSWER_BYTES = 8 << 20;           // the largest JSON answer read: every node's lanes, say
const DEFAULT_TIMEOUT_MS = 5000;
// The fleet answers an op's deadline itself (`timeout`, counted from when it queued the op); the client waits that long
// plus this, so a slow node is the fleet's `timeout`, and only a fleet that doesn't answer at all is FleetUnavailable.
const ANSWER_SLACK_MS = 2000;
// deliver() and cancelDelivery(): the fleet waits up to LIMITS.deliveryOpTimeoutMs for the node's answer to lane.deliver
// and delivery.cancel, then answers itself; the client waits that long plus the slack, so only a fleet that never
// answers leaves a delivery in doubt (review #1).
const DELIVERY_ANSWER_MS = LIMITS.deliveryOpTimeoutMs + ANSWER_SLACK_MS;
// A client's name (§8): a-z, at most 16 letters. Not a credential (the socket's directory is the boundary), but checked
// here, so a header never carries anything else.
const CLIENT_NAME = /^[a-z]{1,16}$/;
const FILE_IDLE_MS = 30_000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const STATUSES = new Set<string>(["online", "stale", "offline"]);
const EVENTS = new Set<string>(["inventory", "health", "status", "conflict", "alert", "delivery", "lane", "job", "run"]);
// "unrouted_hook": hook events for a script path no subscriber takes (ADR-0012 decision 8; detail { path, events }).
// "delivery_waiting" and "subscriber_lagging": fleet clients §4.5, §6. "job_failed" and "job_unnoticed": ADR-0017.
// "engine_fallback": ADR-0027. "draft_stashed": a lane's unsent draft put away so its deliveries went in (#64).
const ALERT_KINDS = new Set<string>(["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter",
  "backlog_full", "unrouted_hook", "delivery_waiting", "subscriber_lagging", "job_failed", "job_unnoticed", "engine_fallback", "draft_stashed"] satisfies AlertKind[]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A store sequence as the fleet passes it on, or null: absent, null, or not a count (never guessed at).
const seqOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
// An op's error as the fleet sent it, or null when it isn't one. A code this hub doesn't know (a newer fleet's) reads as
// the protocol reads it, "internal" and "maybe", so the answer still carries its store and a send in doubt can be settled.
const opErrorOf = (v: unknown): OpError | null =>
  isRecord(v) && typeof v.code === "string" && (v.executed === "no" || v.executed === "maybe") && typeof v.message === "string"
    ? readOpError(v.code, v.executed, v.message) : null;
const isNode = (v: unknown): v is FleetNode =>
  isRecord(v) && typeof v.name === "string" && typeof v.status === "string" && STATUSES.has(v.status)
  && (v.health === null || isRecord(v.health)) && (v.agent === null || typeof v.agent === "string")
  && (v.commit === undefined || v.commit === null || typeof v.commit === "string");
const isLane = (v: unknown): v is FleetLane =>
  isRecord(v) && typeof v.name === "string" && typeof v.node === "string" && (v.workerId === null || typeof v.workerId === "string")
  && typeof v.conflict === "boolean";
// An alert's shape; its kind may be one a newer fleet added.
const isAlert = (v: unknown): v is Omit<Alert, "kind"> & { kind: string } =>
  isRecord(v) && typeof v.id === "number" && typeof v.at === "number" && (v.node === null || typeof v.node === "string")
  && typeof v.kind === "string" && isRecord(v.detail);
// A delivery with its `stale` (the fleet's word on its node), or null when it isn't one.
const fleetDelivery = (delivery: unknown, stale: unknown): FleetDelivery | null => {
  const d = parseBody(DeliverySchema, delivery);
  return d && typeof stale === "boolean" ? { ...d, stale } : null;
};
const seg = (s: string) => encodeURIComponent(s);

export class FleetClient {
  readonly #socketPath: string;
  readonly #log: FleetLog;
  readonly #headers: Record<string, string>;

  // `client`: the name this client gives the fleet (x-morndo-client), "hub" unless given; one that isn't a-z, at most 16
  // letters, throws TypeError.
  constructor(socketPath: string, o: { client?: string; log?: FleetLog } = {}) {
    const client = o.client ?? "hub";
    if (!CLIENT_NAME.test(client)) throw new TypeError(`a client name is a-z, at most 16 letters: ${JSON.stringify(client)}`);
    this.#socketPath = socketPath;
    this.#log = o.log ?? STDERR_LOG;
    this.#headers = { "x-morndo-client": client };
  }

  // The API versions the fleet takes, and its sticky lane names (fleet clients §4.1, Review Focus 5). A fleet from before
  // sticky lanes sends none: it makes no lane sticky.
  async caps(): Promise<{ api: number[]; stickyLanes: string[] }> {
    const v = await this.#json("GET", "/v1/caps");
    if (!isRecord(v) || !Array.isArray(v.api) || !v.api.every(n => Number.isInteger(n))) throw new FleetMismatch("GET /v1/caps: not a capability list");
    const sticky = v.stickyLanes === undefined ? [] : v.stickyLanes;
    if (!Array.isArray(sticky) || !sticky.every(n => typeof n === "string")) throw new FleetMismatch("GET /v1/caps: stickyLanes is not a list of lane names");
    return { api: v.api as number[], stickyLanes: sticky as string[] };
  }

  async nodes(): Promise<FleetNode[]> {
    const v = await this.#json("GET", "/v1/nodes");
    if (!Array.isArray(v) || !v.every(isNode)) throw new FleetMismatch("GET /v1/nodes: not a node list");
    return v;
  }

  // The fleet's job mirror (design §7). Unknown fields on a row are dropped by the schema.
  async jobs(): Promise<JobsList> {
    const v = await this.#json("GET", "/v1/jobs");
    const parsed = JobsListSchema.safeParse(v);
    if (!parsed.success) throw new FleetMismatch("GET /v1/jobs: not a job list");
    return parsed.data;
  }

  async lanes(): Promise<FleetLane[]> {
    const v = await this.#json("GET", "/v1/lanes");
    if (!Array.isArray(v) || !v.every(isLane)) throw new FleetMismatch("GET /v1/lanes: not a lane list");
    return v;
  }

  // What the fleet raised for the owner (plan.md, "Alerts"): the latest 500, oldest first. A kind this hub doesn't know
  // (a newer fleet's) is left out, as an event of a kind it doesn't know is.
  async alerts(): Promise<Alert[]> {
    const v = await this.#json("GET", "/v1/alerts");
    if (!Array.isArray(v) || !v.every(isAlert)) throw new FleetMismatch("GET /v1/alerts: not an alert list");
    return v.filter((a): a is Alert => ALERT_KINDS.has(a.kind));
  }

  // One typed op (spec §5.3). The result's fields are checked by whoever reads them; the envelope is checked here. The
  // delivery ops are never sent as ops: they go through deliver() and cancelDelivery(), whose routes resolve the target
  // and keep the fleet's mirror, and the fleet refuses them on /v1/op (bad_args).
  async op<O extends ClientOp>(target: OpTarget, op: O, args: OpArgs[O], opts: { key?: string; timeoutMs?: number } = {}): Promise<OpAnswer<O>> {
    if (DELIVERY_OPS.has(op)) throw new TypeError(`${op} goes through deliver() or cancelDelivery(), never POST /v1/op`);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = { ...target, op, args, timeoutMs, ...(opts.key !== undefined ? { key: opts.key } : {}) };
    // The fleet took the op, so an answer that isn't JSON at all (an HTML 502, say) leaves it in doubt as well (#outcome).
    const v = (await this.#outcome("POST", "/v1/op", body, timeoutMs + ANSWER_SLACK_MS)).value;
    if (isRecord(v) && v.ok === true && "result" in v && typeof v.store === "string") {
      return { ok: true, result: v.result as OpResult[O], invVersion: typeof v.invVersion === "number" ? v.invVersion : 0, store: v.store, storeSeq: seqOf(v.storeSeq) };
    }
    const error = isRecord(v) && v.ok === false ? opErrorOf(v.error) : null;
    if (isRecord(v) && error) {
      return { ok: false, error, store: typeof v.store === "string" ? v.store : null, storeSeq: seqOf(v.storeSeq) };
    }
    // The fleet took the op, so a malformed answer leaves it in doubt (it may have run): never a plain mismatch.
    throw new FleetUnavailable(`POST /v1/op ${op}: not an op answer`, true);
  }

  // A message to a lane through the delivery queue on its node (fleet clients §4, §8): the delivery once stored. Its id is
  // the client's own, namespaced like a key ("kira:…"), and its idempotency: the same id with the same target and text
  // answers the same delivery. No answer throws FleetUnavailable: `reached: false` when nothing left this process (nothing
  // was queued); `reached: true` when the request went out and no answer came, so the delivery is in doubt, and the caller
  // sends the same id again, never types the text itself (ruling 49). A refusal (lane_conflict, node_offline,
  // id_conflict, no_session, no_pane, bad_args) throws FleetOpFailed; nothing was queued. `uncertain` is the fleet's own
  // word that it may have been: in doubt as well.
  async deliver(d: { id: string; text: string; ttlMs?: number } & ({ lane: string } | { workerId: string })): Promise<Delivery> {
    const body = { id: d.id, ...("lane" in d ? { lane: d.lane } : { workerId: d.workerId }), text: d.text, ...(d.ttlMs === undefined ? {} : { ttlMs: d.ttlMs }) };
    return this.#delivered("deliver", (await this.#outcome("POST", "/v1/deliveries", body, DELIVERY_ANSWER_MS)).value);
  }

  // One delivery's latest state as the fleet keeps it, or null when it knows none of that id.
  async delivery(id: string): Promise<FleetDelivery | null> {
    const { status, value } = await this.#request("GET", `/v1/deliveries/${seg(id)}`);
    if (status === 404) return null;
    const d = isRecord(value) ? fleetDelivery(value.delivery, value.stale) : null;
    if (!d) throw new FleetMismatch("GET /v1/deliveries/<id>: not a delivery");
    return d;
  }

  // The deliveries of the last 7 days, by lane and state.
  async deliveries(q: { lane?: string; state?: DeliveryState } = {}): Promise<FleetDelivery[]> {
    const query = new URLSearchParams({ ...(q.lane === undefined ? {} : { lane: q.lane }), ...(q.state === undefined ? {} : { state: q.state }) }).toString();
    const v = await this.#json("GET", `/v1/deliveries${query ? `?${query}` : ""}`);
    const list = isRecord(v) && Array.isArray(v.deliveries) ? v.deliveries.map(x => (isRecord(x) ? fleetDelivery(x, x.stale) : null)) : null;
    if (!list || list.some(x => x === null)) throw new FleetMismatch("GET /v1/deliveries: not a delivery list");
    return list as FleetDelivery[];
  }

  // Gives up a delivery still queued; one already typed is refused already_typed (FleetOpFailed). null: the fleet knows
  // no delivery of that id (404 no_such_delivery), as delivery(id) answers.
  async cancelDelivery(id: string): Promise<Delivery | null> {
    const { status, value } = await this.#outcome("POST", `/v1/deliveries/${seg(id)}/cancel`, {}, DELIVERY_ANSWER_MS);
    if (status === 404 && isRecord(value) && value.error === "no_such_delivery") return null;
    return this.#delivered("cancelDelivery", value);
  }

  // Lane events (fleet clients §7) after the sequence `since` (the fleet's own), oldest first, at most 1000 per answer.
  async laneEvents(since?: number): Promise<LaneEvent[]> {
    const v = await this.#json("GET", `/v1/lane-events${since === undefined ? "" : `?since=${since}`}`);
    const events = isRecord(v) && Array.isArray(v.events) ? v.events.map(e => parseBody(LaneEventSchema, e)) : null;
    if (!events || events.some(e => e === null)) throw new FleetMismatch("GET /v1/lane-events: not a list of lane events");
    return events as LaneEvent[];
  }
  // Each lane's last turn as the fleet's lane watch holds it (GET /v1/lane-watch, reliable lanes §3.2), oldest first.
  async laneWatch(): Promise<LaneWatchEntry[]> {
    const v = await this.#json("GET", "/v1/lane-watch");
    const ok = (e: unknown) => isRecord(e) && typeof e.node === "string" && typeof e.window === "string" && typeof e.at === "number"
      && (e.deadline === null || typeof e.deadline === "number") && typeof e.stale === "boolean" && typeof e.stalls === "number";
    if (!isRecord(v) || !Array.isArray(v.lanes) || !v.lanes.every(ok)) throw new FleetMismatch("GET /v1/lane-watch: not a lane watch");
    return v.lanes as LaneWatchEntry[];
  }
  // Each lane's Run (GET /v1/runs, ADR-0032), by lane. A Run this client can't read (a newer fleet's phase or wait) is
  // left out, as an alert of a kind it doesn't know is.
  async runs(): Promise<RunView[]> {
    const v = await this.#json("GET", "/v1/runs");
    if (!isRecord(v) || !Array.isArray(v.runs)) throw new FleetMismatch("GET /v1/runs: not a list of runs");
    return v.runs.map(r => parseBody(RunViewSchema, r)).filter((r): r is RunView => r !== null);
  }
  // A file on a node, streamed (GET /v1/files): the fleet reads it in chunks of at most 256 KiB under the node's rules.
  async *fileStream(node: string, refOrPath: string): AsyncIterable<Uint8Array> {
    const path = `/v1/files/${encodeURIComponent(node)}/${encodeURIComponent(refOrPath)}`;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const dial = dialing();
      const req = request({ socketPath: this.#socketPath, agent: dial.agent, method: "GET", path, headers: this.#headers }, resolve);
      req.setTimeout(FILE_IDLE_MS, () => req.destroy(new Error(`no data for ${FILE_IDLE_MS} ms`)));
      req.on("error", (e: NodeJS.ErrnoException) => reject(new FleetUnavailable(`GET /v1/files: ${e.message}`, !NOT_SENT.has(dial.code() || e.code || ""), { cause: e })));
      req.end();
    });
    try {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of res) {
          size += (c as Buffer).length;
          if (size > 65_536) break;
          chunks.push(c as Buffer);
        }
        let v: unknown = null;
        try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON: not the client API */ }
        const refused = isRecord(v) && v.ok === false ? opErrorOf(v.error) : null;
        if (refused) throw new FleetOpFailed(`file on ${node}`, refused);
        throw new FleetMismatch(`GET /v1/files: answered ${res.statusCode ?? "nothing"}`);
      }
      // The real route sends `x-file-size` and destroys the response on any failure; this client doesn't depend on that:
      // a body that isn't exactly that long never ends cleanly, so a caller storing what it read never keeps a part.
      const header = res.headers["x-file-size"];
      const expected = typeof header === "string" && /^\d+$/.test(header) ? Number(header) : -1;
      if (!Number.isSafeInteger(expected) || expected < 0) throw new FleetMismatch(`GET /v1/files: x-file-size is ${JSON.stringify(header ?? null)}`);
      let got = 0;
      try {
        for await (const chunk of res) {
          got += (chunk as Buffer).length;
          if (got > expected) throw new FleetMismatch(`GET /v1/files: more than the ${expected} bytes of x-file-size`);
          yield chunk as Buffer;
        }
      } catch (e) {
        if (e instanceof FleetMismatch) throw e;
        throw new FleetUnavailable(`GET /v1/files: ${(e as Error).message}`, true, { cause: e });
      }
      if (got !== expected) throw new FleetUnavailable(`GET /v1/files: ended after ${got} of ${expected} bytes`, true);
    } finally {
      res.destroy();
    }
  }

  // The fleet's events (spec §5.6: inventory, health, node status, conflicts, alerts; deliveries, lane events, jobs and
  // runs), until the returned function is called.
  // A closed socket is opened again after 1, 2, 5, 10, then every 30 s, each with jitter. The fleet replays only each
  // node's status, inventory and health, the jobs and every lane's Run on a new subscription; an `alert` or `conflict`
  // event sent meanwhile is not replayed. `onOpen` runs after every successful open, the first and each reconnect, so a
  // consumer can read nodes(), lanes() and alerts() again.
  events(on: (e: FleetEvent) => void, o: { onOpen?: () => void | Promise<void> } = {}): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: NodeJS.Timeout | null = null;
    let failures = 0;
    const connect = () => {
      if (stopped) return;
      // Dialed through createConnection with the socket's raw path, as every HTTP request is: an IPC URL would carry the
      // path through new URL(), which percent-encodes a space or a non-ASCII letter, cuts it at ':' and throws on '#'.
      const ws = new WebSocket("ws://fleet/v1/events", { maxPayload: MAX_ANSWER_BYTES, headers: this.#headers, createConnection: () => createConnection(this.#socketPath) });
      socket = ws;
      ws.on("open", () => {
        failures = 0;
        try { void Promise.resolve(o.onOpen?.()).catch(e => this.#log.error("fleet events: onOpen failed", e)); }
        catch (e) { this.#log.error("fleet events: onOpen failed", e); }
      });
      // A frame arrives as a Buffer (ws's default binaryType "nodebuffer").
      ws.on("message", (raw: Buffer) => {
        let v: unknown;
        try { v = JSON.parse(raw.toString("utf8")); } catch { this.#log.warn("fleet events: a frame that isn't JSON, ignored"); return; }
        if (!isRecord(v) || typeof v.t !== "string" || typeof v.node !== "string" || !("body" in v)) { this.#log.warn("fleet events: a frame of an unknown shape, ignored"); return; }
        if (!EVENTS.has(v.t)) return;                                 // a kind a newer fleet added
        let e: FleetEvent;
        if (v.t === "delivery" || v.t === "lane") {
          const body = v.t === "delivery" ? (isRecord(v.body) ? fleetDelivery(v.body, v.body.stale) : null) : parseBody(LaneEventSchema, v.body);
          if (!body) { this.#log.warn(`fleet events: a ${v.t} event of an unknown shape, ignored`); return; }
          e = v.t === "delivery" ? { t: "delivery", node: v.node, body: body as FleetDelivery } : { t: "lane", node: v.node, body: body as LaneEvent };
        } else if (v.t === "run") {
          const body = parseBody(RunViewSchema, v.body);
          if (!body) { this.#log.warn("fleet events: a run event of an unknown shape, ignored"); return; }
          e = { t: "run", node: v.node, body };
        } else {
          e = { t: v.t as "inventory" | "health" | "status" | "conflict" | "alert" | "job", node: v.node, body: v.body };
        }
        try { on(e); }
        catch (x) { this.#log.error("fleet events: a listener failed", x); }
      });
      ws.on("error", e => this.#log.warn(`fleet events: ${e.message}`));
      ws.on("close", () => {
        socket = null;
        if (stopped) return;
        const base = RECONNECT_MS[Math.min(failures++, RECONNECT_MS.length - 1)] ?? 30_000;
        // Referenced: a process whose only work is this stream (morndo lanes events) must stay up to reconnect.
        // Unsubscribe clears the timer, so a short-lived caller still exits.
        timer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
      });
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.terminate();
    };
  }

  // A side effect's answer (POST /v1/op, the delivery routes): its outcome is in the body whatever the status, and the
  // fleet took the request, so an answer that isn't JSON at all (an HTML 502, say) leaves it in doubt as well.
  async #outcome(method: "POST", path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS + ANSWER_SLACK_MS): Promise<{ status: number; value: unknown }> {
    try { return await this.#request(method, path, body, timeoutMs, true); }
    catch (e) {
      if (e instanceof FleetMismatch) throw new FleetUnavailable(e.message, true, { cause: e });
      throw e;
    }
  }

  // The delivery a delivery route answers with, or its refusal thrown as FleetOpFailed; anything else leaves it in doubt.
  #delivered(what: string, v: unknown): Delivery {
    const d = isRecord(v) && v.ok === true ? parseBody(DeliverySchema, v.delivery) : null;
    if (d) return d;
    const error = isRecord(v) && v.ok === false ? opErrorOf(v.error) : null;
    if (error) throw new FleetOpFailed(what, error);
    throw new FleetUnavailable(`${what}: not a delivery answer`, true);
  }

  // A JSON request's body. A read route's 5xx is the fleet failing (FleetUnavailable).
  async #json(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return (await this.#request(method, path, body, timeoutMs)).value;
  }

  // A JSON request: its status and its body. `outcome`: a route whose refusals carry their outcome in the body, read
  // whatever the status; any other route's 5xx is FleetUnavailable.
  #request(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS, outcome = false): Promise<{ status: number; value: unknown }> {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const dial = dialing();
      const req = request({
        socketPath: this.#socketPath, agent: dial.agent, method, path,
        headers: data ? { ...this.#headers, "content-type": "application/json", "content-length": String(data.length) } : this.#headers,
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) { req.destroy(new Error(`an answer over ${MAX_ANSWER_BYTES} bytes`)); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          if ((res.statusCode ?? 200) >= 500 && !outcome) {            // a side effect's refusal carries its outcome in the body, whatever the status
            reject(new FleetUnavailable(`${method} ${path}: answered ${res.statusCode}`, true)); return; }
          try { resolve({ status: res.statusCode ?? 200, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch { reject(new FleetMismatch(`${method} ${path}: answered ${res.statusCode ?? "nothing"} without JSON`)); }
        });
        res.on("error", e => reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, true, { cause: e })));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      req.on("error", (e: NodeJS.ErrnoException) => reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, !NOT_SENT.has(dial.code() || e.code || ""), { cause: e })));
      req.end(data ?? undefined);
    });
  }
}

// Whether the fleet at this socket speaks this hub's client API (spec §5.6: GET /v1/caps lists the versions it takes).
export async function checkFleet(client: FleetClient): Promise<"ok" | "unsupported" | "unreachable"> {
  try { return (await client.caps()).api.includes(CLIENT_API) ? "ok" : "unsupported"; }
  catch (e) { return e instanceof FleetMismatch ? "unsupported" : "unreachable"; }
}
