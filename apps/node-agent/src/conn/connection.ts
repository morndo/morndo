// The agent's one connection to the fleet service (spec §5.2), kept up for the life of the process.
// - Mutual authentication on every connection: `hello` with a fresh client nonce; the fleet's `challenge` must carry
//   its signature over that nonce under the key pinned at join, or the agent closes without proving anything; then
//   the agent's `proof`; then `welcome`.
// - `instanceId` is random per process and the same on every reconnect, so the fleet can tell a reconnect (replaces
//   the old connection) from a second agent with the same key (refused with 4409 while the live one answers the
//   fleet's ping).
// - Close codes: 4401 (bad proof) and 4403 (revoked or unknown) stop the dialing, since a retry would be refused the
//   same way. 4409 keeps `status: conflict` and tries again every LIMITS.conflictRetryMs (5 minutes, ±20 % jitter): a
//   live twin keeps refusing it, and once the other instance is gone (stopped, crashed, half-open) this one takes over.
//   4426 (protocol unsupported) retries hourly; lanes and hooks keep working meanwhile. Anything else (1013, too many
//   handshakes, included) dials again with backoff (retry.ts).
// - Liveness: the fleet pings every 15 s; with no ping for 50 s (LIMITS.agentPingTimeoutMs: three pings and slack) the
//   agent terminates the socket and dials again (ws 8.22.0 README, "How to detect and close broken connections?", read
//   2026-10-06).
// - The URL must pass fleetUrlOk: wss://, or ws:// only to this machine. Any other is refused when the connection is
//   made, before any dial: the agent never authenticates over a network in the clear.
// - A message that is not JSON, not of protocol version 1, or of a type the agent doesn't know closes the connection
//   (1008): nothing from the fleet is silently ignored. A malformed `req` with an id is answered instead (onBadRequest).
// - The agent may turn a welcome down (`admit` answers false: its database was restored, and it has just started a new
//   store). The connection never goes online: it is terminated at once, nothing that came after the welcome on it is
//   handed on (no `req` runs under the old store), and it dials again, naming the new store.
import { randomBytes, type KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import { CLOSE, FleetMessage, LIMITS, fleetSigPayload, fleetUrlOk, nodeSigPayload, parseBody, type AgentMessage, type RolloutWire } from "@morndo/protocol";
import { signedBy } from "../identity.ts";
import type { Logger } from "../log.ts";
import { AGENT_COMMIT, AGENT_VERSION, PROTO_VERSIONS } from "../version.ts";
import { wsText } from "../ws-text.ts";
import { RetrySchedule, type RetryOptions } from "./retry.ts";
import { SendQueue, type Lane } from "./send-queue.ts";
import type { ConnState, ConnStatus } from "./status-file.ts";

export type ReqMessage = Extract<FleetMessage, { t: "req" }>;
export type AckMessage = Extract<FleetMessage, { t: "ack" }>;
// A welcome's own words (updates §7), beside its stream bookkeeping: the build this fleet's control plane runs,
// the Rollout as it stands, and the offer the fleet made this node (§5.4). Optional as the wire has them: a fleet
// from before the updates design says none of them.
export type Welcomed = {
  connEpoch: number; ackSeq: number; streamKnown: boolean; storeSeqSeen?: number;
  controlPlane?: { version: string; commit: string | null };
  rollout?: RolloutWire | null;
  offer?: { version: string; attempt: string };
};

export const UNSUPPORTED_RETRY_MS = 3_600_000;
export const CONFLICT_SPREAD = 0.2;                       // a refused second instance retries 5 minutes ± 20 %

export type ConnectionOptions = {
  url: string;
  node: string;
  instanceId: string;
  streamId: string;
  fleetKey: KeyObject;
  nodeKey: { sign(payload: string): string };
  caps: string[];
  claudeVersion: () => string | null;
  log: Logger;
  admit?(w: Welcomed): boolean;                            // false: don't go online on this connection; dial again
  onWelcome(w: Welcomed): void;
  onRequest(m: ReqMessage): void;
  onBadRequest(id: string, op: unknown): void;
  onAck(m: AckMessage): void;
  // The Rollout as it stands, on every change of it, with the offer that frame made this node (§5.4): absent when
  // the frame carried none — an offer dies with the word that last said it.
  onRollout?(r: RolloutWire, offer?: { version: string; attempt: string }): void;
  onDown(): void;
  onStatus(s: ConnStatus): void;
  retry?: RetryOptions;
  pingTimeoutMs?: number;
  unsupportedRetryMs?: number;
};

export class FleetConnection {
  #o: ConnectionOptions;
  #retry: RetrySchedule;
  #ws: WebSocket | null = null;
  #queue: SendQueue | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #stopping = false;
  #status: ConnStatus = { state: "stopped", since: Date.now(), connEpoch: null, lastClose: null, retryInMs: null };

  constructor(o: ConnectionOptions) {
    if (!fleetUrlOk(o.url)) throw new TypeError(`the fleet URL must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1]); not dialing ${o.url}`);
    this.#o = o;
    this.#retry = new RetrySchedule(o.retry);
  }

  status(): ConnStatus { return { ...this.#status, retryInMs: this.#retry.retryInMs() }; }
  get online(): boolean { return this.#queue !== null; }

  start(): void {
    this.#stopping = false;
    this.#dial();
  }

  // Queues a message on the live connection: false when there is none, or when the message is over the 512 KiB limit.
  send(msg: AgentMessage, lane: Lane = "control"): boolean {
    if (!this.#queue) return false;
    const data = JSON.stringify(msg);
    const bytes = Buffer.byteLength(data);
    if (bytes > LIMITS.maxMessageBytes) {
      this.#o.log.warn(`not sending a ${msg.t} message of ${bytes} bytes (the limit is ${LIMITS.maxMessageBytes})`);
      return false;
    }
    this.#queue.push(data, lane);
    return true;
  }

  // Cuts the live socket without a close handshake (the test hook dropAfterStarted, test-hooks.ts). The close that
  // follows is an ordinary one: the agent backs off and dials again as the same instance.
  drop(): void { this.#ws?.terminate(); }

  // The stream the next hello names (agent.ts rotates it for a restored database, then drops the connection).
  setStreamId(id: string): void { this.#o = { ...this.#o, streamId: id }; }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#retry.cancel();
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) { this.#set("stopped"); return; }
    const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
    ws.close(1001, "agent stopping");
    const force = setTimeout(() => ws.terminate(), 2000);
    await closed;
    clearTimeout(force);
  }

  // `since` is when the state began: a retry that ends in the same state (conflict, say) keeps it.
  #set(state: ConnState, extra: Partial<ConnStatus> = {}): void {
    this.#status = { ...this.#status, ...extra, state, since: state === this.#status.state ? this.#status.since : Date.now() };
    this.#o.onStatus(this.status());
  }

  // The watchdog that fires while this process was busy (a durable commit held the thread, T-532) decides in a
  // setImmediate: a ping that arrived while it was busy is read in the poll phase before that, and re-arms the
  // watchdog, so only a fleet that stayed silent through it ends the connection. A watchdog that was rearmed, or
  // disarmed by a close, is not this timer object any more.
  #arm(ws: WebSocket): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    const timeoutMs = this.#o.pingTimeoutMs ?? LIMITS.agentPingTimeoutMs;
    const timer = setTimeout(() => {
      setImmediate(() => {
        if (this.#watchdog !== timer) return;            // re-armed or disarmed since it fired
        this.#o.log.warn(`no ping from the fleet for ${Math.round(timeoutMs / 1000)} s; dialing again`);
        ws.terminate();
      });
    }, timeoutMs);
    this.#watchdog = timer;
  }

  #disarm(): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  #dial(): void {
    const o = this.#o;
    // A refused second instance stays "conflict" while it asks again: status keeps saying what is wrong.
    if (this.#status.state !== "conflict") this.#set("connecting", { connEpoch: null });
    const ws = new WebSocket(o.url, { maxPayload: LIMITS.maxPayload, handshakeTimeout: 10_000 });
    this.#ws = ws;
    const clientNonce = randomBytes(32).toString("base64url");
    let phase: "hello" | "proof" | "online" | "turned down" = "hello";
    const protocolError = (what: string) => {
      o.log.warn(`the fleet sent ${what}; closing the connection`);
      ws.close(1008, "protocol error");
    };
    const raw = (msg: AgentMessage) => ws.send(JSON.stringify(msg));

    ws.on("open", () => {
      this.#arm(ws);
      raw({
        v: 1, t: "hello", node: o.node, instanceId: o.instanceId, streamId: o.streamId, proto: PROTO_VERSIONS,
        agent: { version: AGENT_VERSION, ...(AGENT_COMMIT !== null ? { commit: AGENT_COMMIT } : {}) }, claude: { version: o.claudeVersion() }, caps: o.caps, clientNonce,
      });
    });
    ws.on("ping", () => this.#arm(ws));
    ws.on("message", data => {
      if (phase === "turned down") return;                 // after a welcome the agent turned down: nothing is handed on
      let value: unknown;
      try { value = JSON.parse(wsText(data)); } catch { protocolError("a message that is not JSON"); return; }
      const msg = parseBody(FleetMessage, value);
      if (!msg) {
        const r = (value ?? {}) as { t?: unknown; id?: unknown; op?: unknown };
        if (phase === "online" && r.t === "req" && typeof r.id === "string") { o.onBadRequest(r.id, r.op); return; }
        protocolError(`a malformed or unknown message (${typeof r.t === "string" ? r.t.slice(0, 40) : "no type"})`);
        return;
      }
      switch (msg.t) {
        case "challenge": {
          if (phase !== "hello") { protocolError("a challenge out of turn"); return; }
          if (!signedBy(o.fleetKey, fleetSigPayload(o.node, clientNonce), msg.fleetSig)) {
            o.log.error("the fleet's signature does not match the fleet key pinned at join; closing without a proof");
            ws.close(1008, "bad fleet signature");
            return;
          }
          phase = "proof";
          raw({ v: 1, t: "proof", sig: o.nodeKey.sign(nodeSigPayload(o.node, msg.nonce)) });
          return;
        }
        case "welcome": {
          if (phase !== "proof") { protocolError("a welcome out of turn"); return; }
          const w: Welcomed = {
            connEpoch: msg.connEpoch, ackSeq: msg.ackSeq, streamKnown: msg.streamKnown,
            ...(msg.storeSeqSeen === undefined ? {} : { storeSeqSeen: msg.storeSeqSeen }),
            ...(msg.controlPlane === undefined ? {} : { controlPlane: msg.controlPlane }),
            ...(msg.rollout === undefined ? {} : { rollout: msg.rollout }),
            ...(msg.offer === undefined ? {} : { offer: msg.offer }),
          };
          this.#retry.reset();
          if (o.admit && !o.admit(w)) { phase = "turned down"; ws.terminate(); return; }   // decided before going online
          phase = "online";
          this.#queue = new SendQueue({ send: (d, cb) => ws.send(d, cb) });
          this.#set("online", { connEpoch: msg.connEpoch, lastClose: null });
          o.onWelcome(w);
          return;
        }
        case "req":
          if (phase !== "online") { protocolError("a request before welcome"); return; }
          o.onRequest(msg);
          return;
        case "ack":
          if (phase !== "online") { protocolError("an ack before welcome"); return; }
          o.onAck(msg);
          return;
        case "rollout":
          // The Rollout as it stands (updates §7), on every change of it: only to agents whose hello said
          // CAP_ROLLOUT. Before the updates design this agent ignored the frame; now it hands it on, and a frame
          // from before the welcome is the protocol error a req there would be.
          if (phase !== "online") { protocolError("a rollout before welcome"); return; }
          o.onRollout?.(msg.rollout, msg.offer);
          return;
      }
    });
    ws.on("error", e => o.log.debug(`connection error: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    ws.on("close", (code, reason) => this.#closed(ws, code, reason.toString("utf8").slice(0, 120)));
  }

  #closed(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#ws) return;
    this.#disarm();
    this.#ws = null;
    const wasOnline = this.#queue !== null;
    this.#queue?.close();
    this.#queue = null;
    if (wasOnline) this.#o.onDown();
    const lastClose = { code, reason };
    const log = this.#o.log;
    if (this.#stopping) { this.#set("stopped", { lastClose, connEpoch: null }); return; }
    if (code === CLOSE.badProof || code === CLOSE.forbidden) {
      log.error(`the fleet refused this node (${code}${reason ? ` ${reason}` : ""}): it was revoked, is unknown, or its key is not the one the fleet holds. Not dialing again; join again with a new code.`);
      this.#set("refused", { lastClose, connEpoch: null });
      return;
    }
    if (code === CLOSE.conflict) {
      const wait = this.#retry.afterAbout(LIMITS.conflictRetryMs, CONFLICT_SPREAD, () => this.#dial());
      if (this.#status.state !== "conflict") {
        log.error(`the fleet refused this agent (4409): another agent with this node's key is connected. Lanes keep running; trying again every ${Math.round(LIMITS.conflictRetryMs / 60_000)} min (next in ${Math.round(wait / 1000)} s); see morndo-node status.`);
      }
      this.#set("conflict", { lastClose, connEpoch: null });
      return;
    }
    if (code === CLOSE.unsupported) {
      log.error(`the fleet does not speak this agent's protocol (4426); lanes keep running, trying again in ${Math.round((this.#o.unsupportedRetryMs ?? UNSUPPORTED_RETRY_MS) / 60_000)} min.`);
      this.#retry.after(this.#o.unsupportedRetryMs ?? UNSUPPORTED_RETRY_MS, () => this.#dial());
      this.#set("unsupported", { lastClose, connEpoch: null });
      return;
    }
    const delay = this.#retry.backoff(() => this.#dial());
    log.info(`connection to the fleet closed (${code}); dialing again in ${delay} ms`);
    this.#set("backoff", { lastClose, connEpoch: null });
  }
}
