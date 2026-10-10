// Requests the fleet sends to agents and the results it waits for (spec 5.2, 5.3, 7). Each request id is
// "<connEpoch>.<n>", unique per node, and a result is matched by (node, id) and by the agent instance it was sent to:
//   - a result from the same instance is accepted, even on a newer connection of that instance (a reconnect), until
//     the request's deadline (spec 5.2: "Results arriving late from the same instance are still accepted");
//   - a result for an id that is no longer waiting, or from another instance (an older connEpoch of another agent
//     process), is dropped and never closes the connection (spec 9, contract: "an old connEpoch is ignored");
//   - a result is checked against OP_RESULTS[op] once its id is matched: one that doesn't fit is internal (executed:
//     maybe; the node said it ran), never handed on;
//   - when the connection drops, a read fails at once with node_offline (executed: no); a side-effecting op waits for
//     the same instance until its deadline, then answers uncertain (executed: maybe); another instance taking over
//     answers it uncertain at once, since the process that held it is gone;
//   - a deadline the agent never answered: timeout (executed: no) for a read, uncertain for a side-effecting op;
//   - a request over LIMITS.maxMessageBytes is refused too_large and never sent: past the agent's maxPayload it would
//     close the node's whole connection (spec 5.2).
// Every outcome carries `store` (plan Contracts, "Behaviour"): the agent's res.store on its answers; on the fleet's own
// answer to a request it sent (a deadline, a dropped connection, a result that doesn't fit), the store of the
// connection the request went out on (its hello.streamId); null for a refusal before anything was sent.
// And `storeSeq` beside it (final review I2, the store sequence): the agent's res.storeSeq on its answers, exactly as it
// sent it (null from an agent that sends none), so op.status's says where that database is now. On the fleet's own
// answer to a request it sent, the highest storeSeq any answer from that node's store has shown (null if none): a number
// that database certainly reached, so never more than it holds unless it went backwards, and a send whose answer was
// lost still carries what the hub needs to tell a database put back from an older copy. Null for a refusal before
// anything was sent. Every res's storeSeq is handed to `seqs` (fleet.db's store_seqs, which the welcome reads too).
// Deadlines run on setTimeout, which is monotonic in Node.js, so a wall-clock jump never fires or delays one.
import {
  ERROR_EXECUTED, KEYED_OPS, LIMITS, OP_RESULTS, parseBody, type AgentMessage, type ErrorCode, type FleetMessage, type OpError, type OpName,
} from "@morndo/protocol";

export type Outcome = { ok: true; result: unknown; invVersion: number; store: string; storeSeq: number | null }
  | { ok: false; error: OpError; store: string | null; storeSeq: number | null };
export type Res = Extract<AgentMessage, { t: "res" }>;
// `store`: the stream id the connection's hello named, the agent database the request goes to.
export type Channel = { node: string; instanceId: string; id: string; store: string; send(m: FleetMessage): void };

export const opError = (code: ErrorCode, message: string): OpError => ({ code, executed: ERROR_EXECUTED[code], message });
// A refusal; `store` and `storeSeq` only when the request was sent to a node (null: nothing was sent).
export const failed = (code: ErrorCode, message: string, store: string | null = null, storeSeq: number | null = null): Outcome =>
  ({ ok: false, error: opError(code, message), store, storeSeq });

// Keyed ops, and pane.keys: keystrokes have no key (they are never retried) but are a side effect all the same.
export const SIDE_EFFECT_OPS: ReadonlySet<OpName> = new Set<OpName>([...KEYED_OPS, "pane.keys", "job.cancel", "job.noticeResult"]);
// The ops that move bulk data (up to LIMITS.chunkBytes each): one at a time per connection (spec 5.2).
export const BULK_OPS: ReadonlySet<OpName> = new Set<OpName>(["transcript.read", "file.get", "file.put"]);

// How long past its own deadline the fleet still waits for the agent's answer (network and queueing slack).
export const RESULT_SLACK_MS = 1000;
// The highest storeSeq per (node, store): fleet.db's StoreSeqsStore (spec 5.2: kept across a fleet restart).
export type StoreSeqs = { saw(node: string, store: string, seq: number): void; highest(node: string, store: string): number | null };
type Pending = { node: string; instanceId: string; store: string; op: OpName; sideEffect: boolean; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout> };

export class Requests {
  #pending = new Map<string, Pending>();
  #seqs: StoreSeqs;
  #isLive: (node: string, instanceId: string) => boolean;
  #slackMs: number;

  constructor(isLive: (node: string, instanceId: string) => boolean, slackMs: number, seqs: StoreSeqs) {
    this.#isLive = isLive;
    this.#slackMs = slackMs;
    this.#seqs = seqs;
  }

  get size() { return this.#pending.size; }

  send(ch: Channel, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    const req: FleetMessage = { v: 1, t: "req", id: ch.id, op, args, timeoutMs: o.timeoutMs, ...(o.key === undefined ? {} : { key: o.key }) };
    const size = Buffer.byteLength(JSON.stringify(req));
    if (size > LIMITS.maxMessageBytes) return Promise.resolve(failed("too_large", `${op} to ${ch.node} is ${size} bytes, over the ${LIMITS.maxMessageBytes}-byte message limit`));
    return new Promise<Outcome>(resolve => {
      const k = `${ch.node}\n${ch.id}`;
      const sideEffect = SIDE_EFFECT_OPS.has(op);
      const timer = setTimeout(() => {
        if (!this.#pending.delete(k)) return;
        const seq = this.highestSeq(ch.node, ch.store);
        if (sideEffect) resolve(failed("uncertain", `${op} on ${ch.node}: no answer before the deadline; ask op.status`, ch.store, seq));
        else if (this.#isLive(ch.node, ch.instanceId)) resolve(failed("timeout", `${op} on ${ch.node}: no answer before the deadline`, ch.store, seq));
        else resolve(failed("node_offline", `${op} on ${ch.node}: the node went offline`, ch.store, seq));
      }, o.timeoutMs + this.#slackMs);
      this.#pending.set(k, { node: ch.node, instanceId: ch.instanceId, store: ch.store, op, sideEffect, resolve, timer });
      ch.send(req);
    });
  }

  // The highest storeSeq any answer from `store` of `node` has shown, or null.
  highestSeq(node: string, store: string): number | null { return this.#seqs.highest(node, store); }

  // A result from `instanceId` of `node`: "accepted" when it answered a waiting request of that instance. Its storeSeq
  // counts whatever it answered: that database reached it.
  result(node: string, instanceId: string, res: Res): "accepted" | "unknown" | "foreign" {
    if (res.storeSeq !== undefined) this.#seqs.saw(node, res.store, res.storeSeq);
    const k = `${node}\n${res.id}`;
    const p = this.#pending.get(k);
    if (!p) return "unknown";
    if (p.instanceId !== instanceId) return "foreign";
    this.#pending.delete(k);
    clearTimeout(p.timer);
    const storeSeq = res.storeSeq ?? null;                // the agent's own, as it sent it: never the highest seen
    if (!res.ok) p.resolve({ ok: false, error: res.error, store: res.store, storeSeq });
    else {
      const result = parseBody(OP_RESULTS[p.op], res.result);
      if (result === null) p.resolve(failed("internal", `${p.op} on ${node}: the node's result does not fit the op's shape`, res.store, storeSeq));
      else p.resolve({ ok: true, result, storeSeq, invVersion: res.invVersion, store: res.store });
    }
    return "accepted";
  }

  // The instance's connection closed and no newer one of it is live: reads fail now, side effects wait.
  connectionLost(node: string, instanceId: string): void {
    this.#settle(p => p.node === node && p.instanceId === instanceId && !p.sideEffect,
      p => failed("node_offline", `${p.op} on ${node}: the connection closed`, p.store, this.highestSeq(p.node, p.store)));
  }

  // Another instance of `node` was admitted: whatever the old instances held can no longer be answered.
  admitted(node: string, instanceId: string): void {
    this.#settle(p => p.node === node && p.instanceId !== instanceId, p => this.#gone(p));
  }

  // The node was revoked, or the service stops: every waiting request of it (or of all nodes) ends now.
  drop(node: string | null): void {
    this.#settle(p => node === null || p.node === node, p => this.#gone(p));
  }

  #gone(p: Pending): Outcome {
    const seq = this.highestSeq(p.node, p.store);
    return p.sideEffect ? failed("uncertain", `${p.op} on ${p.node}: the agent went away before answering; ask op.status`, p.store, seq)
      : failed("node_offline", `${p.op} on ${p.node}: the agent went away`, p.store, seq);
  }

  #settle(match: (p: Pending) => boolean, outcome: (p: Pending) => Outcome): void {
    for (const [k, p] of this.#pending) {
      if (!match(p)) continue;
      this.#pending.delete(k);
      clearTimeout(p.timer);
      p.resolve(outcome(p));
    }
  }
}
