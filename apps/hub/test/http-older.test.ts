// An older page over the feed (fleet core §3.1): older() is async now, and its transcript may be on another node. A
// page that fails is answered as missing, never an unhandled rejection (exitOnCrash would end the hub; vitest fails the
// run on one), and one connection's older pages run one at a time. Both configurations (spec §9): the observation over
// the legacy hub's ports and over the fleet adapters, with a real page read through each; and, in fleet mode, a page
// asked while the worker's node can't answer is missing (the app offers Try again), and comes once the node answers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OlderResult } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let dir: string;
let hub: InProcessHub | null = null;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-older-")); });
afterEach(async () => { await hub?.close(); hub = null; await ports?.close(); ports = null; rmSync(dir, { recursive: true, force: true }); });

const TMUX: Tmux = {
  listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
  capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])), send: async () => ({ problem: null, typedAt: 0 }),
};
// A worker %1 whose transcript holds 150 replies; the hub's observation over the ports of `mode`.
async function observed(mode: HubMode) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ type: "assistant", uuid: `r${i}`, timestamp: new Date(Date.UTC(2026, 9, 2, 8, 0, i)).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), `${lines.join("\n")}\n`);
  ports = await portsFor(mode, { tmux: TMUX, ...claudeDirPorts(dir) });
  return { observation: observationFor(ports, { quietAfterMs: 60_000 }), id: ports.id };
}

// Every "older" frame the socket gets, in order; `count(n)` waits until n have come.
function olderFrames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  ws.on("message", d => { const m = JSON.parse(frameText(d)) as Record<string, unknown>; if (m.t === "older") got.push(m); });
  const count = async (n: number) => {
    for (let i = 0; i < 300 && got.length < n; i++) await new Promise(r => setTimeout(r, 10));
    return got;
  };
  return { got, count };
}

describe.each(HUB_MODES)("older pages on the feed, %s hub", mode => {
  it("a page whose read fails is answered missing, and the feed goes on", async () => {
    const { observation, id } = await observed(mode);
    vi.spyOn(observation, "older").mockImplementation(async (_w, before) => {
      if (before === "boom") throw new Error("fleet: node_offline");
      return { messages: [], done: true };
    });
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "boom" }));
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "m1" }));
    expect(await f.count(2)).toEqual([
      { t: "older", worker: id("%1"), before: "boom", messages: [], done: false, missing: true },
      { t: "older", worker: id("%1"), before: "m1", messages: [], done: true },
    ]);
  });
  it("one connection's pages run one at a time, in the order asked", async () => {
    const { observation, id } = await observed(mode);
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(observation, "older").mockImplementation(async (_w, before): Promise<OlderResult> => {
      log.push(`start ${before}`);
      if (before === "slow") await gate;
      log.push(`end ${before}`);
      return { messages: [], done: false };
    });
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "slow" }));
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "fast" }));
    await new Promise(r => setTimeout(r, 100));
    expect(log).toEqual(["start slow"]);                                // the second waits for the first
    release();
    expect((await f.count(2)).map(m => m.before)).toEqual(["slow", "fast"]);
    expect(log).toEqual(["start slow", "end slow", "start fast", "end fast"]);
  });
  it("a real page, read from the worker's own transcript through the ports", async () => {
    const { observation, id } = await observed(mode);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    const page = (await f.count(1))[0] ?? {};
    expect((page.messages as { text: string }[]).map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
  });
});

describe.runIf(HUB_MODES.includes("fleet"))("an older page while the worker's node can't answer (fleet hub)", () => {
  it("is missing, so the app offers Try again; the follow keeps its place; the page comes once the node answers", async () => {
    const { observation, id } = await observed("fleet");
    await observation.poll();
    const held = observation.history(id("%1")).length;
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    await ports?.rig?.fleet.setStatus("test", "offline");
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    expect(await f.count(1)).toEqual([{ t: "older", worker: id("%1"), before: "r120:0", messages: [], done: false, missing: true }]);
    expect(observation.history(id("%1"))).toHaveLength(held);           // nothing of the follow was dropped
    await ports?.rig?.fleet.setStatus("test", "online");
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    expect((await f.count(2))[1]?.messages).toHaveLength(100);
  });
});
