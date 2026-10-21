// The fleet's agent channel (docs/design/fleet-core/README.md §5): what each end accepts, the limits, the handshake's
// signing payloads and the join string. Synthetic messages and throwaway keys only.
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS, AgentFrames, AgentMessage, CAP_LONG_TEXT, CLOSE, ERROR_EXECUTED, FleetFrames, FleetMessage, KEYED_OPS, LIMITS, OP_ARGS, OP_NAMES, OP_RESULTS, STEP_UP_OPS, SendBody,
  decode, fleetSigPayload, fleetUrlOk, formatJoinString, nodeSigPayload, parseJoinString, type ErrorCode, type JoinString, type OpName,
} from "../src/index.ts";
import * as z from "../src/z.ts";

const UUID = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
const W = "pc.3fa2c1d0.12";
const keys = () => generateKeyPairSync("ed25519");
const spki = (k: ReturnType<typeof keys>) => k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const NONCE = randomBytes(32).toString("base64url");
const SIG = Buffer.alloc(64, 7).toString("base64");
const kind = (d: { kind: string }) => d.kind;
const expectArgs = { server: "3fa2c1d0", window: "fix: a/b ü.2", sessionId: UUID };
const health = { memTotal: 1, memAvailable: 1, psiSome10: null, psiFull10: 0.5, diskFreeHome: 1, load1: 0.1, tmuxOk: true, wallClock: 1, spoolDepth: 0, drops: 0 };

describe("limits", () => {
  it("are the spec's numbers", () => {
    expect(LIMITS).toMatchObject({
      maxMessageBytes: 512 << 10, maxPayload: 1 << 20, chunkBytes: 256 << 10, maxFileBytes: 25 << 20, maxSendText: 8000, maxMessageText: 100_000, maxKeys: 4096,
      captureManyMax: 64, captureBytesPerPane: 6 << 10, replayWindow: 256, pingMs: 15_000, agentPingTimeoutMs: 35_000, healthMs: 30_000,
      inventoryPollMs: 2000, instancePongMs: 3000, conflictRetryMs: 5 * 60_000, inventoryWaitMs: 300, bulkQueueMax: 8, eventsBufferBytes: 8 << 20,
      handshakeBurst: 10, handshakeRefillMs: 6000, joinCodeTtlMs: 10 * 60_000, doneKeyTtlMs: 7 * 86_400_000, outboxKeepMs: 86_400_000,
      deadLetterAttempts: 20, subscriberBacklog: 50_000, auditKeepMs: 90 * 86_400_000,
    });
    expect(LIMITS.agentPingTimeoutMs).toBeGreaterThan(2 * LIMITS.pingMs);    // two pings may be late before the agent gives up
    expect(CLOSE).toEqual({ badProof: 4401, forbidden: 4403, conflict: 4409, unsupported: 4426 });
  });
  it("a full captureMany and a full bulk chunk each fit one message", () => {
    const captures = Array.from({ length: LIMITS.captureManyMax }, (_, i) => ({ workerId: `pc.3fa2c1d0.${i}`, text: "x".repeat(LIMITS.captureBytesPerPane), truncated: true }));
    const many = JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: true, result: { captures } });
    expect(Buffer.byteLength(many)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const chunk = JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: true, result: { bytes: Buffer.alloc(LIMITS.chunkBytes, 0xff).toString("base64"), size: LIMITS.maxFileBytes, eof: false } });
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
  });
  it("a whole maxMessageText message fits one op message", () => {
    const req = JSON.stringify({ v: 1, t: "req", id: "r1", op: "pane.send", timeoutMs: 10_000, key: "hub:ep1:req-1",
      args: { workerId: W, text: "ü".repeat(LIMITS.maxMessageText), expect: expectArgs } });
    expect(Buffer.byteLength(req)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
  });
  it("the HTTP SendBody's text bound is LIMITS.maxMessageText, the same the ops take", () => {
    const body = (text: string) => ({ text, requestId: UUID, seen: "none" });
    expect(z.safeParse(SendBody, body("x".repeat(LIMITS.maxMessageText))).success).toBe(true);
    expect(z.safeParse(SendBody, body("x".repeat(LIMITS.maxMessageText + 1))).success).toBe(false);
  });
});

describe("errors and keys", () => {
  it("only uncertain and internal may have run", () => {
    const maybe = Object.entries(ERROR_EXECUTED).filter(([, e]) => e === "maybe").map(([c]) => c);
    expect(maybe.sort()).toEqual(["internal", "uncertain"]);
    expect(Object.keys(ERROR_EXECUTED)).toHaveLength(20);
  });
  it("the side-effecting ops carry keys, keystrokes don't", () => {
    expect([...KEYED_OPS].sort()).toEqual([
      "connections.narrow", "connections.priority", "connections.revoke", "connections.role",
      "file.put", "job.notice", "lane.start", "lane.stop", "memory.sync", "pane.send", "worktree.add",
    ]);
    expect(KEYED_OPS.has("pane.keys")).toBe(false);
    expect(KEYED_OPS.has("job.cancel")).toBe(false);
    expect(OP_NAMES).toHaveLength(27);
    expect(Object.keys(OP_ARGS).sort()).toEqual([...OP_NAMES].sort());
    expect(Object.keys(OP_RESULTS).sort()).toEqual([...OP_NAMES].sort());
  });
});

describe("messages, agent → fleet", () => {
  const k = keys();
  const msgs = [
    { v: 1, t: "join", node: "pc", code: randomBytes(16).toString("base64url"), publicKey: spki(k), agent: { version: "0.1.0" }, proto: [1] },
    { v: 1, t: "hello", node: "pc", instanceId: UUID, streamId: UUID, proto: [1], agent: { version: "0.1.0" }, claude: { version: null }, caps: ["pane.send"], clientNonce: NONCE },
    { v: 1, t: "proof", sig: sign(null, Buffer.from("x"), k.privateKey).toString("base64") },
    { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: true, result: { ok: true } },
    { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: false, error: { code: "no_pane", executed: "no", message: "expectation mismatch" } },
    { v: 1, t: "ev.hook", event: { streamId: UUID, seq: 1, at: 1, path: "/hook/stop", node: "pc", window: "fix: a/b ü.2", body: { any: "thing" } } },
    { v: 1, t: "ev.hook", event: { streamId: UUID, seq: 9, at: 1, path: "/cc", node: "pc", window: null, late: true, body: null } },
    { v: 1, t: "ev.inventory", panes: [{ workerId: W, window: "fix: a/b ü.2", cwd: "/w", sessionId: UUID, claudeVersion: "2.1.287" }], invVersion: 4 },
    { v: 1, t: "ev.health", health },
  ];
  it("accepts every message an agent sends, by t and as the union", () => {
    for (const m of msgs) {
      expect(kind(decode(AgentFrames, JSON.stringify(m))), m.t).toBe("ok");
      expect(z.safeParse(AgentMessage, m).success, m.t).toBe(true);
    }
  });
  it("a hello may say it takes long messages (CAP_LONG_TEXT, beside its ops)", () => {
    expect(z.safeParse(AgentMessage, { ...msgs[1], caps: ["pane.send", CAP_LONG_TEXT] }).success).toBe(true);
  });
  it("tells a t it doesn't know from a malformed message, so the first can be answered with an error", () => {
    expect(decode(AgentFrames, JSON.stringify({ v: 1, t: "ev.desktop", x: 1 }))).toEqual({ kind: "unknown", t: "ev.desktop" });
    expect(kind(decode(AgentFrames, '{"t":"toString"}'))).toBe("unknown");
    for (const bad of [{ ...msgs[1], v: 2 }, { ...msgs[1], node: "PC" }, { ...msgs[1], clientNonce: "short" }, { ...msgs[0], publicKey: "AAAA" },
      { ...msgs[0], code: "x".repeat(21) }, { ...msgs[2], sig: "AAAA" }, { ...msgs[3], id: "" }, { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: false },
      { v: 1, t: "res", id: "r1", invVersion: 3, ok: true, result: {} }, { ...msgs[3], store: "store-1" },
      { v: 1, t: "ev.hook", event: { ...(msgs[5] as { event: object }).event, seq: 0 } }, { v: 1, t: "ev.inventory", panes: [{ workerId: "%1", window: "w", cwd: "/" }], invVersion: 1 }]) {
      expect(kind(decode(AgentFrames, JSON.stringify(bad))), JSON.stringify(bad).slice(0, 80)).toBe("malformed");
    }
  });
  it("carries the store sequence as an optional count: an agent from before it sends none (final review I2)", () => {
    for (const storeSeq of [0, 7, Number.MAX_SAFE_INTEGER]) {
      for (const base of [msgs[3], msgs[4]]) {
        const d = decode(AgentFrames, JSON.stringify({ ...base, storeSeq }));
        expect(d.kind === "ok" && d.frame.t === "res" ? d.frame.storeSeq : null).toBe(storeSeq);
      }
    }
    const old = decode(AgentFrames, JSON.stringify(msgs[3]));
    expect(old.kind === "ok" && old.frame.t === "res" ? "storeSeq" in old.frame : null).toBe(false);
    for (const storeSeq of [-1, 1.5, "3", null, 2 ** 53]) {
      expect(kind(decode(AgentFrames, JSON.stringify({ ...msgs[3], storeSeq }))), String(storeSeq)).toBe("malformed");
    }
  });
  it("reads an error code from a newer agent as internal, which may have run", () => {
    const d = decode(AgentFrames, JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: false, error: { code: "from_the_future", executed: "no", message: "" } }));
    expect(d.kind === "ok" && d.frame.t === "res" && !d.frame.ok ? d.frame.error : null).toEqual({ code: "internal", executed: "maybe", message: "" });
    // a known code keeps the `executed` it was sent with
    for (const [code, executed] of [["busy", "no"], ["uncertain", "maybe"], ["internal", "maybe"]] as const) {
      const k = decode(AgentFrames, JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: false, error: { code, executed, message: "m" } }));
      expect(k.kind === "ok" && k.frame.t === "res" && !k.frame.ok ? k.frame.error : null, code).toEqual({ code, executed, message: "m" });
    }
  });
});

describe("messages, fleet → agent", () => {
  const msgs = [
    { v: 1, t: "challenge", nonce: NONCE, fleetSig: SIG },
    { v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false },
    { v: 1, t: "req", id: "r1", op: "pane.send", args: { workerId: W, text: "hi", expect: expectArgs }, timeoutMs: 10_000, key: "hub:ep1:req-1" },
    { v: 1, t: "req", id: "r2", op: "inventory.get", args: {}, timeoutMs: 5000 },
    { v: 1, t: "ack", streamId: UUID, seq: 12 },
  ];
  it("accepts every message the fleet sends, by t and as the union", () => {
    for (const m of msgs) {
      expect(kind(decode(FleetFrames, JSON.stringify(m))), m.t).toBe("ok");
      expect(z.safeParse(FleetMessage, m).success, m.t).toBe(true);
    }
  });
  it("a req for an op the agent doesn't know is still a req, so it can be answered unknown_op", () => {
    expect(kind(decode(FleetFrames, JSON.stringify({ ...msgs[3], op: "desktop.stream" })))).toBe("ok");
    expect((OP_NAMES as readonly string[]).includes("desktop.stream")).toBe(false);
  });
  it("refuses what doesn't fit (negative controls)", () => {
    for (const bad of [{ ...msgs[1], connEpoch: 0 }, { ...msgs[2], timeoutMs: 0 }, { ...msgs[2], key: "no-namespace" }, { ...msgs[4], streamId: "x" }, { ...msgs[0], fleetSig: "x" }]) {
      expect(kind(decode(FleetFrames, JSON.stringify(bad))), JSON.stringify(bad).slice(0, 80)).toBe("malformed");
    }
  });
});

describe("op arguments (what the agent acts on: strict)", () => {
  const ok = (op: OpName, args: unknown) => z.safeParse(OP_ARGS[op], args).success;
  it("accepts each op's arguments, window names with spaces, unicode, dots and slashes included", () => {
    expect(ok("inventory.get", {})).toBe(true);
    expect(ok("pane.captureMany", { workerIds: Array.from({ length: 64 }, (_, i) => `pc.3fa2c1d0.${i}`) })).toBe(true);
    expect(ok("pane.keys", { workerId: W, data: "\x1b[A", expect: { server: "3fa2c1d0", window: "w" } })).toBe(true);
    expect(ok("pane.send", { workerId: W, text: "x".repeat(8000), expect: expectArgs })).toBe(true);
    expect(ok("transcript.read", { sessionId: UUID, offset: 0, max: LIMITS.chunkBytes })).toBe(true);
    expect(ok("transcript.locate", { sessionId: UUID, needle: `"uuid":"${UUID}"` })).toBe(true);
    expect(ok("file.stat", { path: "/home/u/a.png" })).toBe(true);
    expect(ok("file.get", { ref: "r1", offset: 0, max: 1 })).toBe(true);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: Buffer.from("png").toString("base64"), final: true, name: "shot ü.png" })).toBe(true);
    expect(ok("lane.start", { name: "fix: a/b ü.2", cwd: "/w/repo", account: "acct2", resume: UUID })).toBe(true);
    expect(ok("worktree.add", { repo: "/w/repo", name: "fix/login", base: "main" })).toBe(true);
  });
  it("takes a message of up to maxMessageText in pane.send and lane.deliver, and in lane.start's first prompt", () => {
    const deliver = (text: string) => ok("lane.deliver", { id: "hub:k1", target: { lane: "w", sticky: false }, text });
    expect(ok("pane.send", { workerId: W, text: "ü".repeat(LIMITS.maxMessageText), expect: expectArgs })).toBe(true);
    expect(deliver("ü".repeat(LIMITS.maxMessageText))).toBe(true);
    expect(ok("pane.send", { workerId: W, text: "x".repeat(LIMITS.maxMessageText + 1), expect: expectArgs })).toBe(false);
    expect(deliver("x".repeat(LIMITS.maxMessageText + 1))).toBe(false);
    expect(ok("pane.send", { workerId: W, text: "", expect: expectArgs })).toBe(false);                    // a message is never empty
    expect(deliver("")).toBe(false);
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "x".repeat(LIMITS.maxMessageText) })).toBe(true);
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "x".repeat(LIMITS.maxMessageText + 1) })).toBe(false);
    expect(ok("lane.start", { name: "x", cwd: "/w", prompt: "" })).toBe(false);                            // a prompt is never empty
  });
  it("refuses what is too long, not a path, or could escape (negative controls)", () => {
    expect(ok("inventory.get", { all: true })).toBe(false);
    expect(ok("pane.captureMany", { workerIds: Array.from({ length: 65 }, (_, i) => `pc.3fa2c1d0.${i}`) })).toBe(false);
    expect(ok("pane.captureMany", { workerIds: ["%1"] })).toBe(false);
    expect(ok("pane.keys", { workerId: W, data: "x".repeat(4097), expect: expectArgs })).toBe(false);
    expect(ok("pane.send", { workerId: W, text: "x".repeat(LIMITS.maxMessageText + 1), expect: expectArgs })).toBe(false);
    expect(ok("pane.send", { workerId: W, text: "hi" })).toBe(false);                                  // no expectation
    expect(ok("pane.send", { workerId: W, text: "hi", expect: { ...expectArgs, window: "a\nb" } })).toBe(false);
    for (const sessionId of ["../../.ssh/id_rsa", "a/b", "a.b", ""]) expect(ok("transcript.size", { sessionId }), sessionId).toBe(false);
    expect(ok("transcript.read", { sessionId: UUID, offset: 0, max: LIMITS.chunkBytes + 1 })).toBe(false);
    expect(ok("transcript.locate", { sessionId: UUID, needle: "x".repeat(201) })).toBe(false);
    expect(ok("file.stat", {})).toBe(false);
    expect(ok("file.stat", { path: "/a", ref: "r1" })).toBe(false);
    expect(ok("file.stat", { path: "relative/a.png" })).toBe(false);
    expect(ok("file.get", { ref: "../x", offset: 0, max: 1 })).toBe(false);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: "not base64!", final: true, name: "a.png" })).toBe(false);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: "", final: true, name: "../a.png" })).toBe(false);
    expect(ok("lane.start", { name: "x", cwd: "/w", flags: "--dangerously-skip-permissions" })).toBe(true);   // unknown keys are dropped, never passed on
    const priority = { version: 1, mode: "keys-only", order: ["key-a"] };
    expect(ok("connections.priority", priority)).toBe(true);
    expect(ok("connections.priority", { ...priority, extra: true })).toBe(false);
    expect(ok("connections.revoke", { version: 1, name: "key-a", secret: "x" })).toBe(false);
    expect(STEP_UP_OPS.has("connections.priority")).toBe(true);
    expect(STEP_UP_OPS.has("connections.role")).toBe(true);
    expect(STEP_UP_OPS.has("connections.revoke")).toBe(true);
    expect(STEP_UP_OPS.has("connections.narrow")).toBe(false);
    expect(ALERT_KINDS).toContain("connection");
    expect(z.parse(OP_ARGS["lane.start"], { name: "x", cwd: "/w", flags: "--x" })).toEqual({ name: "x", cwd: "/w" });
    expect(ok("worktree.add", { repo: "/w", name: "../../etc", base: "main" })).toBe(false);
  });
  it("worktree.add: branch names as git takes them, slashes included (negative controls)", () => {
    const add = (name: string, base = "main") => ok("worktree.add", { repo: "/w/repo", name, base });
    for (const name of ["fix/login", "feat/fleet-core-hub", "release/1.2.3", "v1.0", "a_b", "x".repeat(200)]) expect(add(name), name).toBe(true);
    for (const name of ["../../etc", "a..b", "a//b", "a/", "/a", "-x", ".a", "a/.b", "a.", "a.lock", "a/b.lock/c", "a b", "a~1", "a^", "a:b",
      "a?", "a*", "a[b", "a\\b", "a@{1}", "ü", "HEAD", "", "x".repeat(201)]) {
      expect(add(name), name).toBe(false);
    }
    expect(add("fix/x", "a//b")).toBe(false);
  });
  it("lane.start: an account or resume id never passes as a flag (negative controls)", () => {
    const start = (o: Record<string, unknown>) => ok("lane.start", { name: "x", cwd: "/w", ...o });
    for (const account of ["acct2", "a", "pc-2", "a".repeat(32)]) expect(start({ account }), account).toBe(true);
    for (const account of ["--dangerously-skip-permissions", "-x", "-", "Acct", "acct_2", "a b", "a".repeat(33), ""]) expect(start({ account }), account).toBe(false);
    expect(start({ resume: UUID })).toBe(true);
    for (const resume of ["--fork-session", "-r", "abc", "3f1c2d4e5b6a4c7d8e9f0a1b2c3d4e5f", `${UUID}x`, "abc; rm -rf ~", ""]) expect(start({ resume }), resume).toBe(false);
  });
});

describe("op results (what a node reports: shape)", () => {
  it("accepts each op's result", () => {
    const results: { [O in OpName]: unknown } = {
      "inventory.get": { panes: [], invVersion: 0 }, "pane.captureMany": { captures: [{ workerId: W, text: null, truncated: false }] },
      "pane.frame": { frame: null }, "pane.keys": { ok: false }, "pane.send": { problem: null, typedAt: 1 }, "op.status": { state: "done", outcome: { problem: null } },
      "transcript.size": { size: null }, "transcript.read": { bytes: "", eof: true }, "transcript.locate": { offset: 12 },
      "file.stat": { size: 1, mtime: 1 }, "file.get": { bytes: "AAAA", size: 3, eof: true }, "file.put": { path: "/inbox/a.png" },
      "lane.start": { workerId: W }, "lane.stop": { ok: true }, "worktree.list": { worktrees: [{ path: "/w", branch: null }] }, "worktree.add": { path: "/w/x" },
      "pane.capture": { text: "$ ", truncated: false },
      "lane.deliver": { delivery: { id: "hub:k1", node: "pc", target: { lane: "manager" }, state: "queued", queuedAt: 1, notAfter: 2 } },
      "delivery.cancel": { delivery: { id: "hub:k1", node: "pc", target: { lane: "manager" }, state: "given_up", queuedAt: 1, notAfter: 2, why: "cancelled" } },
      "memory.sync": { committed: true, written: 2, removed: 1, skillDirs: ["/home/u/.claude/skills"], conflicts: [] },
      "job.cancel": { ok: true }, "job.notice": { ok: true }, "job.noticeResult": { ok: true },
      "connections.priority": { ok: true }, "connections.role": { ok: true }, "connections.revoke": { ok: true }, "connections.narrow": { ok: true },
    };
    for (const op of OP_NAMES) expect(z.safeParse(OP_RESULTS[op], results[op]).success, op).toBe(true);
    expect(z.safeParse(OP_RESULTS["pane.send"], { problem: "exploded", typedAt: 1 }).success).toBe(false);
  });
});

describe("the handshake's signing payloads", () => {
  it("are the spec's strings", () => {
    expect(fleetSigPayload("pc", NONCE)).toBe(`morndo-fleet/1/fleet\npc\n${NONCE}`);
    expect(nodeSigPayload("pc", NONCE)).toBe(`morndo-fleet/1/node\npc\n${NONCE}`);
  });
  it("sign and verify in both directions; one side's signature never passes as the other's", () => {
    const fleet = keys(), node = keys();
    const fleetSig = sign(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.privateKey);
    const nodeSig = sign(null, Buffer.from(nodeSigPayload("pc", NONCE)), node.privateKey);
    expect(verify(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.publicKey, fleetSig)).toBe(true);
    expect(verify(null, Buffer.from(nodeSigPayload("pc", NONCE)), node.publicKey, nodeSig)).toBe(true);
    // negative controls: the other side's payload, another node's name, a tampered signature
    expect(verify(null, Buffer.from(nodeSigPayload("pc", NONCE)), fleet.publicKey, fleetSig)).toBe(false);
    expect(verify(null, Buffer.from(fleetSigPayload("mac", NONCE)), fleet.publicKey, fleetSig)).toBe(false);
    const tampered = Buffer.from(fleetSig); tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(verify(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.publicKey, tampered)).toBe(false);
  });
  it("refuse a node name or nonce that could change the payload's lines", () => {
    expect(() => fleetSigPayload("pc\nmac", NONCE)).toThrow(TypeError);
    expect(() => nodeSigPayload("pc", `${NONCE}\nx`)).toThrow(TypeError);
  });
});

describe("the join string", () => {
  const join: JoinString = { url: "wss://cp.tail1234.ts.net/agent", fleetKey: spki(keys()), code: randomBytes(16).toString("base64url"), node: "pc" };
  const s = formatJoinString(join);
  it("parses back to what was formatted", () => {
    expect(s.startsWith("morndo-join:1:")).toBe(true);
    expect(parseJoinString(s)).toEqual(join);
    expect(parseJoinString(formatJoinString({ ...join, url: "ws://127.0.0.1:8791/agent" }))?.url).toBe("ws://127.0.0.1:8791/agent");
  });
  it("ws:// only to this machine's loopback; wss:// anywhere (negative controls)", () => {
    for (const url of ["ws://127.0.0.1:8791/agent", "ws://127.8.9.10/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent", "ws://127.0.0.1",
      "wss://100.64.0.1:443/agent", "wss://cp.tail1234.ts.net/agent"]) {
      expect(fleetUrlOk(url), url).toBe(true);
      expect(parseJoinString(formatJoinString({ ...join, url }))?.url, url).toBe(url);
    }
    for (const url of ["ws://100.64.0.1:8791/agent", "ws://cp.tail1234.ts.net/agent", "ws://127.0.0.1.nip.io/agent", "ws://127.0.0.1@evil.example/agent",
      "ws://127.0.0.1:8791@evil.example/", "ws://localhost.evil.example/agent", "ws://[::2]/agent", "ws://128.0.0.1/agent", "ws://127.0.0.256/agent",
      "http://127.0.0.1/agent", "ws:/127.0.0.1", "WS://127.0.0.1/agent", "wss://"]) {
      expect(fleetUrlOk(url), url).toBe(false);
      expect(() => formatJoinString({ ...join, url }), url).toThrow(TypeError);
      expect(parseJoinString(`morndo-join:1:${Buffer.from(JSON.stringify({ ...join, url })).toString("base64url")}`), url).toBeNull();
    }
  });
  it("as pasted: whitespace, quotes, a trailing newline, a wrapped line (Review Focus 5)", () => {
    const wrapped = `${s.slice(0, 40)}\n${s.slice(40, 90)}\r\n${s.slice(90)}`;
    for (const pasted of [`${s}\n`, `${s}\r\n`, `  ${s}  `, `'${s}'`, `"${s}"\n`, ` '${s}'\n`, `“${s}”`, `‘${s}’`, `\`${s}\``, wrapped, `"${wrapped}"\n`]) {
      expect(parseJoinString(pasted), JSON.stringify(pasted.slice(0, 20))).toEqual(join);
    }
  });
  it("a truncated string, cut anywhere, is null: never a partial join", () => {
    for (let n = 0; n < s.length; n++) expect(parseJoinString(s.slice(0, n)), `cut at ${n}`).toBeNull();
  });
  it("anything else is null (negative controls)", () => {
    for (const bad of ["", "morndo-join:1:", s.replace("morndo-join:1:", "morndo-join:2:"), s.replace("morndo-join:1:", ""), `${s}!`, `${s.slice(0, 30)}*${s.slice(31)}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, url: "http://x" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, node: "PC" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, code: "short" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from("[1,2]").toString("base64url")}`, `morndo-join:1:${Buffer.from([0xff, 0xfe]).toString("base64url")}`]) {
      expect(parseJoinString(bad), bad.slice(0, 40)).toBeNull();
    }
  });
  it("is the same base64url Node writes (the agent and the fleet may use Buffer on their side)", () => {
    const json = JSON.stringify({ url: join.url, fleetKey: join.fleetKey, code: join.code, node: join.node });
    expect(s).toBe(`morndo-join:1:${Buffer.from(json).toString("base64url")}`);
    const unicode = Buffer.from(JSON.stringify({ ...join, url: "wss://x/ä" })).toString("base64url");
    expect(parseJoinString(`morndo-join:1:${unicode}`)).toBeNull();                 // the URL is ASCII; the decode itself is UTF-8
  });
  it("format refuses what it couldn't parse back", () => {
    for (const bad of [{ ...join, url: "https://x" }, { ...join, fleetKey: "AAAA" }, { ...join, code: "x" }, { ...join, node: "a.b" }]) {
      expect(() => formatJoinString(bad), JSON.stringify(bad).slice(0, 60)).toThrow(TypeError);
    }
  });
});

describe("error codes", () => {
  it("cover the spec's table", () => {
    const codes: ErrorCode[] = ["bad_args", "unknown_op", "denied", "no_pane", "menu_open", "no_input_box", "draft_present", "busy", "name_taken", "lane_conflict", "too_large", "timeout", "node_offline", "uncertain", "internal", "updating", "not_allowed",
      "id_conflict", "no_session", "already_typed"];
    expect(Object.keys(ERROR_EXECUTED).sort()).toEqual([...codes].sort());
  });
});

describe("memory.sync arguments (ADR-0031: Memory's own skills only, in parts under the message limit)", () => {
  const sync = (a: unknown) => z.safeParse(OP_ARGS["memory.sync"], a).success;
  const file = (name: string, content = "---\nname: x\n---\n") => ({ name, content });
  const good = { version: "0123456789abcdef", part: 0, parts: 1, files: [file("morndo-mem-repo-shop-api-facts")] };
  it("accepts Memory's skill files", () => {
    expect(sync(good)).toBe(true);
    expect(sync({ ...good, files: [] })).toBe(true);
    expect(sync({ ...good, part: 2, parts: 3 })).toBe(true);
  });
  it("refuses another skill's name, a path, a bad version or a part past the last", () => {
    for (const name of ["my-skill", "morndo-mem-../x", "morndo-mem-a/b", "morndo-mem-", "morndo-mem--x", "morndo-mem-x-", "Morndo-mem-x", `morndo-mem-${"a".repeat(60)}`]) {
      expect(sync({ ...good, files: [file(name)] }), name).toBe(false);
    }
    expect(sync({ ...good, version: "xyz" })).toBe(false);
    expect(sync({ ...good, part: 1, parts: 1 })).toBe(false);
    expect(sync({ ...good, files: [file("morndo-mem-x", "a".repeat(LIMITS.memorySkillBytes + 1))] })).toBe(false);
  });
});
