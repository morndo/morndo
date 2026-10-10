// The hub's fleet client (spec §5.6) against the fake fleet on a real Unix socket: capabilities, nodes, lanes and
// alerts, an op's body and its answers (each with the store of the node that answered, none for the fleet's own
// refusals), routing by a lane's name, a file streamed in chunks, events and their reconnect after the fleet restarts,
// and the ways the fleet can fail to be one: never reached (nothing can have happened), reached without an answer in
// time (it may have), and an answer that isn't the client API. Every request names its client.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Alert } from "@morndo/protocol";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, checkFleet, type FleetEvent } from "../src/adapters/fleet-client.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const PC1 = "pc.aaaaaaaa.1";
const NOTES = Buffer.from("n".repeat(300_000));
let dir: string;
let fleet: FakeFleet;
let stops: (() => void)[] = [];
const pcNode = () => localNode("pc", "aaaaaaaa", memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "$ " } }, { files: { "/w/alpha/notes.txt": NOTES } }));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-client-"));
  fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
});
afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  await fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the fleet client (spec §5.6)", () => {
  it("reads the capabilities, the nodes and the lanes", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.caps()).toEqual({ api: [1] });
    expect(await checkFleet(c)).toBe("ok");
    expect(await c.nodes()).toEqual([{ name: "pc", status: "online", health: null, agent: "fake" }]);
    expect(await c.lanes()).toEqual([{ name: "alpha", node: "pc", workerId: PC1, conflict: false }]);
    expect(fleet.clients.length).toBeGreaterThan(0);
    expect(new Set(fleet.clients)).toEqual(new Set(["hub"]));                        // x-morndo-client, for the fleet's audit
  });

  it("posts an op with its target, args, key and deadline, and returns the node's answer", async () => {
    const c = new FleetClient(fleet.socketPath);
    const r = await c.op({ node: "pc" }, "pane.captureMany", { workerIds: [PC1] }, { timeoutMs: 1500 });
    expect(r).toEqual({ ok: true, result: { captures: [{ workerId: PC1, text: "$ ", truncated: false }] }, invVersion: expect.any(Number), store: fleet.node("pc").store, storeSeq: 0 });
    const sent = await c.op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k1" });
    expect(sent).toMatchObject({ ok: true, result: { problem: null } });
    expect(fleet.calls).toEqual([
      { op: "pane.captureMany", node: "pc", target: { node: "pc" }, args: { workerIds: [PC1] }, key: null, timeoutMs: 1500 },
      { op: "pane.send", node: "pc", target: { workerId: PC1 }, args: { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, key: "hub:k1", timeoutMs: 5000 },
    ]);
  });

  it("passes the fleet's refusals through as they are", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.op({ node: "nowhere" }, "inventory.get", {})).toEqual({ ok: false, error: { code: "no_pane", executed: "no", message: "no such node" }, store: null, storeSeq: null });
    await fleet.setStatus("pc", "offline");
    expect(await c.op({ node: "pc" }, "inventory.get", {})).toEqual({ ok: false, error: { code: "node_offline", executed: "no", message: "the node is not online" }, store: null, storeSeq: null });
  });

  it("routes by a lane's name; a name two windows claim is one registry row, in conflict, and routing by it is lane_conflict", async () => {
    const c = new FleetClient(fleet.socketPath);
    const sent = await c.op({ lane: "alpha" }, "pane.send", { workerId: PC1, text: "by name", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k-lane" });
    expect(sent).toMatchObject({ ok: true, store: fleet.node("pc").store });
    await fleet.close();
    const twice = memoryBackend({ "%1": { name: "alpha", cwd: "/w/a", screen: "$ " }, "%2": { name: "alpha", cwd: "/w/b", screen: "$ " } });
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", twice)], socketPath: join(dir, "fleet.sock") });
    expect(await c.lanes()).toEqual([{ name: "alpha", node: "pc", workerId: null, conflict: true }]);
    expect(await c.op({ lane: "alpha" }, "pane.send", { workerId: PC1, text: "never", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k-c" }))
      .toEqual({ ok: false, error: { code: "lane_conflict", executed: "no", message: "two windows claim this lane" }, store: null, storeSeq: null });
    expect(twice.typed).toEqual([]);
  });

  it("streams a file in chunks; a file the node refuses is FleetOpFailed with the node's reason", async () => {
    const c = new FleetClient(fleet.socketPath);
    const chunks: Uint8Array[] = [];
    for await (const chunk of c.fileStream("pc", "/w/alpha/notes.txt")) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(NOTES)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    const refused = await (async () => { for await (const chunk of c.fileStream("pc", "/etc/shadow")) chunks.push(chunk); })().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FleetOpFailed);
    expect((refused as FleetOpFailed).error).toEqual({ code: "denied", executed: "no", message: "not readable" });
    await fleet.setStatus("pc", "offline");
    const offline = await (async () => { for await (const chunk of c.fileStream("pc", "/w/alpha/notes.txt")) chunks.push(chunk); })().catch((e: unknown) => e);
    expect((offline as FleetOpFailed).error).toEqual({ code: "node_offline", executed: "no", message: "node_offline" });
  });

  // Lane FB's new kind (final review I3, ADR-0012 decision 8): hook events for a path no subscriber takes. Its AlertKind
  // arrives in packages/protocol at the merge; until then the hub lists the string itself, so it is never filtered out.
  it("keeps an unrouted_hook alert, and still leaves out a kind it doesn't know", async () => {
    const c = new FleetClient(fleet.socketPath);
    const unrouted = { id: 1, at: 1_791_000_000_000, node: "pc", kind: "unrouted_hook", detail: { path: "/hook/stop", count: 3 } } as unknown as Alert;
    fleet.raise(unrouted);
    fleet.raise({ id: 2, at: 1_791_000_000_100, node: null, kind: "from_a_newer_fleet", detail: {} } as unknown as Alert);
    expect(await c.alerts()).toEqual([unrouted]);
  });

  it("reads the alerts, oldest first, and gets each new one as an event", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.alerts()).toEqual([]);
    const seen: FleetEvent[] = [];
    stops.push(c.events(e => seen.push(e)));
    await until(() => seen.some(e => e.t === "status"));
    const first: Alert = { id: 1, at: 1_791_000_000_000, node: "pc", kind: "clock_offset", detail: { offsetMs: 2500 } };
    const second: Alert = { id: 2, at: 1_791_000_000_500, node: null, kind: "backlog_full", detail: { subscriber: "lanes", cap: 50_000, droppedProgress: 12, deadLettered: 0 } };
    fleet.raise(first);
    fleet.raise(second);
    expect(await c.alerts()).toEqual([first, second]);
    await until(() => seen.filter(e => e.t === "alert").length === 2);
    expect(seen.filter(e => e.t === "alert")).toEqual([{ t: "alert", node: "pc", body: first }, { t: "alert", node: "", body: second }]);
  });

  it("delivers events, the state first, and subscribes again after the fleet restarts", async () => {
    const c = new FleetClient(fleet.socketPath);
    const seen: FleetEvent[] = [];
    stops.push(c.events(e => seen.push(e)));
    await until(() => seen.some(e => e.t === "inventory" && e.node === "pc"));
    expect(seen[0]).toEqual({ t: "status", node: "pc", body: { status: "online" } });
    await fleet.close();
    seen.length = 0;
    fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
    await until(() => seen.some(e => e.t === "status" && e.node === "pc"), 10_000);
  });

  it("delivers events over a socket path with a space, a non-ASCII letter, ':' and '#' in it, as HTTP does", async () => {
    await fleet.close();
    const odd = join(dir, "a b:ü#1");
    mkdirSync(odd);
    fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(odd, "fleet.sock") });
    const c = new FleetClient(fleet.socketPath);
    expect(await c.nodes()).toEqual([{ name: "pc", status: "online", health: null, agent: "fake" }]);     // HTTP: the raw path
    const seen: FleetEvent[] = [];
    stops.push(c.events(e => seen.push(e)));
    await until(() => seen.some(e => e.t === "inventory" && e.node === "pc"));
  });

  it("no socket: unavailable without having reached the fleet, so nothing can have happened", async () => {
    const none = new FleetClient(join(dir, "missing.sock"));
    const e = await none.nodes().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FleetUnavailable);
    expect((e as FleetUnavailable).reached).toBe(false);
    expect(await checkFleet(none)).toBe("unreachable");
    const tooLong = await new FleetClient(join(dir, `${"x".repeat(120)}.sock`)).nodes().catch((x: unknown) => x);   // over the path limit
    expect((tooLong as FleetUnavailable).reached).toBe(false);
  });

  it("an op the fleet doesn't answer in time: unavailable, reached (it may have happened)", async () => {
    fleet.intercept("pane.send", () => new Promise(() => {}));
    const c = new FleetClient(fleet.socketPath);
    const e = await c.op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k2", timeoutMs: 100 })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FleetUnavailable);
    expect((e as FleetUnavailable).reached).toBe(true);
  });

  it("a server that isn't the fleet's client API is a mismatch; a fleet without this API version is unsupported", async () => {
    const strangerPath = join(dir, "stranger.sock");
    const stranger = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); });
    await new Promise<void>(resolve => stranger.listen(strangerPath, () => resolve()));
    try {
      const c = new FleetClient(strangerPath);
      await expect(c.caps()).rejects.toBeInstanceOf(FleetMismatch);
      expect(await checkFleet(c)).toBe("unsupported");
    } finally {
      await new Promise<void>(resolve => stranger.close(() => resolve()));
    }
    await fleet.close();
    fleet = await startFakeFleet({ nodes: [], api: [2, 3], socketPath: join(dir, "fleet.sock") });
    expect(await checkFleet(new FleetClient(fleet.socketPath))).toBe("unsupported");
  });

  describe("a download that isn't whole, and the events' resync", () => {
    const read = async (c: FleetClient) => { const out: Uint8Array[] = []; for await (const chunk of c.fileStream("pc", "/w/alpha/notes.txt")) out.push(chunk); return out; };

    it("a file the fleet ends cleanly short of x-file-size is an error, never a whole file", async () => {
      fleet.fileFault("truncate");
      const e = await read(new FleetClient(fleet.socketPath)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    });

    it("a response destroyed mid-stream is FleetUnavailable, reached", async () => {
      fleet.fileFault("abort");
      const e = await read(new FleetClient(fleet.socketPath)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    });

    it("more bytes than x-file-size is a mismatch, and the excess is never yielded", async () => {
      fleet.fileFault("overrun");
      const got: Uint8Array[] = [];
      const e = await (async () => { for await (const chunk of new FleetClient(fleet.socketPath).fileStream("pc", "/w/alpha/notes.txt")) got.push(chunk); })().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetMismatch);
      expect(got.reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(NOTES.length);
    });

    it("a missing or non-numeric x-file-size is a mismatch", async () => {
      for (const mode of ["no-size", "bad-size"] as const) {
        fleet.fileFault(mode);
        expect(await read(new FleetClient(fleet.socketPath)).catch((x: unknown) => x)).toBeInstanceOf(FleetMismatch);
      }
    });

    // The overrun check also throws FleetMismatch, so the class alone can't tell the header guard from it: the message must.
    it("a body of normal length with no x-file-size is refused for the header, not as an overrun, and nothing is yielded", async () => {
      fleet.fileFault("no-size");
      const got: Uint8Array[] = [];
      const e = await (async () => { for await (const chunk of new FleetClient(fleet.socketPath).fileStream("pc", "/w/alpha/notes.txt")) got.push(chunk); })().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetMismatch);
      expect((e as FleetMismatch).message).toContain("x-file-size is null");
      expect((e as FleetMismatch).message).not.toMatch(/more than/);
      expect(got).toHaveLength(0);
    });

    it("a normal file still streams whole", async () => {
      fleet.fileFault(null);
      expect(Buffer.concat(await read(new FleetClient(fleet.socketPath))).equals(NOTES)).toBe(true);
    });

    it("onOpen runs on the first open and again after the fleet drops the events socket (1013)", async () => {
      const c = new FleetClient(fleet.socketPath);
      let opened = 0;
      stops.push(c.events(() => {}, { onOpen: () => { opened++; } }));
      await until(() => opened === 1);
      fleet.dropEvents(1013);
      await until(() => opened === 2, 10_000);
    });

    it("an op answer that isn't an op answer leaves the op in doubt: unavailable, reached", async () => {
      fleet.intercept("pane.send", async () => ({ nope: true }) as never);
      const e = await new FleetClient(fleet.socketPath).op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k3" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FleetUnavailable);
      expect((e as FleetUnavailable).reached).toBe(true);
    });

    it("reads the store sequence the fleet passes on, and takes anything but a count as none (final review I2)", async () => {
      const path = join(dir, "seq.sock");
      let storeSeq: unknown;
      const stub = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { state: "unknown" }, invVersion: 1, store: "s-1", ...(storeSeq === undefined ? {} : { storeSeq }) }));
      });
      await new Promise<void>(resolve => stub.listen(path, () => resolve()));
      try {
        const c = new FleetClient(path);
        const seqOf = async (v: unknown) => { storeSeq = v; return (await c.op({ node: "pc" }, "op.status", { key: "hub:k" })).storeSeq; };
        expect(await seqOf(0)).toBe(0);
        expect(await seqOf(41)).toBe(41);
        for (const v of [undefined, null, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 2]) expect(await seqOf(v), String(v)).toBeNull();
      } finally {
        await new Promise<void>(resolve => { stub.close(() => resolve()); stub.closeAllConnections(); });
      }
    });

    it("a 5xx on a read route is unavailable (reached), so checkFleet doesn't call it unsupported", async () => {
      const path = join(dir, "five.sock");
      const broken = createServer((_req, res) => { res.writeHead(500, { "content-type": "text/plain" }); res.end("oops"); });
      await new Promise<void>(resolve => broken.listen(path, () => resolve()));
      try {
        const c = new FleetClient(path);
        const e = await c.nodes().catch((x: unknown) => x);
        expect(e).toBeInstanceOf(FleetUnavailable);
        expect((e as FleetUnavailable).reached).toBe(true);
        expect(await checkFleet(c)).toBe("unreachable");
      } finally {
        await new Promise<void>(resolve => { broken.close(() => resolve()); broken.closeAllConnections(); });
      }
    });

    it("an op answered with a body that isn't JSON (an HTML 502) is in doubt: unavailable, reached", async () => {
      const path = join(dir, "html.sock");
      const proxy = createServer((_req, res) => { res.writeHead(502, { "content-type": "text/html" }); res.end("<html>bad gateway</html>"); });
      await new Promise<void>(resolve => proxy.listen(path, () => resolve()));
      try {
        const e = await new FleetClient(path).op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k4" }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(FleetUnavailable);
        expect((e as FleetUnavailable).reached).toBe(true);
      } finally {
        await new Promise<void>(resolve => { proxy.close(() => resolve()); proxy.closeAllConnections(); });
      }
    });
  });
});
