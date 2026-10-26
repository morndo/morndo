// The client API over its Unix socket (spec 5.6): versions and caps, nodes, lanes (odd names survive the URLs, one
// path segment each, Review Focus 1; a name in conflict is reported and never routed by), alerts, ops (each answer
// with its store; side-effecting ones audited with the client that asked), files streamed in chunks, the events
// WebSocket (a client that falls too far behind is closed with 1013), and revocation, from the console too: whichever
// way a node is revoked, its lanes go.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS, type Alert } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { health, type FakeAgent } from "./helpers/fake-agent.ts";
import { ODD_NAMES } from "./helpers/odd-names.ts";
import { client } from "./helpers/socket-client.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
afterEach(() => { vi.useRealTimers(); });

async function withLanes(fleet: TestFleet, node: string, names: string[]): Promise<FakeAgent> {
  const a = await fleet.online(node);
  a.inventory(names.map((window, i) => ({ workerId: `${node}.3fa2c1d0.${i}`, window, cwd: "/work" })));
  await vi.waitFor(() => expect(fleet.lanes.list()).toHaveLength(names.length));
  return a;
}

// Serves file.stat and file.get from memory, as a node would after its confinement checks.
function serveFiles(a: FakeAgent, files: Map<string, Buffer>) {
  a.answer = req => {
    const args = req.args as { path?: string; ref?: string; offset?: number; max?: number };
    const file = files.get(args.path ?? args.ref ?? "");
    if (req.op === "file.stat") return file ? { ok: true, result: { size: file.length, mtime: 1 } } : { ok: false, error: { code: "denied", executed: "no", message: "denied" } };
    if (req.op === "file.get" && file) {
      const bytes = file.subarray(args.offset ?? 0, (args.offset ?? 0) + (args.max ?? 0));
      return { ok: true, result: { bytes: bytes.toString("base64"), size: file.length, eof: (args.offset ?? 0) + bytes.length >= file.length } };
    }
    return { ok: true, result: {} };
  };
}

describe("the client API", () => {
  it("speaks /v1/ and lists its versions and sticky lane names; another version or route is a 404", async () => {
    const fleet = await startTestFleet({ config: { stickyLanes: ["manager", "ops lead"] } });
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/caps")).toEqual({ status: 200, body: { api: [1], stickyLanes: ["manager", "ops lead"] } });
    expect(await api.get("/v9/caps")).toEqual({ status: 404, body: { error: "unsupported_api", api: [1] } });
    expect(await api.get("/caps")).toMatchObject({ status: 404 });
    expect(await api.get("/v1/nothing-here")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  it("lists nodes with status, health and agent version", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.health(health({ load1: 2 }));
    await fleet.joined("mac");
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    expect((await client(fleet.config.socketPath).get("/v1/nodes"))?.body).toEqual([
      { name: "mac", status: "offline", health: null, agent: null, commit: null, proto: null, update: null },
      { name: "pc", status: "online", health: expect.objectContaining({ load1: 2 }), agent: "test-agent/1", commit: null, proto: [1], update: null },
    ]);
  });

  it("/v1/nodes lists each node's build", async () => {
    const fleet = await startTestFleet();
    const old = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const fresh = "0123456789abcdef0123456789abcdef01234567";
    await fleet.online("pc", { commit: old });
    await fleet.online("mac", { commit: fresh });
    await fleet.online("vm");                                      // an older agent: its hello has no commit
    const body = (await client(fleet.config.socketPath).get("/v1/nodes"))?.body as { name: string; agent: string | null; commit: string | null }[];
    expect(body.map(n => [n.name, n.agent, n.commit])).toEqual([["mac", "test-agent/1", fresh], ["pc", "test-agent/1", old], ["vm", "test-agent/1", null]]);
  });

  it("lane names with spaces, unicode, dots and slashes survive the list, their own URL and an op by lane", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ODD_NAMES);
    const api = client(fleet.config.socketPath);
    const listed = (await api.get("/v1/lanes"))?.body as { name: string }[];
    expect(listed.map(l => l.name).sort()).toEqual([...ODD_NAMES].sort());
    for (const [i, name] of ODD_NAMES.entries()) {
      expect(await api.get(`/v1/lanes/${encodeURIComponent(name)}`), name).toEqual({ status: 200, body: { name, node: "pc", workerId: `pc.3fa2c1d0.${i}`, conflict: false } });
      const r = await api.post("/v1/op", { lane: name, op: "pane.frame", args: {} });
      expect(r?.status, name).toBe(200);
      expect(a.reqs.at(-1)?.args, name).toEqual({ workerId: `pc.3fa2c1d0.${i}` });
    }
    expect(await api.get(`/v1/lanes/${encodeURIComponent("fix: a")}`)).toEqual({ status: 404, body: { error: "no_such_lane" } });
    expect((await api.get("/v1/lanes/fix%3A%20a/b%20%C3%BC.2"))?.status).toBe(404);    // unencoded "/" is another segment
  });

  it("POST /v1/op answers the outcome; a body that doesn't fit is 400 bad_args, and not JSON is 415, both in the op's shape", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => ({ ok: true, result: { panes: [], invVersion: 3 } });
    const api = client(fleet.config.socketPath);
    expect(await api.post("/v1/op", { node: "pc", op: "inventory.get", args: {} })).toEqual({ status: 200, body: { ok: true, result: { panes: [], invVersion: 3 }, invVersion: 1, store: a.store, storeSeq: null } });
    a.storeSeq = 4;                                                                // the agent's store sequence, passed on (final review I2)
    expect(await api.post("/v1/op", { node: "pc", op: "inventory.get", args: {} })).toMatchObject({ status: 200, body: { ok: true, store: a.store, storeSeq: 4 } });
    for (const body of [{ op: "inventory.get", args: {} }, { node: "pc", lane: "x", op: "inventory.get", args: {} }, { node: "pc", op: "exec", args: {} },
      { node: "pc", op: "inventory.get" }, { node: "pc", op: "inventory.get", args: [] },
      { node: "pc", op: "pane.send", args: {}, key: "no namespace" }, { node: "pc", op: "pane.send", args: {}, key: "kira-2:1" },
      { node: "pc", op: "inventory.get", args: {}, timeoutMs: 0 }, { node: "pc", op: "inventory.get", args: {}, extra: 1 },
      { node: "pc", op: "pane.send", args: {}, expect: { server: "3fa2c1d0", window: "w" } }]) {   // expect goes inside args
      expect(await api.post("/v1/op", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" }, store: null, storeSeq: null } });
    }
    for (const o of [{ body: "{}" }, { body: "{not json", headers: { "content-type": "application/json" } }]) {
      const r = await api.raw("/v1/op", { method: "POST", ...o });
      expect(r.status).toBe(415);
      expect(JSON.parse(r.body.toString())).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" }, store: null, storeSeq: null });
    }
    expect(await api.post("/v1/op", { node: "mac", op: "inventory.get", args: {} })).toMatchObject({ status: 200, body: { ok: false, error: { code: "node_offline", executed: "no" }, store: null, storeSeq: null } });
  });

  it("two windows of one name on one node: the lane reads as in conflict with no worker, every route by the name is refused, and each pane is still reachable by its worker ID", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "claude", cwd: "/a" }, { workerId: "pc.3fa2c1d0.2", window: "claude", cwd: "/b" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("claude")?.conflict).toBe(true));
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/lanes/claude")).toEqual({ status: 200, body: { name: "claude", node: "pc", workerId: null, conflict: true } });
    expect((await api.post("/v1/op", { lane: "claude", op: "pane.send", args: { text: "x" }, key: "lanes:1" }))?.body)
      .toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    expect(a.reqs).toEqual([]);
    for (const workerId of ["pc.3fa2c1d0.1", "pc.3fa2c1d0.2"]) {
      expect((await api.post("/v1/op", { workerId, op: "pane.frame", args: {} }))?.body, workerId).toMatchObject({ ok: true, store: a.store });
    }
    expect(a.reqs.map(r => r.args)).toEqual([{ workerId: "pc.3fa2c1d0.1" }, { workerId: "pc.3fa2c1d0.2" }]);
  });

  it("audits a side-effecting op with the client named in x-morndo-client (unknown when it names none or a bad one)", async () => {
    const fleet = await startTestFleet();
    await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    const W = "pc.3fa2c1d0.4";
    const body = (key: string) => JSON.stringify({ workerId: W, op: "pane.send", args: { workerId: W, text: "words", expect: { server: "3fa2c1d0", window: "api" } }, key });
    for (const [key, header] of [["hub:r1", "hub"], ["hub:r2", undefined], ["hub:r3", "Hub!"]] as const) {
      const r = await api.raw("/v1/op", { method: "POST", body: body(key), headers: { "content-type": "application/json", ...(header ? { "x-morndo-client": header } : {}) } });
      expect(r.status).toBe(200);
    }
    expect(fleet.audit.of("op.pane.send").map(e => e.detail.client)).toEqual(["hub", "unknown", "unknown"]);
  });

  it("streams a file in chunks of at most 256 KiB, its path one URL-encoded segment, spaces, unicode and slashes intact", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const path = "/home/u/my files/ü.2/a b.bin";
    const content = Buffer.from(Array.from({ length: 2 * LIMITS.chunkBytes + 1000 }, (_, i) => i % 251));
    serveFiles(a, new Map([[path, content], ["r0123456789abcdef", Buffer.from("relay copy")]]));
    const api = client(fleet.config.socketPath);
    const r = await api.raw(`/v1/files/pc/${encodeURIComponent(path)}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-file-size"]).toBe(String(content.length));
    expect(r.body.equals(content)).toBe(true);
    expect(a.reqs.map(q => [q.op, (q.args as { offset?: number }).offset])).toEqual([["file.stat", undefined], ["file.get", 0], ["file.get", 262144], ["file.get", 524288]]);
    expect(a.reqs[0]?.args).toEqual({ path });
    expect((await api.raw("/v1/files/pc/r0123456789abcdef")).body.toString()).toBe("relay copy");
    expect(a.reqs.at(-1)?.args).toMatchObject({ ref: "r0123456789abcdef" });
    const denied = await api.raw(`/v1/files/pc/${encodeURIComponent("/etc/shadow")}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body.toString())).toEqual({ ok: false, error: { code: "denied", executed: "no", message: "denied" } });
    const offline = await api.raw(`/v1/files/mac/${encodeURIComponent(path)}`);
    expect(offline.status).toBe(503);
    expect(JSON.parse(offline.body.toString())).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
  });

  // A download that fails after its first byte must end as an incomplete response (or a reset), never a clean short body.
  it("a file.get that fails mid-stream (busy) leaves the client an incomplete response, not a complete body", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const content = Buffer.alloc(2 * LIMITS.chunkBytes + 10, 7);
    let gets = 0;
    const r = await (async () => {
      serveFiles(a, new Map([["/home/u/f.bin", content]]));
      const inner = a.answer;
      a.answer = req => req.op === "file.get" && ++gets === 2 ? { ok: false, error: { code: "busy", executed: "no", message: "busy" } } : inner(req);
      return client(fleet.config.socketPath).raw(`/v1/files/pc/${encodeURIComponent("/home/u/f.bin")}`).then(x => x, () => null);
    })();
    expect(gets).toBe(2);
    expect(r === null || (r.status === 200 && !r.complete)).toBe(true);
    if (r) expect(r.body.length).toBeLessThan(content.length);
  });

  it("a node that reports eof before the stat size (the file shrank) leaves an incomplete response, not a clean short body", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const content = Buffer.alloc(LIMITS.chunkBytes + 10, 7);
    serveFiles(a, new Map([["/home/u/f.bin", content]]));
    const inner = a.answer;
    a.answer = req => {
      if (req.op !== "file.get") return inner(req);
      const first = (req.args as { offset: number }).offset === 0;
      return { ok: true, result: { bytes: first ? content.subarray(0, 1000).toString("base64") : "", size: content.length, eof: true } };
    };
    const r = await client(fleet.config.socketPath).raw(`/v1/files/pc/${encodeURIComponent("/home/u/f.bin")}`).then(x => x, () => null);
    expect(r === null || (r.status === 200 && !r.complete)).toBe(true);
    if (r) expect(r.body.length).toBeLessThan(content.length);
  });

  it("a node that sends more bytes than the stat size (the file grew) never gets past x-file-size", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const inner = (serveFiles(a, new Map([["/home/u/f.bin", Buffer.alloc(100, 7)]])), a.answer);
    a.answer = req => req.op === "file.get" ? { ok: true, result: { bytes: Buffer.alloc(600, 7).toString("base64"), size: 100, eof: false } } : inner(req);
    const r = await client(fleet.config.socketPath).raw(`/v1/files/pc/${encodeURIComponent("/home/u/f.bin")}`).then(x => x, () => null);
    expect(r === null || (r.status === 200 && !r.complete)).toBe(true);
    if (r) expect(r.body.length).toBeLessThanOrEqual(100);
  });

  it("the events socket starts with every node's status, then each online node's inventory and health, every Run, then each change", async () => {
    const fleet = await startTestFleet();
    const gone = await fleet.online("gone");
    gone.inventory([{ workerId: "gone.3fa2c1d0.1", window: "old", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.connections.latest("gone").inventory).not.toBeNull());
    await gone.close();                                                                // offline: its latest inventory is not sent
    await vi.waitFor(() => expect(fleet.connections.status("gone")).toBe("offline"));
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }]);
    a.health(health({ load1: 3 }));
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    await vi.waitFor(() => expect(fleet.runs.view().map(r => `${r.lane}:${r.phase}`)).toEqual(["api:ended", "old:unknown"]));
    const ev = await client(fleet.config.socketPath).events();
    // Every lane's Run last, by lane (ADR-0032): gone's old window is unknown while gone is offline.
    await vi.waitFor(() => expect(ev.received.map(e => `${e.t}:${e.node}`)).toEqual(["status:gone", "status:pc", "inventory:pc", "health:pc", "run:pc", "run:gone"]));
    expect(ev.received.slice(0, 3).map(e => e.body)).toEqual([
      { status: "offline" }, { status: "online" }, { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: null, pid: null }], invVersion: 2 },
    ]);
    const b = await fleet.online("mac");
    b.inventory([{ workerId: "mac.3fa2c1d0.1", window: "api", cwd: "/w" }]);
    const changes = () => ev.received.slice(6).filter(e => e.t !== "run");
    await vi.waitFor(() => expect(changes().map(e => `${e.t}:${e.node}`)).toEqual(["status:mac", "inventory:mac", "conflict:pc", "alert:pc"]));
    expect(changes().at(-2)?.body).toEqual({ name: "api", nodes: ["pc", "mac"] });
    expect([changes().at(-1)?.body]).toEqual((await client(fleet.config.socketPath).get("/v1/alerts"))?.body);
    ev.close();
  });

  it("GET /v1/alerts serves every alert as an Alert, oldest first, and each one is an alert event as it is raised", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/alerts")).toEqual({ status: 200, body: [] });
    const ev = await api.events();
    const a = await fleet.online("pc");
    const clone = fleet.agent({ node: "pc", key: a.key });
    expect((await clone.connect()).ok).toBe(false);                                   // instance_conflict
    a.health(health({ wallClock: Date.now() + 60_000 }));                              // clock_offset
    await vi.waitFor(() => expect(fleet.audit.of("alert.clock_offset")).toHaveLength(1));
    const alerts = (await api.get("/v1/alerts"))?.body as Alert[];
    expect(alerts.map(x => [x.kind, x.node])).toEqual([["instance_conflict", "pc"], ["clock_offset", "pc"]]);
    expect(alerts[0]).toEqual({ id: expect.any(Number), at: expect.any(Number), node: "pc", kind: "instance_conflict", detail: { live: a.instanceId, refused: clone.instanceId, source: "127.0.0.1" } });
    expect(alerts[1]?.detail).toEqual({ offsetMs: expect.any(Number) });
    expect(alerts[0]?.id).toBeLessThan(alerts[1]?.id ?? 0);
    await vi.waitFor(() => expect(ev.received.filter(e => e.t === "alert").map(e => e.body)).toEqual(alerts));
    expect(ev.received.filter(e => e.t === "alert").map(e => e.node)).toEqual(["pc", "pc"]);
    ev.close();
  });

  it("an events client that falls too far behind is closed with 1013 and gets no more events", async () => {
    const fleet = await startTestFleet({ eventsBufferBytes: 64 << 10 });
    const ev = await client(fleet.config.socketPath).events();
    const closed = new Promise<number>(r => ev.ws.once("close", code => r(code)));
    ev.ws.pause();                                                                    // it stops reading
    const pad = "x".repeat(32 << 10);
    for (let i = 0; i < 400; i++) fleet.events.emit({ t: "health", node: "pc", body: { pad, i } });   // 12.8 MB
    ev.ws.resume();
    expect(await closed).toBe(1013);                                                 // negative control: without the cap, all 400 and no close
    expect(ev.received.length).toBeLessThan(400);
  });

  it("revoking through the socket closes the node's connection with 4403 and drops its lanes", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    const api = client(fleet.config.socketPath);
    expect(await api.post("/v1/nodes/pc/revoke")).toEqual({ status: 200, body: { ok: true, revoked: true } });
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect((await api.get("/v1/lanes"))?.body).toEqual([]);
    expect((await api.get("/v1/nodes"))?.body).toEqual([]);
    expect(fleet.audit.of("node.revoke").map(e => [e.actor, e.node])).toEqual([["client", "pc"]]);
    expect(await api.post("/v1/nodes/Not%20A%20Name/revoke")).toMatchObject({ status: 400 });
  });

  it("the console's `node revoke` and `status` reach the running service, and the node's lanes go", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    const config = join(fleet.dir, "fleet.json");
    writeFileSync(config, JSON.stringify({ socketPath: fleet.config.socketPath, dbPath: fleet.config.dbPath, keyPath: fleet.config.keyPath }));
    // Asynchronously: the service runs in this process, and a synchronous spawn would stop it from answering.
    const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ["--no-warnings", MAIN, ...args], { env: { ...process.env, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 },
        (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr }));
    });
    const status = await run("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/fleet service: running/);
    expect(status.stdout).toMatch(/^\s+pc\s+online\s+agent test-agent\/1$/m);
    const revoked = await run("node", "revoke", "pc");
    expect(revoked.stdout).toMatch(/revoked pc; its connection, if any, is closed/);
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect((await client(fleet.config.socketPath).get("/v1/lanes"))?.body).toEqual([]);
  }, 30_000);

  it("a revocation written to fleet.db while the node is offline (the console, when the service didn't answer): its lanes go within one interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(fleet.lanes.list().map(l => l.name)).toEqual(["api"]);                     // kept while offline
    fleet.nodes.revoke("pc");                                                         // what `node revoke` writes
    vi.advanceTimersByTime(LIMITS.pingMs);
    expect((await client(fleet.config.socketPath).get("/v1/lanes"))?.body).toEqual([]);   // negative control: kept until a restart
  });
});
