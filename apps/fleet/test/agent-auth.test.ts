// The agent endpoint's join and mutual authentication (spec 5.1, 5.2) against a real fleet and scripted agents:
// close codes 4401 (bad proof), 4403 (unknown, revoked, refused join), 4426 (no common protocol version), 1009 (a
// message too big), 1013 (too many joins and hellos from one address, before any key work). Admissions and refusals
// are audited with their source address.
// Negative controls: a tampered proof, a proof by another key, a reused code, an expired code and a code used with
// another name are each refused.
import { randomUUID, sign } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CLOSE, FLEET_PROTO, LIMITS, nodeSigPayload } from "@morndo/protocol";
import type { Socket } from "node:net";
import type { HookEvent } from "@morndo/protocol";
import { HANDSHAKES, startAgentEndpoint } from "../src/adapters/agent-endpoint.ts";
import { CLOSE_GRACE_MS } from "../src/adapters/agent-session.ts";
import { FakeAgent, newKey, parseFrame } from "./helpers/fake-agent.ts";
import { quiet, startTestFleet, WIDE } from "./helpers/fleet.ts";
import { until } from "./helpers/until.ts";

describe("join", () => {
  it("a code registers the node the join names: a placeholder welcome, then the fleet closes the join connection", async () => {
    const fleet = await startTestFleet();
    const a = fleet.agent();
    const r = await a.join("pc", fleet.code("pc"));
    expect(r.welcome).toEqual({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
    expect(r.closed.code).toBe(1000);
    expect(fleet.nodes.active("pc")?.publicKey).toBe(a.key.publicKey);
    expect(fleet.audit.of("node.joined").map(e => e.node)).toEqual(["pc"]);
  });

  it("refuses an unknown, used or expired code with 4403, and audits it without the code", async () => {
    let now = 1_800_000_000_000;
    const fleet = await startTestFleet({ now: () => now });
    expect((await fleet.agent().join("pc", Buffer.alloc(16, 1).toString("base64url"))).closed.code).toBe(CLOSE.forbidden);
    const used = fleet.code("pc");
    expect((await fleet.agent().join("pc", used)).welcome).not.toBeNull();
    expect((await fleet.agent().join("pc", used)).closed.code).toBe(CLOSE.forbidden);   // negative control: reuse
    const late = fleet.code("mac");
    now += LIMITS.joinCodeTtlMs;
    expect((await fleet.agent().join("mac", late)).closed.code).toBe(CLOSE.forbidden);  // negative control: expired
    expect(fleet.audit.of("join.refused").map(e => e.detail.reason)).toEqual(["unknown", "used", "expired"]);
    expect(JSON.stringify(fleet.audit.recent())).not.toContain(used);
  });

  it("a code used with another node's name is refused with 4403 and stores nothing; with its own name it joins", async () => {
    const fleet = await startTestFleet();
    const code = fleet.code("node-a");
    const asB = await fleet.agent().join("node-b", code);                             // negative control: wrong name
    expect(asB).toMatchObject({ welcome: null, closed: { code: CLOSE.forbidden } });
    expect(fleet.nodes.list()).toEqual([]);
    expect(fleet.audit.of("join.refused").map(e => [e.detail.reason, e.detail.node])).toEqual([["wrong_node", "node-b"]]);
    const a = fleet.agent();
    expect((await a.join("node-a", code)).welcome).toEqual({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
    expect(fleet.nodes.list().map(n => n.name)).toEqual(["node-a"]);
    expect(await a.connect({ node: "node-b" })).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });   // A's key is not B's
    expect((await a.connect()).ok).toBe(true);
  });

  it("refuses a join without a common protocol version with 4426", async () => {
    const fleet = await startTestFleet();
    const r = await fleet.agent().join("pc", fleet.code("pc"), { proto: [FLEET_PROTO + 1] });
    expect(r.closed.code).toBe(CLOSE.unsupported);
    expect(fleet.nodes.active("pc")).toBeNull();
  });
});

describe("hello, challenge, proof", () => {
  it("a joined node authenticates both ways: the fleet's signature verifies against the pinned key, then welcome", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    const r = await a.connect();
    expect(r).toEqual({ ok: true, welcome: { v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false } });
    expect(fleet.connections.status("pc")).toBe("online");
    expect(fleet.nodes.active("pc")?.agentVersion).toBe("test-agent/1");
    expect(fleet.nodes.active("pc")?.lastSeenAt).not.toBeNull();
    expect(fleet.audit.of("conn.admitted").map(e => [e.node, e.detail])).toEqual([["pc", { instanceId: a.instanceId, epoch: 1, source: "127.0.0.1" }]]);
  });

  it("an agent pinned to another fleet key rejects the challenge (the fleet's signature is bound to its key)", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ pinned: newKey().publicKey })).toMatchObject({ ok: false, fleetSigOk: false });
  });

  it("refuses a tampered proof and a proof by another key with 4401", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ proof: "tampered" })).toMatchObject({ ok: false, closed: { code: CLOSE.badProof }, fleetSigOk: true });
    expect(await a.connect({ proof: "other-key" })).toMatchObject({ ok: false, closed: { code: CLOSE.badProof } });
    expect(fleet.connections.status("pc")).toBe("offline");
    expect(fleet.audit.of("auth.bad_proof")).toHaveLength(2);
    expect((await a.connect()).ok).toBe(true);                                         // the real key still works
  });

  it("refuses an unknown node and a revoked node with 4403", async () => {
    const fleet = await startTestFleet();
    const stranger = fleet.agent({ node: "stranger" });
    expect(await stranger.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
    const a = await fleet.joined("pc");
    fleet.nodes.revoke("pc");
    expect(await a.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
    expect(fleet.audit.of("conn.refused").map(e => [e.node, e.detail])).toEqual([
      ["stranger", { reason: "unknown_node", source: "127.0.0.1" }], ["pc", { reason: "unknown_node", source: "127.0.0.1" }],
    ]);
  });

  it("signs nothing for an unknown or a revoked node: no challenge frame, no fleet signature, 4403 (the signing oracle, Task 11)", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    const signed = vi.spyOn(fleet.key, "sign");
    // Every frame the fleet sends on one connection that opens with a hello for `node`, and the close code.
    const hello = async (node: string) => {
      const ws = new WebSocket(fleet.agentUrl);
      const frames: string[] = [];
      ws.on("message", raw => frames.push(JSON.stringify(parseFrame<unknown>(raw))));
      const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
      await new Promise<void>(resolve => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({
        v: 1, t: "hello", node, instanceId: a.instanceId, streamId: a.streamId, proto: [FLEET_PROTO],
        agent: { version: "test-agent/1" }, claude: { version: null }, caps: [], clientNonce: "n".repeat(43),
      }));
      return { frames, ws, closed };
    };
    const stranger = await hello("stranger");
    expect(await stranger.closed).toBe(CLOSE.forbidden);
    expect(stranger.frames).toEqual([]);                                             // no challenge, nothing at all
    fleet.nodes.revoke("pc");
    const revoked = await hello("pc");
    expect(await revoked.closed).toBe(CLOSE.forbidden);
    expect(revoked.frames).toEqual([]);
    expect(signed).not.toHaveBeenCalled();                                           // the fleet's key signed nothing
    // negative control: an active node's hello is challenged, with the fleet's signature over its nonce
    const b = await fleet.joined("mac");
    const known = await hello("mac");
    known.ws.on("error", () => {});
    await until(() => known.frames.length > 0);
    expect(JSON.parse(known.frames[0] ?? "{}")).toMatchObject({ t: "challenge", fleetSig: expect.any(String) });
    expect(signed).toHaveBeenCalledTimes(1);
    known.ws.terminate();
    b.terminate();
  });

  it("a node revoked between challenge and proof is refused with 4403 (not 1011), audited, and never admitted", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    const ws = new WebSocket(fleet.agentUrl);
    const frames: { t: string; nonce?: string }[] = [];
    ws.on("message", raw => frames.push(parseFrame<{ t: string; nonce?: string }>(raw)));
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    await new Promise<void>(resolve => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({
      v: 1, t: "hello", node: "pc", instanceId: a.instanceId, streamId: a.streamId, proto: [FLEET_PROTO],
      agent: { version: "test-agent/1" }, claude: { version: null }, caps: [], clientNonce: "n".repeat(43),
    }));
    await until(() => frames.some(f => f.t === "challenge"));
    fleet.nodes.revoke("pc");
    const nonce = frames.find(f => f.t === "challenge")?.nonce ?? "";
    ws.send(JSON.stringify({ v: 1, t: "proof", sig: sign(null, Buffer.from(nodeSigPayload("pc", nonce)), a.key.privateKey).toString("base64") }));
    expect(await closed).toBe(CLOSE.forbidden);                                         // negative control: another code here fails this
    expect(fleet.audit.of("conn.refused").map(e => [e.node, e.detail.reason])).toEqual([["pc", "unknown_node"]]);
    expect(fleet.audit.of("conn.admitted")).toEqual([]);
  });

  it("refuses a hello without a common protocol version with 4426, and takes the previous or current one", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ proto: [FLEET_PROTO + 1] })).toMatchObject({ ok: false, closed: { code: CLOSE.unsupported } });
    expect(await a.connect({ proto: [0] })).toMatchObject({ ok: false, closed: { code: 1003 } });          // no version at all: malformed
    expect((await a.connect({ proto: [FLEET_PROTO, FLEET_PROTO + 1] })).ok).toBe(true);
  });
});

describe("what the endpoint refuses outright", () => {
  it("malformed or binary messages close with 1003; a message out of order with 1008; a slow handshake with 1008", async () => {
    const fleet = await startTestFleet({ handshakeMs: 300 });
    const sockets: WebSocket[] = [];
    // Sends `data` (nothing, if undefined) on a fresh connection and returns the close code the fleet answers with.
    const closeCodeAfter = async (data?: string | Buffer) => {
      const ws = new WebSocket(fleet.agentUrl);
      sockets.push(ws);
      const closed = new Promise<number>(r => ws.once("close", code => r(code)));
      await new Promise(r => ws.once("open", r));
      if (data !== undefined) ws.send(data, { binary: Buffer.isBuffer(data) });
      return closed;
    };
    try {
      expect(await closeCodeAfter("not json")).toBe(1003);
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "from-the-future" }))).toBe(1003);
      expect(await closeCodeAfter(Buffer.from([1, 2, 3]))).toBe(1003);
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "proof", sig: "AAAA" }))).toBe(1003);              // not a signature
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "proof", sig: `${"A".repeat(86)}==` }))).toBe(1008);   // before a hello
      expect(await closeCodeAfter()).toBe(1008);                                        // says nothing: handshake timeout
    } finally { for (const ws of sockets) ws.terminate(); }
  });

  it("a message over 512 KiB closes with 1009, and so does one over the 1 MiB maxPayload (ws itself)", async () => {
    const fleet = await startTestFleet();
    const closeCode = async (bytes: number) => {
      const ws = new WebSocket(fleet.agentUrl);
      const closed = new Promise<number>(r => ws.once("close", code => r(code)));
      ws.on("error", () => {});
      await new Promise(r => ws.once("open", r));
      ws.send(JSON.stringify({ v: 1, t: "hello", pad: "x".repeat(bytes) }));
      return closed;
    };
    expect(await closeCode(LIMITS.maxMessageBytes + 1)).toBe(1009);                 // the fleet's own 512 KiB limit
    expect(await closeCode(LIMITS.maxPayload + 1)).toBe(1009);                      // ws: past maxPayload, never buffered whole
    expect(await closeCode(1000)).toBe(1003);                                       // negative control: small, it is read (and malformed)
  });

  it("joins and hellos from one address past its bucket close with 1013 before any key work, and audit nothing", async () => {
    const fleet = await startTestFleet({ handshakeLimits: HANDSHAKES });           // the real bucket: 10 at once
    const challenged: boolean[] = [];
    for (let i = 0; i < LIMITS.handshakeBurst + 2; i++) {
      const s = fleet.agent({ node: "stranger" });
      const r = await s.connect();
      expect(r.ok).toBe(false);
      challenged.push(s.inbox.some(m => m.t === "challenge"));
      expect(r.ok ? 0 : r.closed.code, `hello ${i + 1}`).toBe(i < LIMITS.handshakeBurst ? CLOSE.forbidden : 1013);
    }
    expect(challenged.filter(Boolean)).toEqual([]);                                 // an unknown node is never challenged anyway
    expect(fleet.audit.of("conn.refused")).toHaveLength(LIMITS.handshakeBurst);     // the two over the bucket: not audited
    const code = fleet.code("pc");
    expect((await fleet.agent().join("pc", code)).closed.code).toBe(1013);          // a join counts too: its code isn't touched
    expect(fleet.nodes.list()).toEqual([]);
    expect(fleet.audit.of("join.refused")).toEqual([]);
    expect(fleet.audit.alerts(0)).toEqual([]);                                      // no alert from outside
    // Another address (Tailscale Serve's X-Forwarded-For from this machine) has its own bucket.
    const other = fleet.agent({ node: "stranger" });
    expect(await other.connect({ headers: { "x-forwarded-for": "100.64.0.9" } })).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
  });

  it("an upgrade elsewhere gets 404 and plain HTTP gets 426", async () => {
    const fleet = await startTestFleet();
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${fleet.agentPort}/elsewhere`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(404);
    const plain = await new Promise<number>(resolve => request(`http://127.0.0.1:${fleet.agentPort}/agent`, res => { res.resume(); resolve(res.statusCode ?? 0); }).end());
    expect(plain).toBe(426);
  });

  it("an event naming another node or stream closes the connection with 1008", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.hook(1, "/hook/stop", {}, { node: "someone-else" });
    expect((await a.closed).code).toBe(1008);
    const b = await fleet.online("mac");
    b.hook(1, "/hook/stop", {}, { streamId: randomUUID() });
    expect((await b.closed).code).toBe(1008);
  });
});

describe("a session the fleet closed", () => {
  it("takes nothing more from a revoked node that withholds its close frame, and the socket is terminated after the grace", async () => {
    const fleet = await startTestFleet();
    const stored: HookEvent[] = [];
    const hooks = { known: () => ({ seq: 0, known: false }), accept: (_n: string, _s: string, events: HookEvent[]) => { stored.push(...events); return events.at(-1)?.seq ?? 0; } };
    const endpoint = startAgentEndpoint({
      host: "127.0.0.1", port: 0, handshakeLimits: WIDE,
      deps: { connections: fleet.connections, nodes: fleet.nodes, audit: fleet.audit, fleetKey: fleet.key, hooks, jobs: fleet.jobs, log: quiet },
    });
    await endpoint.ready;
    const terminate = vi.spyOn(WebSocket.prototype, "terminate");
    try {
      const a = new FakeAgent({ url: `ws://127.0.0.1:${endpoint.port()}/agent`, fleetKey: fleet.key.publicKey });
      await a.join("pc", fleet.code("pc"));
      expect((await a.connect()).ok).toBe(true);
      a.hook(1);
      expect(await a.acked(1)).toBe(1);                                                // a live node's hooks are stored and acked
      const events: string[] = [];
      fleet.events.subscribe(e => { if (e.t === "inventory" || e.t === "health") events.push(e.t); });
      (a.ws as unknown as { _socket: Socket })._socket.pause();                        // it never reads the close frame, never answers it
      const revokedAt = performance.now();
      fleet.nodes.revoke("pc");
      fleet.connections.revoke("pc");
      a.hook(2);
      a.inventory([]);
      a.health();
      await new Promise(r => setTimeout(r, 300));
      expect(stored.map(e => e.seq)).toEqual([1]);                                     // negative control: without the fix, 2 as well
      expect(events).toEqual([]);
      expect(fleet.connections.latest("pc")).toEqual({ inventory: null, health: null });
      expect(terminate).not.toHaveBeenCalled();                                         // the grace is still running
      await until(() => terminate.mock.calls.length > 0, CLOSE_GRACE_MS + 2000);
      expect(performance.now() - revokedAt).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 100);
    } finally { terminate.mockRestore(); await endpoint.close(); }
  });
});
