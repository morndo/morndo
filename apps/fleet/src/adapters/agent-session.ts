// One agent's WebSocket, from its first message to its close (spec 5.1, 5.2, 5.4):
//   join  → the code is redeemed for the node the join names (constant-time hash compare, bound to the name it was
//           issued for, single use) → welcome (placeholder values) → close 1000
//   hello → challenge { nonce, fleetSig over fleetSigPayload(node, clientNonce) } → proof (checked against the stored
//           key) → the instance rules (which may wait for another instance's pong) → welcome { connEpoch, ackSeq,
//           streamKnown } → live
// A join or a hello first takes a token from its source address's bucket (LIMITS.handshakeBurst at once, one more every
// LIMITS.handshakeRefillMs), before any key work: no code is hashed and nothing is signed for a source over it.
// Close codes: 4401 bad proof, 4403 unknown, revoked or refused join (a code unknown, expired, used or issued for
// another name), 4409 another instance is live, 4426 no protocol version in common; 1003 a message that isn't one of
// ours or is binary; 1008 a message out of order, a handshake not finished in time, an event for another node or
// stream, or too many messages; 1009 a message over 512 KiB (ws itself closes 1009 over maxPayload, 1 MiB); 1013 too
// many joins or hellos from that address. Every admission (in Connections) and every refused hello is audited with
// its source address; a refused join is audited as before; a source over its bucket is only logged, so no one outside
// can fill the audit or the alerts.
// Once live: results go to the requests, inventory and health to the connection registry (rate limited per node),
// hook events to the hook sink (the intake window), each acknowledged once the commit that holds it is synced to the
// disk. Hook events are exempt from the rate limit: the agent's replay window paces them (spec 5.4). So are delivery
// states (ev.delivery, to the deliveries' mirror): after every reconnect a node sends each open delivery's state at
// once (fleet clients spec §4.4), and its own store bounds them.
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  AgentMessage, CLOSE, FLEET_PROTO, LIMITS, fleetSigPayload, nodeSigPayload, parseBody,
  type FleetMessage,
} from "@morndo/protocol";
import type { Connections, Peer } from "../application/connections.ts";
import type { Deliveries } from "../application/deliveries.ts";
import type { HookSink, IntakeHandle } from "../application/hook-sink.ts";
import type { JobMirror } from "../application/job-mirror.ts";
import type { Rollouts } from "../application/rollouts.ts";
import type { Audit } from "./audit.ts";
import type { FleetKey } from "./keys.ts";
import { verifySig } from "./keys.ts";
import type { Logger } from "./log.ts";
import type { NodesStore } from "./nodes-store.ts";
import type { RateLimiter } from "./rate-limit.ts";

export type SessionDeps = {
  connections: Connections; nodes: NodesStore; audit: Audit; fleetKey: FleetKey; hooks: HookSink; jobs: JobMirror; log: Logger;
  deliveries: Pick<Deliveries, "fromNode" | "heldByOther">;
  // The welcome's two updates fields (updates §7): this fleet's own build, and the Rollout as it stands.
  rollouts: Pick<Rollouts, "latest">; build: { version: string; commit: string | null };
  limiter: RateLimiter; handshakes: { take(source: string): boolean }; handshakeMs: number; source: string;
};

type Hello = Extract<AgentMessage, { t: "hello" }>;
type State =
  | { kind: "new" }
  | { kind: "challenged"; hello: Hello; nonce: string }
  | { kind: "admitting" }
  | { kind: "live"; node: string; instanceId: string; streamId: string }
  | { kind: "done" };

// The protocol versions this fleet speaks: the current one and the one before (spec 5, ADR-0012 decision 10).
export const ACCEPTED_PROTO = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
const speaks = (proto: number[]) => proto.some(v => ACCEPTED_PROTO.includes(v));
export const HANDSHAKE_MS = 10_000;
// After the fleet closes a session (a revoked node, a replaced connection, a stopping service) the peer gets this long
// to finish the close handshake; then the socket is terminated. Without it ws would keep the socket for its own 30 s
// close timeout, and 2 s is plenty for a healthy peer on a tailnet to answer one frame.
export const CLOSE_GRACE_MS = 2000;

export function runSession(ws: WebSocket, d: SessionDeps): void {
  let state: State = { kind: "new" };
  let intake: IntakeHandle | null = null;                // the intake's handle for this connection's hook events, once live
  let closing = false;                                   // closed by us: later messages are ignored
  const send = (m: FleetMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  let grace: ReturnType<typeof setTimeout> | null = null;
  const closeWithGrace = (code: number, reason: string) => {
    ws.close(code, reason);
    grace ??= setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
    grace.unref();
  };
  const close = (code: number, reason: string) => { closing = true; closeWithGrace(code, reason); };
  // Closed by the connection registry (revoked, replaced, stopping): it has already forgotten this connection, so from
  // here on nothing this peer sends is taken (ws keeps reading until the peer answers the close frame).
  const closeFromFleet = (code: number, reason: string) => {
    closing = true;
    state = { kind: "done" };
    intake?.cancel();                                    // its events not yet committed are dropped, never acknowledged
    intake = null;
    closeWithGrace(code, reason);
  };
  const peer: Peer = {
    send, ping: () => ws.ping(), close: closeFromFleet, terminate: () => ws.terminate(), open: () => ws.readyState === ws.OPEN,
  };
  // Audited, but a refusal goes out with its own close code even when fleet.db can't take the row (busy or full).
  const refused = (node: string | null, reason: string, extra: Record<string, unknown> = {}) => {
    try { d.audit.record("agent", "conn.refused", node, { reason, source: d.source, ...extra }); }
    catch (e) { d.log.error(`node ${node ?? "?"}: could not audit a refused connection (fleet.db busy or full?)`, e); }
  };
  const tooMany = () => close(1013, "too many joins or hellos from this address; try again later");
  const handshake = setTimeout(() => { if (state.kind !== "live") close(1008, "handshake timeout"); }, d.handshakeMs);

  // The intake acknowledges the highest accepted seq once its commit is on the disk, if the connection is still live.
  const openIntake = (node: string, streamId: string): IntakeHandle => d.hooks.open({
    node, streamId,
    acked: seq => { if (state.kind === "live") send({ v: 1, t: "ack", streamId, seq }); },
    failed: e => {
      d.log.error(`node ${node}: storing hook events failed; not acknowledged`, e);
      if (state.kind === "live") close(1011, "internal error");
    },
  });

  function onMessage(raw: Buffer, isBinary: boolean) {
    if (closing || state.kind === "done") return;
    if (isBinary) return close(1003, "text frames only");
    if (raw.length > LIMITS.maxMessageBytes) return close(1009, "message too big");
    let value: unknown;
    try { value = JSON.parse(raw.toString("utf8")); } catch { return close(1003, "bad message"); }
    const m = parseBody(AgentMessage, value);
    if (m === null) return close(1003, "bad message");
    switch (m.t) {
      case "join": {
        if (state.kind !== "new") return close(1008, "unexpected join");
        if (!d.handshakes.take(d.source)) return tooMany();
        if (!speaks(m.proto)) {
          d.audit.record("agent", "join.refused", null, { reason: "unsupported", node: m.node, source: d.source });
          return close(CLOSE.unsupported, "unsupported protocol");
        }
        const r = d.nodes.redeem(m.code, m.node, m.publicKey);
        if (!r.ok) {
          d.audit.record("agent", "join.refused", null, { reason: r.refused, node: m.node, source: d.source });
          return close(CLOSE.forbidden, "join refused");
        }
        d.audit.record("agent", "node.joined", r.node, { source: d.source, agent: m.agent.version });
        // Placeholder values (connEpoch is at least 1 on the wire): the agent reads only that it was welcomed.
        send({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
        return close(1000, "joined");
      }
      case "hello": {
        if (state.kind !== "new") return close(1008, "unexpected hello");
        if (!d.handshakes.take(d.source)) return tooMany();
        if (!speaks(m.proto)) { refused(m.node, "unsupported", { proto: m.proto }); return close(CLOSE.unsupported, "unsupported protocol"); }
        if (!d.nodes.active(m.node)) { refused(m.node, "unknown_node"); return close(CLOSE.forbidden, "unknown or revoked node"); }
        const nonce = randomBytes(32).toString("base64url");
        state = { kind: "challenged", hello: m, nonce };
        return send({ v: 1, t: "challenge", nonce, fleetSig: d.fleetKey.sign(fleetSigPayload(m.node, m.clientNonce)) });
      }
      case "proof": {
        if (state.kind !== "challenged") return close(1008, "unexpected proof");
        const { hello, nonce } = state;
        const row = d.nodes.active(hello.node);
        if (!row) { refused(hello.node, "unknown_node"); return close(CLOSE.forbidden, "unknown or revoked node"); }
        if (!verifySig(row.publicKey, nodeSigPayload(hello.node, nonce), m.sig)) {
          d.audit.record("agent", "auth.bad_proof", hello.node, { source: d.source });
          return close(CLOSE.badProof, "bad proof");
        }
        // The instance rules may wait for another instance's pong; until the answer, anything the agent sends is out of
        // order (it waits for its welcome).
        state = { kind: "admitting" };
        d.connections.admit({
          node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId, peer, source: d.source, agentVersion: hello.agent.version, agentCommit: hello.agent.commit ?? null,
          claudeVersion: hello.claude.version, caps: hello.caps, proto: hello.proto,
        }, epoch => {
          clearTimeout(handshake);
          state = { kind: "live", node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId };
          intake = openIntake(hello.node, hello.streamId);
          const mark = d.hooks.known(hello.node, hello.streamId);
          // The highest store sequence this store has shown (fleet.db): an agent whose database is behind it was put
          // back from an older copy, and starts a new store before it runs anything (spec §5.2). None known: omitted.
          const seen = d.connections.storeSeqSeen(hello.node, hello.streamId);
          // With it (updates §7) the control plane's own build — what a node's updater checks its Versions against
          // (RL11) — and the Rollout as it stands, null while the control plane has committed none.
          send({
            v: 1, t: "welcome", connEpoch: epoch, ackSeq: mark.seq, streamKnown: mark.known, ...(seen === null ? {} : { storeSeqSeen: seen }),
            controlPlane: { version: d.build.version, commit: d.build.commit }, rollout: d.rollouts.latest(),
          });
          try { d.jobs.retry(hello.node); } catch (e) { d.log.error(`node ${hello.node}: retrying job notices failed`, e); }
          try { d.jobs.pushNotices(hello.node); } catch (e) { d.log.error(`node ${hello.node}: sending notice results failed`, e); }
        }).then(admitted => {
          if (admitted.ok || closing || state.kind === "done") return;
          if (admitted.revoked) { refused(hello.node, "unknown_node"); return close(CLOSE.forbidden, "unknown or revoked node"); }
          refused(hello.node, "instance_conflict", { instanceId: hello.instanceId });
          close(CLOSE.conflict, "another instance of this node is connected");
        }).catch((e: unknown) => {                       // a catch after the then: a throw in either ends here, not the process
          d.log.error(`node ${hello.node}: admitting a connection failed`, e);
          close(1011, "internal error");
        });
        return;
      }
      case "res":
        if (state.kind !== "live") return close(1008, "unexpected result");
        return d.connections.result(state.node, state.instanceId, m);
      case "ev.hook": {
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (m.event.node !== state.node || m.event.streamId !== state.streamId) return close(1008, "an event for another node or stream");
        intake?.add(m.event);
        return;
      }
      case "ev.inventory":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (!d.limiter.take(state.node)) return rateLimited(state.node);
        return d.connections.inventory(state.node, m.panes, m.invVersion);
      case "ev.health":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (!d.limiter.take(state.node)) return rateLimited(state.node);
        return d.connections.health(state.node, m.health);
      case "ev.delivery":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (m.delivery.node !== state.node) return close(1008, "an event for another node or stream");
        // An id another node holds is dropped (heldByOther logged and audited it); the connection stays: the node replays
        // its deliveries after every welcome, so closing it would close it again on every reconnect (review #2).
        if (d.deliveries.heldByOther(state.node, m.delivery.id)) return;
        return d.deliveries.fromNode(state.node, m.delivery);
      case "job":
        // A reconnect resends every open job. Like hook events, that replay is not rate limited.
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (m.node !== state.node) return close(1008, "an event for another node");
        return d.jobs.accept(m);
    }
  }

  const rateLimited = (node: string) => {
    d.audit.alert("rate_limited", node, {});
    close(1008, "too many messages");
  };

  ws.on("message", (raw, isBinary) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    try { onMessage(bytes, isBinary); }
    catch (e) { d.log.error("agent socket: a message failed, closing", e); close(1011, "internal error"); }
  });
  ws.on("pong", () => { if (state.kind === "live") d.connections.pong(state.node, peer); });
  ws.on("error", e => d.log.warn(`agent socket: ${e.message}`));     // ws closes the socket itself; never the payload
  ws.on("close", () => {
    clearTimeout(handshake);
    if (grace) clearTimeout(grace);
    const live = state.kind === "live" ? state : null;
    state = { kind: "done" };                                         // events received are stored, unacknowledged
    if (live) d.connections.closed(live.node, peer);
  });
}
