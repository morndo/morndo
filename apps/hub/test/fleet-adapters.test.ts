// The hub's ports over the fleet (spec §3.1, §4, §5.3) against the fake fleet, two nodes:
// - listing every node's windows, with each worker's node; a slow or hung node never holds the listing more than 300 ms;
// - captures in one pane.captureMany per node;
// - a send with the caller's key and the expectation from the latest inventory, and the node refusing it once that no
//   longer holds;
// - a node going offline;
// - terminal frames and keys;
// - sessions from the inventory, and transcripts by session;
// - an image put in keyed chunks;
// - a worker's file copied into the hub's store;
// - what op.status says of a key, and from which store;
// - keys that may have been typed ("uncertain"), and transcripts that can't be read now (SourceUnavailable);
// - an inventory event applied without a poll.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
import { fileStore } from "../src/adapters/files.ts";
import type { LocalFileStore } from "../src/adapters/fleet-adapters.ts";
import { SendInDoubt, SourceUnavailable } from "../src/application/ports.ts";
import { LOST, localNode, memoryBackend, refusal, until, type MemoryBackend, type MemoryPane } from "./helpers/fake-fleet.ts";
import { fleetRig, observationFor, type FleetRig } from "./helpers/hub-mode.ts";

const PC1 = "pc.aaaaaaaa.1";
const PC2 = "pc.aaaaaaaa.2";
const BOX1 = "box.bbbbbbbb.1";
const BOX = "──────\n❯ ";
const TRANSCRIPT = Buffer.from(`${"a".repeat(300_000)}\n{"uuid":"needle"}\n`);
const REPORT = Buffer.from("%PDF-1.7 synthetic");

let dir: string;
let rig: FleetRig | null = null;
let pc: MemoryBackend;
let box: MemoryBackend;
let alpha: MemoryPane;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-adapters-"));
  alpha = { name: "alpha", cwd: "/w/alpha", screen: BOX, sessionId: "s-alpha" };
  pc = memoryBackend({ "%1": alpha, "%2": { name: "gamma", cwd: "/w/gamma", screen: "gamma $ " } },
    { inboxDir: join(dir, "pc-inbox"), transcripts: { "s-alpha": TRANSCRIPT }, files: { "/w/alpha/report.pdf": REPORT } });
  box = memoryBackend({ "%1": { name: "beta", cwd: "/w/beta", screen: BOX } });
});
afterEach(async () => {
  await rig?.close();
  rig = null;
  rmSync(dir, { recursive: true, force: true });
});
const start = async (o: { files?: LocalFileStore } = {}) => (rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)], o));
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe("listing and captures", () => {
  it("lists every window with its worker id, its node and the basename of its cwd", async () => {
    const { ports } = await start();
    expect((await ports.tmux.listWorkers()).sort(byId)).toEqual([
      { id: BOX1, name: "beta", location: "beta", node: "box", offline: false, conflict: false },
      { id: PC1, name: "alpha", location: "alpha", node: "pc", offline: false, conflict: false },
      { id: PC2, name: "gamma", location: "gamma", node: "pc", offline: false, conflict: false },
    ]);
  });

  it("waits at most 300 ms for a slow node's inventory, and applies it when it lands (spec §3.1)", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    box.panes["%2"] = { name: "delta", cwd: "/w/delta", screen: BOX };                // a new window, not announced
    fleet.intercept("inventory.get", async (call, next) => { if (call.node === "box") await new Promise(r => setTimeout(r, 1000)); return next(); });
    const t0 = performance.now();
    const first = await ports.tmux.listWorkers();
    expect(performance.now() - t0).toBeLessThan(800);
    expect(first.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);                    // the slow node's answer isn't in yet
    await until(() => fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box").length === 1);
    await new Promise(r => setTimeout(r, 1100));
    expect((await ports.tmux.listWorkers()).map(w => w.id).sort()).toEqual([BOX1, "box.bbbbbbbb.2", PC1, PC2]);   // applied as it landed
    expect(fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box")).toHaveLength(1);
  });

  it("a node whose inventory.get never answers holds no listing, and is asked once at a time", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    box.panes["%2"] = { name: "delta", cwd: "/w/delta", screen: BOX };
    fleet.intercept("inventory.get", async (call, next) => (call.node === "box" ? new Promise(() => {}) : next()));
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      expect((await ports.tmux.listWorkers()).map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);
      expect(performance.now() - t0).toBeLessThan(800);
    }
    expect(fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box")).toHaveLength(1);   // the one in flight
  });

  it("captures with one pane.captureMany per node; an id that isn't a worker id is null without asking", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    const before = fleet.calls.length;
    expect(Object.fromEntries(await ports.tmux.captureMany([PC1, PC2, BOX1, "%1"]))).toEqual({ [PC1]: BOX, [PC2]: "gamma $ ", [BOX1]: BOX, "%1": null });
    expect(fleet.calls.slice(before).map(c => ({ op: c.op, node: c.node, args: c.args, timeoutMs: c.timeoutMs })).sort((a, b) => String(a.node).localeCompare(String(b.node)))).toEqual([
      { op: "pane.captureMany", node: "box", args: { workerIds: [BOX1] }, timeoutMs: 1200 },
      { op: "pane.captureMany", node: "pc", args: { workerIds: [PC1, PC2] }, timeoutMs: 1200 },
    ]);
  });

  it("a node that goes offline: its workers stay listed, marked offline, and aren't asked; the other node still updates", async () => {
    const { ports, fleet } = await start();
    const obs = observationFor(ports, { quietAfterMs: 60_000 });
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);
    await fleet.setStatus("box", "offline");
    alpha.screen = "pc moved on";
    const before = fleet.calls.length;
    await obs.poll();
    expect(obs.screen(PC1)).toBe("pc moved on");
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);              // not gone
    expect(fleet.calls.slice(before).filter(c => c.node === "box")).toEqual([]);                  // skipped at once
    expect((await ports.tmux.listWorkers()).find(w => w.id === BOX1)).toEqual({ id: BOX1, name: "beta", location: "beta", node: "box", offline: true, conflict: false });
    expect(ports.nodeStatus("box")).toBe("offline");
    expect(await ports.nodeStates()).toEqual(new Map([["box", "offline"], ["pc", "online"]]));   // what observation skips by
  });
});

describe("a revoked node (FL4)", () => {
  it("is gone from the hub's view at the next listing: its workers aren't listed, its status is unknown, and a manager on it is never picked", async () => {
    box.panes["%2"] = { name: "manager", cwd: "/w/m", screen: BOX };
    pc.panes["%3"] = { name: "manager", cwd: "/w/m2", screen: BOX };
    const { ports, fleet } = await start();
    const obs = observationFor(ports, { quietAfterMs: 60_000 });
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([BOX1, "box.bbbbbbbb.2", PC1, PC2, "pc.aaaaaaaa.3"]);
    fleet.revoke("box");
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([PC1, PC2, "pc.aaaaaaaa.3"]);
    expect(ports.nodeStatus("box")).toBeNull();
    expect([...(await ports.nodeStates()).keys()]).toEqual(["pc"]);
    expect(obs.snapshot().workers.filter(w => w.name === "manager").map(w => w.id)).toEqual(["pc.aaaaaaaa.3"]);   // the only manager left to answer
  });
});

describe("sending (spec §4, §5.3)", () => {
  it("sends with the caller's key under hub:, the expectation from the latest inventory, and the node's typedAt", async () => {
    pc.typedAt = 1_791_000_000_123;
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect(await ports.tmux.send(PC1, "ship it", "ep1:r1")).toEqual({ problem: null, typedAt: 1_791_000_000_123, store: fleet.node("pc").store, storeSeq: 1 });
    expect(fleet.calls.filter(c => c.op === "pane.send")).toEqual([{
      op: "pane.send", node: "pc", target: { workerId: PC1 }, key: "hub:ep1:r1", timeoutMs: 10_000,
      args: { workerId: PC1, text: "ship it", expect: { server: "aaaaaaaa", window: "alpha", sessionId: "s-alpha" } },
    }]);
    expect(pc.typed).toEqual([{ pane: "%1", text: "ship it", key: "hub:ep1:r1" }]);
  });

  it("an expectation that no longer holds is refused by the node: no_pane, nothing typed, the key released", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();                                    // the hub's view: %1 is "alpha"
    alpha.name = "renamed";                                            // renamed on the node since
    expect(await ports.tmux.send(PC1, "ship it", "ep1:r2")).toEqual({ problem: "no_pane", typedAt: 0 });
    expect(pc.typed).toEqual([]);
    expect(fleet.node("pc").keys.has("hub:ep1:r2")).toBe(false);
  });

  it("a send refused only because the pane runs a new session since the hub's inventory (a /clear) goes again once, with the refreshed expectation and the same key", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();                                    // the hub's view: %1 runs s-alpha
    alpha.sessionId = "s-cleared";                                     // /clear on the node; no inventory event yet
    expect(await ports.tmux.send(PC1, "now do X", "ep1:r9")).toMatchObject({ problem: null });
    expect(pc.typed).toEqual([{ pane: "%1", text: "now do X", key: "hub:ep1:r9" }]);
    const sends = fleet.calls.filter(c => c.op === "pane.send");
    expect(sends.map(c => (c.args as { expect: { sessionId?: string } }).expect)).toEqual([
      { server: "aaaaaaaa", window: "alpha", sessionId: "s-alpha" }, { server: "aaaaaaaa", window: "alpha", sessionId: "s-cleared" },
    ]);
    expect(sends.map(c => c.key)).toEqual(["hub:ep1:r9", "hub:ep1:r9"]);
    expect((await ports.sessions.byPane()).get(PC1)?.sessionId).toBe("s-cleared");   // the view caught up as well
  });

  it("a pane renamed as well as running a new session is still refused: no_pane, typed once nowhere, no second send", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    alpha.sessionId = "s-other";
    alpha.name = "renamed";
    expect(await ports.tmux.send(PC1, "now do X", "ep1:r10")).toEqual({ problem: "no_pane", typedAt: 0 });
    expect(pc.typed).toEqual([]);
    expect(fleet.calls.filter(c => c.op === "pane.send")).toHaveLength(1);
  });

  it("refusals before the paste are problems; an answer lost after the paste throws SendInDoubt with the node's store", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    alpha.problem = "menu_open";
    expect(await ports.tmux.send(PC1, "x", "k1")).toEqual({ problem: "menu_open", typedAt: 0 });
    alpha.problem = null;
    fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    const lost = await ports.tmux.send(PC1, "y", "k2").catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(SendInDoubt);
    expect((lost as SendInDoubt).store).toBe(fleet.node("pc").store);
    expect((lost as SendInDoubt).storeSeq).toBe(2);                     // with that store's sequence: k1 started, then k2
    expect(pc.typed.map(t => t.text)).toEqual(["y"]);
    expect(await ports.tmux.send("%1", "z", "k3")).toEqual({ problem: "no_pane", typedAt: 0 });   // a legacy id: no pane here
  });

  // The three mappings that decide whether a send can be typed twice (fleet-adapters.ts, `send`).
  it("a request that never reached the fleet is node_offline, and nothing is typed", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();                                    // the pane is cached: the failure is the op's own
    await fleet.close();                                               // the socket is gone
    expect(await ports.tmux.send(PC1, "ship it", "k-gone")).toEqual({ problem: "node_offline", typedAt: 0 });
    expect(pc.typed).toEqual([]);
  });

  it("a request the fleet took and never answered throws SendInDoubt with no store", async () => {
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)], { timeouts: { sendMs: 50 } });
    await rig.ports.tmux.listWorkers();
    rig.fleet.intercept("pane.send", () => new Promise(() => {}));     // taken; no answer ever comes
    const doubt = await rig.ports.tmux.send(PC1, "ship it", "k-silent").catch((e: unknown) => e);
    expect(doubt).toBeInstanceOf(SendInDoubt);
    expect((doubt as SendInDoubt).store).toBeNull();
    expect((doubt as SendInDoubt).storeSeq).toBeNull();
    expect(pc.typed).toEqual([]);
  });

  it("an ok answer of a shape or a problem the hub doesn't know throws SendInDoubt with the answer's store", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    for (const result of [{ problem: "a_new_problem", typedAt: 5 }, { problem: null }, { nothing: "known" }]) {
      fleet.intercept("pane.send", async () => ({ ok: true, result }));
      const doubt = await ports.tmux.send(PC1, "ship it", "k-odd").catch((e: unknown) => e);
      expect(doubt).toBeInstanceOf(SendInDoubt);
      expect((doubt as SendInDoubt).store).toBe(fleet.node("pc").store);
      expect((doubt as SendInDoubt).storeSeq).toBe(0);
    }
    expect(pc.typed).toEqual([]);
  });

  // Final review M1: a refusal that says nothing ran (executed "no") is a problem the caller sees, never a throw, so the
  // caller releases its row and a retry may type once the cause is fixed.
  it("a definite refusal (executed no: denied, bad_args, too_large, unknown_op, internal) is that problem, nothing typed", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    for (const code of ["denied", "bad_args", "too_large", "unknown_op"] as const) {
      fleet.intercept("pane.send", async () => refusal(code));
      expect(await ports.tmux.send(PC1, "ship it", `k-${code}`)).toEqual({ problem: code, typedAt: 0 });
    }
    // Any executed "no" (ruling, ADR-0012 decision 7): an agent's internal error before the side effect too.
    fleet.intercept("pane.send", async () => ({ ok: false, error: { code: "internal", executed: "no", message: "keys.start: disk full" } }));
    expect(await ports.tmux.send(PC1, "ship it", "k-internal-no")).toEqual({ problem: "internal", typedAt: 0 });
    // executed "maybe", or a code that is itself "uncertain": in doubt, with the node's store.
    for (const [code, executed] of [["internal", "maybe"], ["uncertain", "no"]] as const) {
      fleet.intercept("pane.send", async () => ({ ok: false, error: { code, executed, message: "x" } }));
      const doubt = await ports.tmux.send(PC1, "ship it", `k-${code}-${executed}`).catch((e: unknown) => e);
      expect(doubt, `${code}/${executed}`).toBeInstanceOf(SendInDoubt);
      expect((doubt as SendInDoubt).store).toBe(fleet.node("pc").store);
    }
    expect(pc.typed).toEqual([]);
  });

  it("op.status: done, with the node's typedAt, only when typed and submitted; pasted but not submitted stays in doubt; unknown, from its store; offline", async () => {
    pc.typedAt = 1_791_000_000_321;
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    await ports.tmux.send(PC1, "a", "k-done");
    expect(await ports.sendStatus(PC1, "k-done")).toEqual({ state: "done", typedAt: 1_791_000_000_321 });
    alpha.problem = "not_submitted";
    expect(await ports.tmux.send(PC1, "b", "k-pasted")).toEqual({ problem: "not_submitted", typedAt: 1_791_000_000_321, store: fleet.node("pc").store, storeSeq: 2 });
    expect(await ports.sendStatus(PC1, "k-pasted")).toEqual({ state: "started" });
    expect(await ports.sendStatus(PC1, "k-never")).toEqual({ state: "unknown", store: fleet.node("pc").store, storeSeq: 2 });   // where its database is now
    expect(fleet.calls.filter(c => c.op === "op.status").map(c => c.args)).toEqual([{ key: "hub:k-done" }, { key: "hub:k-pasted" }, { key: "hub:k-never" }]);
    expect(await ports.sendStatus("%1", "k-done")).toEqual({ state: "offline" });                 // a legacy row: can't be asked
    await fleet.setStatus("pc", "offline");
    expect(await ports.sendStatus(PC1, "k-done")).toEqual({ state: "offline" });
  });
});

describe("terminal, sessions and transcripts", () => {
  it("frames and keys through the node; keys carry the expectation without a session, and never more than 4096", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect(await ports.terminal.frame(PC1)).toEqual({ cols: 80, rows: 2, x: 0, y: 0, cursor: true, lines: ["──────", "❯ "] });
    expect(await ports.terminal.frame("%1")).toBeNull();
    expect(await ports.terminal.keys(PC1, "ls\r")).toBe(true);
    expect(pc.keysTyped).toEqual([{ pane: "%1", data: "ls\r" }]);
    expect(fleet.calls.filter(c => c.op === "pane.keys")).toEqual([{
      op: "pane.keys", node: "pc", target: { workerId: PC1 }, key: null, timeoutMs: 3000,
      args: { workerId: PC1, data: "ls\r", expect: { server: "aaaaaaaa", window: "alpha" } },
    }]);
    expect(await ports.terminal.keys(PC1, "x".repeat(4097))).toBe(false);
  });

  // Final review M5: a frame its node can't give now is "unavailable", so the terminal view stays open and asks again on
  // its next tick; only a pane that is gone (no_pane, or the node's own null) closes it.
  it("a frame its node can't give now (timeout, node offline, the fleet unreachable) is unavailable, never gone; no_pane is gone", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("pane.frame", async () => refusal("timeout"));
    expect(await ports.terminal.frame(PC1)).toBe("unavailable");
    fleet.intercept("pane.frame", async () => refusal("no_pane"));
    expect(await ports.terminal.frame(PC1)).toBeNull();
    fleet.intercept("pane.frame", null);
    await fleet.setStatus("pc", "offline");
    expect(await ports.terminal.frame(PC1)).toBe("unavailable");
    await fleet.setStatus("pc", "online");
    expect(await ports.terminal.frame(PC1)).toMatchObject({ lines: ["──────", "❯ "] });
    delete pc.panes["%1"];                                            // the pane closed: the node answers no frame
    expect(await ports.terminal.frame(PC1)).toBeNull();
    await fleet.close();                                               // the fleet's socket gone
    expect(await ports.terminal.frame(PC1)).toBe("unavailable");
  });

  it("keys whose answer was lost may have been typed: uncertain, never refused; keys the node refused are false", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("pane.keys", async (_call, next) => { await next(); return LOST; });
    expect(await ports.terminal.keys(PC1, "y")).toBe("uncertain");
    expect(pc.keysTyped).toEqual([{ pane: "%1", data: "y" }]);
    fleet.intercept("pane.keys", null);
    alpha.name = "renamed";                                            // the expectation no longer holds: no_pane, not typed
    expect(await ports.terminal.keys(PC1, "n")).toBe(false);
    expect(pc.keysTyped).toHaveLength(1);
  });

  it("sessions come from the inventory; a transcript is read from the node whose pane runs it, a chunk at a time", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0, status: "idle" }]]);   // the fake fleet's session default (Step 12.21)
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);
    const first = await ports.transcripts.read("s-alpha", 0, 1 << 20);
    expect(first?.bytes.length).toBe(262_144);
    expect(first?.eof).toBe(false);
    const rest = await ports.transcripts.read("s-alpha", 262_144, 1 << 20);
    expect(rest?.eof).toBe(true);
    expect(Buffer.concat([first?.bytes ?? new Uint8Array(), rest?.bytes ?? new Uint8Array()]).equals(TRANSCRIPT)).toBe(true);
    expect(await ports.transcripts.locate("s-alpha", "needle")).toBe(TRANSCRIPT.indexOf("needle"));
    expect(await ports.transcripts.size("s-unknown")).toBeNull();
    expect(fleet.calls.filter(c => c.op.startsWith("transcript.")).every(c => c.node === "pc")).toBe(true);
  });

  it("a transcript whose node can't answer now is SourceUnavailable, never gone (null), so the follow keeps its place", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("transcript.read", async () => LOST);
    await expect(ports.transcripts.read("s-alpha", 0, 10)).rejects.toBeInstanceOf(SourceUnavailable);
    fleet.intercept("transcript.read", null);
    await fleet.setStatus("pc", "offline");
    await expect(ports.transcripts.size("s-alpha")).rejects.toBeInstanceOf(SourceUnavailable);
    await expect(ports.transcripts.locate("s-alpha", "needle")).rejects.toBeInstanceOf(SourceUnavailable);
    await fleet.setStatus("pc", "online");
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);           // back: read on from where it was
  });

  it("an inventory.get answer that lands after a newer inventory event doesn't roll the view back (spec §5.4: latest wins)", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("inventory.get", async (call, next) => {
      const older = await next();                                     // the node's read: %1 still runs s-alpha
      if (call.node !== "pc") return older;
      alpha.sessionId = "s-new";                                      // a /clear right after that read
      await fleet.announce("pc");                                     // its inventory event reaches the hub first
      await until(async () => (await ports.sessions.byPane()).get(PC1)?.sessionId === "s-new");
      return older;                                                   // then the older answer
    });
    expect(await ports.tmux.send("pc.aaaaaaaa.9", "x", "ep1:r11")).toEqual({ problem: "no_pane", typedAt: 0 });   // not in the view: asks inventory.get
    expect((await ports.sessions.byPane()).get(PC1)?.sessionId).toBe("s-new");
    fleet.intercept("inventory.get", null);
  });

  it("an inventory event updates the sessions without a poll", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    alpha.sessionId = "s-new";
    await fleet.announce("pc");
    await until(async () => (await ports.sessions.byPane()).get(PC1)?.sessionId === "s-new");
  });
});

describe("images and files", () => {
  it("puts an image on the worker's node in keyed 256 KiB chunks; a chunk whose answer was lost goes again with its key", async () => {
    const img = Buffer.alloc(600_000, 7);
    const path = join(dir, "pasted-1.png");
    writeFileSync(path, img);
    const upload = { id: "u1", endpointId: endpointId("ep1"), path, mime: "image/png" as const, size: img.length, at: 0 };
    const { ports, fleet } = await start();
    let lost = false;
    fleet.intercept("file.put", async (call, next) => {
      const r = await next();
      if (!lost && (call.args as { offset: number }).offset === 262_144) { lost = true; return LOST; }
      return r;
    });
    expect(await ports.uploads.stage(upload, PC1)).toEqual({ ok: true, path: join(dir, "pc-inbox", "u1-pasted-1.png") });
    expect(readFileSync(join(dir, "pc-inbox", "u1-pasted-1.png")).equals(img)).toBe(true);
    expect(fleet.calls.filter(c => c.op === "file.put").map(c => { const a = c.args as { offset: number; final: boolean }; return [c.key, a.offset, a.final]; })).toEqual([
      ["hub:upload:u1:0", 0, false], ["hub:upload:u1:1", 262_144, false], ["hub:upload:u1:1", 262_144, false], ["hub:upload:u1:2", 524_288, true],
    ]);
    expect(await ports.uploads.stage(upload, "%1")).toEqual({ ok: false, problem: "no_pane" });
    await fleet.setStatus("pc", "offline");
    expect(await ports.uploads.stage(upload, PC1)).toEqual({ ok: false, problem: "node_offline" });
  });

  it("a content refusal on the final chunk is sent once and is not reported as a missing pane", async () => {
    const path = join(dir, "pasted-20261011-032515-abcdef-notes.md");
    writeFileSync(path, Buffer.from("# Notes\n"));
    const upload = { id: "u-md", endpointId: endpointId("ep1"), path, mime: "text/markdown" as const, size: 8, at: 0 };
    const { ports, fleet } = await start();
    fleet.intercept("file.put", async () => ({ ok: false, error: { code: "not_allowed" as const, executed: "no" as const, message: "this file isn't an allowed attachment" } }));
    expect(await ports.uploads.stage(upload, PC1)).toEqual({ ok: false, problem: "not_allowed" });
    expect(fleet.calls.filter(c => c.op === "file.put")).toHaveLength(1);
  });

  it("copies a worker's file into the hub's store once, streamed from its node; one the node refuses is no copy", async () => {
    const store = fileStore({ dir: join(dir, "files"), deny: [] });
    const { ports, fleet } = await start({ files: store });
    const first = await ports.files.register(PC1, "/w/alpha/report.pdf");
    expect(first.size).toBe(REPORT.length);
    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    const kept = store.get(first.id ?? "");
    expect(kept && readFileSync(kept.file).equals(REPORT)).toBe(true);
    expect(kept?.meta.name).toBe("report.pdf");
    expect(await ports.files.register(PC1, "/w/alpha/report.pdf")).toEqual(first);
    expect(fleet.fileReads).toEqual(["pc:/w/alpha/report.pdf"]);                     // unchanged: not streamed again
    expect(await ports.files.register(PC1, "/etc/shadow")).toEqual({ id: null, size: null });
    expect(await ports.files.register("%1", "/w/alpha/report.pdf")).toEqual({ id: null, size: null });
  });
});

describe("the fleet's events reconnect", () => {
  it("a conflict that ended while the events were down is not in conflict after the reconnect, with no new event (the fleet doesn't replay it)", async () => {
    pc.panes["%3"] = { name: "alpha", cwd: "/w/alpha2", screen: BOX };                // a second window claims "alpha"
    const { ports, fleet } = await start();
    await until(() => ports.conflicted("alpha"));                                     // read when the events opened
    expect((await ports.tmux.listWorkers()).filter(w => w.name === "alpha").every(w => w.conflict)).toBe(true);
    fleet.dropEvents(1013);                                                           // backpressure close
    delete pc.panes["%3"];                                                            // ended while the hub is disconnected, before it reconnects
    await fleet.announce("pc");                                                       // an inventory event no client is subscribed to now
    await until(() => !ports.conflicted("alpha"));                                    // resynced on the reconnect, no poll, no event
  });
});
