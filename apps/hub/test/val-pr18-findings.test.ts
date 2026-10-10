// Validation of the code review of PR #18 (engine lanes shown as Working from lane status), 2026-10-08. One test per
// CONFIRMED finding; each fails on 27be910 and states the behaviour a fix must have. Fakes only: no tmux, no `lanes`.
// F2 and F5 tested the `lanes --json` adapter. That source is gone; the same expectations live in
// engine-registry.test.ts (a failed read is not served; a missing directory is warned once).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { LaneReport, NodeState, Sessions, Tmux, TranscriptSource } from "../src/application/ports.ts";

type Pane = { id: string; name: string; node: string; offline?: boolean };

function port(panes: Pane[], screens: Map<string, string>): Pick<Tmux, "listWorkers" | "captureMany"> {
  return {
    listWorkers: async () => panes.map(p => ({ id: p.id, name: p.name, location: "w", node: p.node, offline: p.offline ?? false })),
    captureMany: async ids => new Map(ids.map(id => [id, screens.get(id) ?? null])),
  };
}
const collect = (events: FeedEvent[]): Listener => ({ events: e => { events.push(...e); }, screen: () => {}, messages: () => {}, history: () => {}, watching: () => null });
const stateOf = (svc: ObservationService, name: string) => svc.snapshot().workers.find(w => w.name === name)?.state;
const report = (name: string, status: LaneReport["status"], engine: string | null): LaneReport => ({ name, status, engine });

afterEach(() => { vi.restoreAllMocks(); });

describe("PR #18 review findings", () => {
  // F1: an engine lane that `lanes` reports idle and whose pane changes (the owner typing into it, output arriving
  // before the next `lanes` read) goes active from the screen and quiet from the report in the same poll.
  it("F1: no poll flips one worker both active and quiet", async () => {
    const screens = new Map([["%1", "ready\n"]]);
    let clock = 1_000;
    const svc = new ObservationService(port([{ id: "%1", name: "cur-x", node: "local" }], screens), 60_000, () => clock, {
      lanes: async () => [report("cur-x", "idle", "cursor")],
    });
    const events: FeedEvent[] = [];
    svc.subscribe(collect(events));
    await svc.poll();
    const flipsPerPoll: string[][] = [];
    for (let i = 0; i < 3; i++) {
      clock += 1_500;
      screens.set("%1", `ready\ntyped ${i}\n`);
      const from = events.length;
      await svc.poll();
      flipsPerPoll.push(events.slice(from).map(e => e.body.type).filter(t => t === "WorkerBecameActive" || t === "WorkerBecameQuiet"));
    }
    for (const flips of flipsPerPoll) expect(flips).not.toEqual(["WorkerBecameActive", "WorkerBecameQuiet"]);
  });

  // F3: the PR says a Claude lane keeps its screen. A Claude lane that isn't followed yet (its transcript doesn't exist
  // until its first prompt, or a read failed) is driven by `lanes` instead. `engine` is parsed but never used.
  it("F3: a lane without an engine (a Claude lane) keeps its screen even when it isn't followed", async () => {
    const screens = new Map([["%1", "❯ \n"]]);
    const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: "builder", pane: "%1", cwd: "/w", version: null, pid: 1 }]]) };
    const transcripts: TranscriptSource = { size: async () => null, read: async () => null, locate: async () => null };
    const svc = new ObservationService(port([{ id: "%1", name: "builder", node: "local" }], screens), 60_000, () => 1_000, {
      sessions, transcripts, lanes: async () => [report("builder", "busy", null)],
    });
    await svc.poll();
    await svc.poll();
    expect(stateOf(svc, "builder")).toBe("quiet");          // a still pane, no transcript: the screen says quiet
  });

  // F4: with a fleet, the hub's own `lanes` (this machine) is matched by name to workers on every node.
  it("F4: the hub machine's lane report does not make a worker on another node Working", async () => {
    const screens = new Map([["mac.0a1b2c3d.1", "ready\n"], ["pc.3fa2c1d0.1", "ready\n"]]);
    const panes = [{ id: "mac.0a1b2c3d.1", name: "cur-x", node: "mac" }, { id: "pc.3fa2c1d0.1", name: "cur-y", node: "pc" }];
    const nodeStates = async () => new Map<string, NodeState>([["mac", "online"], ["pc", "online"]]);
    const svc = new ObservationService(port(panes, screens), 60_000, () => 1_000, {
      nodeStates, lanes: async () => [report("cur-x", "busy", "cursor"), report("cur-y", "busy", "cursor")],
    });
    await svc.poll();
    expect(stateOf(svc, "cur-x")).toBe("quiet");            // cur-x runs on mac; the report is pc's
  });

  // F8: a worker on a node that doesn't answer is held Working by the last report, with nothing seen of it.
  it("F8: an offline worker isn't held Working by a lane report", async () => {
    const screens = new Map([["box.0a0a0a0a.2", "ready\n"]]);
    let clock = 1_000;
    const svc = new ObservationService(port([{ id: "box.0a0a0a0a.2", name: "cur-x", node: "box", offline: true }], screens), 60_000, () => clock, {
      lanes: async () => [report("cur-x", "busy", "cursor")],
    });
    await svc.poll();
    clock += 120_000;                                         // two quiet periods with nothing seen of it
    await svc.poll();
    expect(stateOf(svc, "cur-x")).not.toBe("active");
  });
});
