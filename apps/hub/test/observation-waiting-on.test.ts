// What each worker waits for, on the roster (ADR-0008 phase C, S6): an open question by its id, else a menu on its
// screen by its digest, else nothing; the hub judges a Command against it on arrival. And older pages (O9) through the
// observation service. Synthetic transcript and screens. Both configurations (spec §9): in fleet mode the same pane,
// session and transcript sit behind the fake fleet as one node, and the worker is named by its worker id.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { menuIdentity } from "@morndo/node-ops";
import type { Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-waiting-")); });
afterEach(async () => {
  await ports?.close();
  ports = null;
  rmSync(dir, { recursive: true, force: true });
});

const MENU = "Allow this edit?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
async function setup(mode: HubMode, lines: unknown[], screen: string) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  let shown = screen;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
    capture: async id => (id === "%1" ? shown : null),
    captureMany: async ids => new Map(ids.map(id => [id, id === "%1" ? shown : null])),
    send: async () => ({ problem: null, typedAt: 0 }),
  };
  const p = await portsFor(mode, { tmux, ...claudeDirPorts(dir) });
  ports = p;
  return { svc: observationFor(p, { quietAfterMs: 60_000 }), id: p.id, show: (s: string) => { shown = s; } };
}
const ask = { type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "AskUserQuestion", input: { questions: [{ question: "Keep it?", header: "Keep", multiSelect: false, options: [{ label: "Yes", description: "" }] }] } }] } };
const said = { type: "assistant", uuid: "a0", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Working." }] } };

describe.each(HUB_MODES)("waitingOn on the roster, %s hub", mode => {
  it("an open question, by its id", async () => {
    const { svc, id } = await setup(mode, [ask], MENU);                 // a question draws a menu too: the question wins
    await svc.poll();
    expect(svc.snapshot().workers[0]?.waitingOn).toBe("q:toolu_9");
    expect(svc.waitingOn(id("%1"))).toBe("q:toolu_9");
  });
  it("a menu on the screen, by its digest; then nothing once it's answered", async () => {
    const { svc, id, show } = await setup(mode, [said], MENU);
    await svc.poll();
    expect(svc.waitingOn(id("%1"))).toBe(`menu:${menuIdentity(MENU)}`);
    show("──────\n❯ ");
    await svc.poll();
    expect(svc.waitingOn(id("%1"))).toBe("none");
    expect(svc.snapshot().workers[0]?.waitingOn).toBeNull();
  });
  it("an unknown worker waits on nothing", async () => {
    const { svc, id } = await setup(mode, [], "");
    expect(svc.waitingOn(id("%42"))).toBe("none");
  });
});

describe.each(HUB_MODES)("older pages through the observation service (O9), %s hub", mode => {
  it("reads the worker's own transcript backwards from the message asked for", async () => {
    const lines = Array.from({ length: 150 }, (_, i) => ({ type: "assistant", uuid: `r${i}`, timestamp: new Date(Date.UTC(2026, 9, 2, 8, 0, i)).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } }));
    const { svc, id } = await setup(mode, lines, "──────\n❯ ");
    await svc.poll();
    const page = await svc.older(id("%1"), "r120:0");
    expect(page.messages.map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
    expect(await svc.older(id("%1"), "r20:0")).toMatchObject({ done: true });       // the page before r20: where r120's page began
    expect(await svc.older(id("%9"), "r1:0")).toEqual({ messages: [], done: false, missing: true });   // not a followed worker (L1)
    expect(await svc.older(id("%1"), "gone:0")).toEqual({ messages: [], done: false, missing: true }); // not in its transcript
  });
});
