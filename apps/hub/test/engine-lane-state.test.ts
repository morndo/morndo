// An engine lane writes no Claude transcript, so a still pane used to stay Idle while `lanes --json` said busy.
// Synthetic panes and a stand-in for `lanes --json`. Both hub modes (spec §9).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/adapters/log.ts";
import type { LaneReport } from "../src/application/ports.ts";
import type { Tmux } from "../src/application/ports.ts";
import { engineRegistry } from "../src/adapters/engine-registry.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { HUB_MODES, TEST_NODE, claudeDirPorts, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-engine-lane-")); });
afterEach(async () => {
  await ports?.close();
  ports = null;
  rmSync(dir, { recursive: true, force: true });
});

const said = { type: "assistant", uuid: "a0", timestamp: "2026-10-08T12:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Working." }] } };

async function open(mode: HubMode, o: { screens: Map<string, string>; claude?: boolean; names?: Map<string, string>; lanes: () => Promise<readonly LaneReport[]> }) {
  if (o.claude) {
    mkdirSync(join(dir, "sessions"));
    mkdirSync(join(dir, "projects", "-w"), { recursive: true });
    writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), `${JSON.stringify(said)}\n`);
  }
  const tmux: Tmux = {
    listWorkers: async () => [...o.screens.keys()].map(id => ({ id, name: o.names?.get(id) ?? (id === "%1" ? (o.claude ? "builder" : "lane-a") : "scratch"), location: "w", node: "local", offline: false })),
    capture: async id => o.screens.get(id) ?? null,
    captureMany: async ids => new Map(ids.map(id => [id, o.screens.get(id) ?? null])),
    send: async () => ({ problem: null, typedAt: 0 }),
  };
  const p = await portsFor(mode, { tmux, ...(o.claude ? claudeDirPorts(dir) : {}) });
  ports = p;
  const svc = new ObservationService(p.tmux, 60_000, () => 1_000, {
    sessions: p.sessions, transcripts: p.transcripts, nodeStates: p.nodeStates, lanes: o.lanes,
    engineNode: mode === "fleet" ? TEST_NODE : null,
  });
  return svc;
}

const of = (svc: ObservationService, name: string) => svc.snapshot().workers.find(w => w.name === name);

describe.each(HUB_MODES)("engine lane state, %s hub", mode => {
  it("a lane lanes reports busy, with an engine and no transcript, is Working; idle stays Idle", async () => {
    const screens = new Map([["%1", "ready\n"], ["%2", "a\n"]]);
    const reports: LaneReport[] = [{ name: "lane-a", status: "busy", engine: "cursor" }];
    const svc = await open(mode, { screens, lanes: async () => reports });
    await svc.poll();
    expect(of(svc, "lane-a")).toMatchObject({ state: "active" });
    reports[0] = { name: "lane-a", status: "idle", engine: "cursor" };
    screens.set("%1", "ready\nredrawn\n");
    screens.set("%2", "b\n");
    await svc.poll();
    expect(of(svc, "lane-a")).toMatchObject({ state: "quiet" });
    expect(of(svc, "scratch")).toMatchObject({ state: "active" });
  });

  it("a transcript lane beside an engine lane keeps the screen", async () => {
    const screens = new Map([["%1", "one\n"], ["%2", "ready\n"]]);
    const reports: LaneReport[] = [
      { name: "builder", status: "busy", engine: null },
      { name: "cur-x", status: "busy", engine: "cursor" },
    ];
    const svc = await open(mode, {
      screens, claude: true, lanes: async () => reports,
      names: new Map([["%1", "builder"], ["%2", "cur-x"]]),
    });
    await svc.poll();
    expect(of(svc, "builder")).toMatchObject({ state: "quiet" });
    expect(of(svc, "cur-x")).toMatchObject({ state: "active" });
    screens.set("%1", "two\n");
    reports[1] = { name: "cur-x", status: "idle", engine: "cursor" };
    await svc.poll();
    expect(of(svc, "builder")).toMatchObject({ state: "active" });
    expect(of(svc, "cur-x")).toMatchObject({ state: "quiet" });
  });

  it("a followed worker keeps its screen, even when a registry file names it", async () => {
    const screens = new Map([["%1", "one\n"], ["%2", "ready\n"]]);
    const svc = await open(mode, {
      screens, claude: true,
      names: new Map([["%1", "builder"], ["%2", "cur-x"]]),
      lanes: async () => [
        { name: "builder", status: "busy", engine: "cursor" },
        { name: "cur-x", status: "busy", engine: "cursor" },
      ],
    });
    await svc.poll();
    expect(of(svc, "builder")?.state).toBe("quiet");
    expect(of(svc, "cur-x")?.state).toBe("active");
  });

  it("a report whose name is not the worker's does not govern it", async () => {
    const screens = new Map([["%1", "ready\n"]]);
    const svc = await open(mode, {
      screens,
      names: new Map([["%1", "cur-x"]]),
      lanes: async () => [{ name: "engine-cursor", status: "busy", engine: "cursor" }],
    });
    await svc.poll();
    expect(of(svc, "cur-x")?.state).toBe("quiet");
  });

  it("a Claude lane keeps the screen: busy in lanes does not make a still pane Working, and a change does", async () => {
    const screens = new Map([["%1", "one\n"]]);
    const reports: LaneReport[] = [{ name: "builder", status: "busy", engine: null }];
    const svc = await open(mode, { screens, claude: true, lanes: async () => reports });
    await svc.poll();
    expect(of(svc, "builder")).toMatchObject({ state: "quiet" });
    await svc.poll();
    expect(of(svc, "builder")?.state).toBe("quiet");
    reports[0] = { name: "builder", status: "idle", engine: null };
    screens.set("%1", "two\n");
    await svc.poll();
    expect(of(svc, "builder")).toMatchObject({ state: "active" });
  });
});

describe("an old registry file", () => {
  const start = 1_700_000_000_000;
  function svc(status: "busy" | "idle") {
    const screens = new Map([["%1", "ready\n"]]);
    const lanes = engineRegistry("/reg", {
      readDir: async () => ["7.json"],
      readFile: async () => JSON.stringify({
        pid: 7, name: "cur-x", status, engine: "cursor",
        pidStartTicks: 50, bootId: "boot", pidStartedAt: start + 10 * 60_000,
        startedAt: start - 60_000, updatedAt: start - 30 * 60 * 1000,
      }),
      alive: () => true,
      identity: () => ({ ticks: 50, bootId: "boot" }),
    });
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "%1", name: "cur-x", location: "w", node: "local", offline: false }],
      capture: async id => screens.get(id) ?? null,
      captureMany: async ids => new Map(ids.map(id => [id, screens.get(id) ?? null])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    return { screens, svc: new ObservationService(tmux, 60_000, () => 1_000, { lanes }) };
  }

  it("a busy lane whose file is 30 minutes old stays Working when the pid is live and the start matches", async () => {
    const { svc: service } = svc("busy");
    await service.poll();
    expect(of(service, "cur-x")?.state).toBe("active");
  });

  it("an idle lane whose file is 30 minutes old stays idle when the pane is redrawn", async () => {
    const { screens, svc: service } = svc("idle");
    await service.poll();
    screens.set("%1", "ready\nredrawn\n");
    await service.poll();
    expect(of(service, "cur-x")?.state).toBe("quiet");
  });
});

describe("engine lane on the hub's fleet node", () => {
  it("asks nodeStates once per poll", async () => {
    let calls = 0;
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "pc.3fa2c1d0.1", name: "cur-y", location: "w", node: "pc", offline: false }],
      capture: async () => "ready\n",
      captureMany: async ids => new Map(ids.map(id => [id, "ready\n"])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const svc = new ObservationService(tmux, 60_000, () => 1_000, {
      nodeStates: async () => { calls += 1; return new Map([["pc", "online" as const]]); },
      engineNode: "pc",
      lanes: async () => [{ name: "cur-y", status: "busy", engine: "cursor" }],
    });
    await svc.poll();
    expect(calls).toBe(1);
  });

  it("applies on that node and not on another", async () => {
    const screens = new Map([["mac.0a1b2c3d.1", "ready\n"], ["pc.3fa2c1d0.1", "ready\n"]]);
    const tmux: Tmux = {
      listWorkers: async () => [
        { id: "mac.0a1b2c3d.1", name: "cur-x", location: "w", node: "mac", offline: false },
        { id: "pc.3fa2c1d0.1", name: "cur-y", location: "w", node: "pc", offline: false },
      ],
      capture: async id => screens.get(id) ?? null,
      captureMany: async ids => new Map(ids.map(id => [id, screens.get(id) ?? null])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const svc = new ObservationService(tmux, 60_000, () => 1_000, {
      nodeStates: async () => new Map([["mac", "online" as const], ["pc", "online" as const]]),
      engineNode: "pc",
      lanes: async () => [
        { name: "cur-x", status: "busy", engine: "cursor" },
        { name: "cur-y", status: "busy", engine: "cursor" },
      ],
    });
    await svc.poll();
    expect(of(svc, "cur-x")?.state).toBe("quiet");
    expect(of(svc, "cur-y")?.state).toBe("active");
  });

  it("warns once when MORNDO_ENGINE_NODE matches no fleet node, and applies no report", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    let clock = 1_000;
    const screens = new Map([["mac.0a1b2c3d.1", "ready\n"]]);
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "mac.0a1b2c3d.1", name: "cur-x", location: "w", node: "mac", offline: false }],
      capture: async id => screens.get(id) ?? null,
      captureMany: async ids => new Map(ids.map(id => [id, screens.get(id) ?? null])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const svc = new ObservationService(tmux, 60_000, () => clock, {
      nodeStates: async () => new Map([["mac", "online" as const]]),
      engineNode: "pc",
      lanes: async () => [{ name: "cur-x", status: "busy", engine: "cursor" }],
    });
    clock = 1_000 + 120_000;
    await svc.poll();
    await svc.poll();
    const notes = warn.mock.calls.map(c => String(c[0])).filter(s => s.includes("MORNDO_ENGINE_NODE"));
    expect(notes).toHaveLength(1);
    expect(of(svc, "cur-x")?.state).toBe("quiet");
    warn.mockRestore();
  });

  it("warns that MORNDO_ENGINE_NODE is not connected only after two minutes", async () => {
    let clock = 1_000;
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "mac.0a1b2c3d.1", name: "cur-x", location: "w", node: "mac", offline: false }],
      capture: async () => "ready\n",
      captureMany: async ids => new Map(ids.map(id => [id, "ready\n"])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const svc = new ObservationService(tmux, 60_000, () => clock, {
      nodeStates: async () => new Map([["mac", "online" as const]]),
      engineNode: "pc",
      lanes: async () => [{ name: "cur-x", status: "busy", engine: "cursor" }],
    });
    const notes = () => warn.mock.calls.map(c => String(c[0])).filter(s => s.includes("MORNDO_ENGINE_NODE"));
    await svc.poll();
    clock = 1_000 + 90_000;
    await svc.poll();
    expect(notes()).toEqual([]);
    clock = 1_000 + 120_000;
    await svc.poll();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatch(/not connected/);
    expect(notes()[0]).not.toMatch(/stays off/);
    await svc.poll();
    expect(notes()).toHaveLength(1);
    expect(of(svc, "cur-x")?.state).toBe("quiet");
    warn.mockRestore();
  });
});
