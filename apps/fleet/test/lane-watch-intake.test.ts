// The lane watch in the running fleet (reliable lanes §3.2): a Stop hook without a status makes a turn the watch holds;
// past its deadline the fleet stores a `stale` lane event (for the manager with the others), queues one nudge to the lane
// as a delivery, and GET /v1/lane-watch shows it. The fleet's clock is the test's.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LaneEvent, LaneWatchEntry } from "@morndo/protocol";
import { createLogger } from "../src/adapters/log.ts";
import type { LaneEventsConfig } from "../src/config.ts";
import type { Req } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const TO_MANAGER: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 60_000 };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const T0 = 1_700_000_000_000;                                                          // the fake agent's hooks are at T0 + seq
const MIN = 60_000;

describe("the lane watch in the fleet", () => {
  it("a turn without a status is stale 15 min on: a stale event for the manager, a nudge to the lane, and the watch's view", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER, laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: true } } });
    const pc = await fleet.online("pc");
    // api runs the agent CLI (a session); sh runs none, so it can be stale but is never nudged.
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }, { workerId: "pc.3fa2c1d0.3", window: "sh", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("sh")?.workerId).toBe("pc.3fa2c1d0.3"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "I pushed the branch." }, { window: "api" });
    pc.hook(2, "/hook/stop", { text: "built" }, { window: "sh" });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 1 + 15 * MIN - 1;
    await new Promise(r => setTimeout(r, 100));
    const rows = () => fleet.db.prepare("SELECT event, lane, to_manager, body FROM lane_events ORDER BY seq").all() as { event: string; lane: string; to_manager: number | null; body: string }[];
    expect(rows().map(r => r.event)).toEqual(["finished", "finished"]);                // not before its deadline
    clock = T0 + 2 + 15 * MIN;
    await vi.waitFor(() => expect(rows().map(r => r.event)).toEqual(["finished", "finished", "stale", "stale"]));
    expect(rows()[2]).toMatchObject({ lane: "api", to_manager: 0 });
    const lane = (await client(fleet.config.socketPath).get("/v1/lane-events?since=2"))?.body as { events: LaneEvent[] };
    expect(lane.events[0]).toMatchObject({ event: "stale", node: "pc", lane: "api", reason: "no_status", stalls: 1, sessionId: SID });
    await vi.waitFor(() => expect(pc.reqs.filter(q => q.op === "lane.deliver")).toHaveLength(1));
    const nudge = pc.reqs.find(q => q.op === "lane.deliver")?.args as { id: string; target: unknown; text: string };
    expect(nudge).toMatchObject({ id: `fleet:nudge:pc.3fa2c1d0.1:${T0 + 1}`, target: { workerId: "pc.3fa2c1d0.1" } });
    expect(nudge.text).toContain("without a status line");
    const watch = (await client(fleet.config.socketPath).get("/v1/lane-watch"))?.body as { lanes: LaneWatchEntry[] };
    expect(watch.lanes).toEqual([
      { node: "pc", window: "api", at: T0 + 1, status: null, deadline: T0 + 1 + 15 * MIN, reason: "no_status", stale: true, stalls: 1 },
      { node: "pc", window: "sh", at: T0 + 2, status: null, deadline: T0 + 2 + 15 * MIN, reason: "no_status", stale: true, stalls: 1 },
    ]);
    expect(pc.reqs.filter(q => q.op === "lane.deliver")).toHaveLength(1);              // only api, which runs the agent CLI
  });

  it("a Stop the relay asked for a status makes no lane event, but goes stale as a turn without one if nothing follows", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed.", statusAsked: true }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    const events = () => (fleet.db.prepare("SELECT event FROM lane_events ORDER BY seq").all() as { event: string }[]).map(r => r.event);
    expect(events()).toEqual([]);
    clock = T0 + 1 + 15 * MIN;
    await vi.waitFor(() => expect(events()).toEqual(["stale"]));
  });

  it("a turn that says DONE is never stale, and the manager's own lane is not watched", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }, { workerId: "pc.3fa2c1d0.2", window: "manager", cwd: "/m" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeTruthy());
    pc.hook(1, "/hook/stop", { session_id: SID, last_assistant_message: "STATUS: DONE\nMerged." }, { window: "api" });
    pc.hook(2, "/hook/stop", { session_id: "m", last_assistant_message: "Planning." }, { window: "manager" });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 3 * 60 * MIN;
    await new Promise(r => setTimeout(r, 150));
    expect((fleet.db.prepare("SELECT event FROM lane_events").all() as { event: string }[]).map(r => r.event)).toEqual(["finished"]);
    expect(fleet.laneWatch.view()).toMatchObject([{ window: "api", status: "done", deadline: null, stale: false }]);
  });
});

// The watch judges activity by each hook's own time on its node, tries a refused stale event again, and nudges a lane at
// its own pane by worker ID: each case as the running fleet shows it (client API, fleet.db, the requests a node gets).
describe("the lane watch in the fleet: activity by the hook's own time, retries, nudges by worker ID", () => {
  const SID2 = "5e1b7a90-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
  const NUDGING = { laneEvents: TO_MANAGER, laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: true } };
  // A node's queue as the real one answers lane.deliver: the delivery asked for, queued.
  const queued = (node: string) => (req: Req) => {
    const a = req.args as { id: string; target: unknown };
    return { ok: true as const, result: { delivery: { id: a.id, node, target: a.target, state: "queued", queuedAt: 1, notAfter: 2 } } };
  };
  const events = async (socketPath: string) => {
    const lane = (await client(socketPath).get("/v1/lane-events?since=0"))?.body as { events: LaneEvent[] };
    return lane.events.map(e => `${e.event} ${e.node}/${e.lane ?? ""}`);
  };
  const delivered = (reqs: Req[]) => reqs.filter(q => q.op === "lane.deliver").map(q => q.args as { id: string; target: unknown });

  it("a hook the fleet takes in the same batch as the Stop before it is activity", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api" });
    pc.hook(2, "/cc", { session_id: SID, hook_event_name: "PreToolUse" }, { window: "api" });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 1 + 16 * MIN;
    await new Promise(r => setTimeout(r, 150));
    expect(await events(fleet.config.socketPath)).toEqual(["finished pc/api"]);
  });

  it("after a restart, a hook the node sends on from the outage, or a stored needs_input after the turn end, is activity", async () => {
    for (const after of ["replayed /cc", "stored needs_input"] as const) {
      const dir = tempDir();
      let clock = T0;
      const f1 = await startTestFleet({ dir, now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
      const pc1 = await f1.online("pc");
      pc1.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
      await vi.waitFor(() => expect(f1.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
      pc1.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api" });
      if (after === "stored needs_input") pc1.hook(2, "/lane", { event: "needs_input", sessionId: SID, question: "Allow npm test?" }, { window: "api", at: T0 + MIN });
      expect(await pc1.acked(after === "stored needs_input" ? 2 : 1)).toBeGreaterThanOrEqual(1);
      pc1.terminate();
      await f1.close();
      clock = T0 + 5 * MIN;                                                            // the fleet is back 5 min later
      const f2 = await startTestFleet({ dir, now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
      const pc2 = f2.agent({ node: "pc", key: pc1.key, streamId: pc1.streamId });
      expect((await pc2.connect()).ok).toBe(true);
      pc2.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "busy", pid: 1 }]);
      await vi.waitFor(() => expect(f2.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
      if (after === "replayed /cc") {
        pc2.hook(2, "/cc", { session_id: SID, hook_event_name: "PreToolUse" }, { window: "api", at: T0 + 2 * MIN });   // spooled in the outage
        expect(await pc2.acked(2)).toBe(2);
      }
      clock = T0 + 5 * MIN + 16 * MIN;
      await new Promise(r => setTimeout(r, 150));
      expect([after, (await events(f2.config.socketPath)).filter(e => e.startsWith("stale"))]).toEqual([after, []]);
      await f2.close();
    }
  });

  it("a stale event fleet.db refused is stored on the next sweep", async () => {
    let clock = T0;
    const lines: string[] = [];
    const fleet = await startTestFleet({
      now: () => clock, laneWatchSweepMs: 3_600_000, log: createLogger({ level: "error", sink: line => { lines.push(line); } }), config: { laneEvents: TO_MANAGER },
    });
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    const other = new Database(join(fleet.dir, "fleet.db"));
    other.exec("BEGIN IMMEDIATE");                                                    // another writer holds fleet.db
    clock = T0 + 1 + 16 * MIN;
    fleet.laneWatch.sweep();                                                            // waits out the busy timeout, then gives up
    expect(lines.filter(l => l.includes("could not be stored"))).toHaveLength(1);
    other.exec("COMMIT");
    other.close();
    fleet.laneWatch.sweep();
    expect(await events(fleet.config.socketPath)).toEqual(["finished pc/api", "stale pc/api"]);
    expect(fleet.laneWatch.view()).toMatchObject([{ window: "api", stale: true, stalls: 1 }]);
  }, 30_000);

  it("a stale lane is nudged at its own pane though another node's window has its name, and that node's lane is watched too", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: NUDGING });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    pc.answer = queued("pc");
    mac.answer = queued("mac");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
    mac.inventory([{ workerId: "mac.4ab3c2d1.1", window: "api", cwd: "/w", sessionId: SID2, status: "idle", pid: 2 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).toMatchObject({ node: "pc", conflict: true }));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api" });
    mac.hook(1, "/hook/stop", { session_id: SID2, hook_event_name: "Stop", last_assistant_message: "Built." }, { window: "api" });
    expect([await pc.acked(1), await mac.acked(1)]).toEqual([1, 1]);
    clock = T0 + 1 + 16 * MIN;
    await vi.waitFor(() => expect([delivered(pc.reqs).length, delivered(mac.reqs).length]).toEqual([1, 1]));
    expect(delivered(pc.reqs)[0]).toMatchObject({ id: `fleet:nudge:pc.3fa2c1d0.1:${T0 + 1}`, target: { workerId: "pc.3fa2c1d0.1" } });
    expect(delivered(mac.reqs)[0]).toMatchObject({ id: `fleet:nudge:mac.4ab3c2d1.1:${T0 + 1}`, target: { workerId: "mac.4ab3c2d1.1" } });
    expect((await events(fleet.config.socketPath)).sort()).toEqual(["finished mac/api", "finished pc/api", "stale mac/api", "stale pc/api"]);
  });

  it("the agent CLI's idle notice is no activity", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);                                                  // its own batch: a minute after the Stop
    pc.hook(2, "/notify", { session_id: SID, hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }, { window: "api", at: T0 + 1 + MIN });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 1 + 16 * MIN;
    await new Promise(r => setTimeout(r, 150));
    expect(await events(fleet.config.socketPath)).toEqual(["finished pc/api", "stale pc/api"]);
  });

  it("two lanes of one node whose turns ended in the same ms get nudges with ids of their own", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: NUDGING });
    const pc = await fleet.online("pc");
    pc.answer = queued("pc");
    pc.inventory([
      { workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status: "idle", pid: 1 },
      { workerId: "pc.3fa2c1d0.2", window: "web", cwd: "/w", sessionId: SID2, status: "idle", pid: 2 },
    ]);
    await vi.waitFor(() => expect(fleet.lanes.get("web")?.workerId).toBe("pc.3fa2c1d0.2"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed." }, { window: "api", at: T0 + 1 });
    pc.hook(2, "/hook/stop", { session_id: SID2, hook_event_name: "Stop", last_assistant_message: "Built." }, { window: "web", at: T0 + 1 });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 1 + 16 * MIN;
    await vi.waitFor(() => expect(delivered(pc.reqs)).toHaveLength(2));
    expect(delivered(pc.reqs).map(d => d.id).sort()).toEqual([`fleet:nudge:pc.3fa2c1d0.1:${T0 + 1}`, `fleet:nudge:pc.3fa2c1d0.2:${T0 + 1}`]);
  });
});

// A Stop that never arrived (T-422): the session goes idle after work the watch saw start, and no turn end follows.
// The fleet's clock is the test's; each inventory is given a moment to be taken before the clock moves.
describe("a turn end the fleet never received (T-422)", () => {
  const NUDGING = { laneEvents: TO_MANAGER, laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: true } };
  const api = (status: "busy" | "idle") => [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", sessionId: SID, status, pid: 1 }];
  const taken = () => new Promise(r => setTimeout(r, 50));
  const texts = (reqs: Req[]) => reqs.filter(q => q.op === "lane.deliver").map(q => (q.args as { text: string }).text);

  it("flags a blocked lane that went back to work and idle with no Stop, once, and nudges for a status line", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: NUDGING });
    const pc = await fleet.online("pc");
    pc.inventory(api("idle"));
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "STATUS: BLOCKED T-1 x" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    clock = T0 + MIN;
    pc.inventory(api("busy"));
    await taken();
    clock = T0 + 30 * MIN;
    pc.inventory(api("idle"));
    await taken();
    clock = T0 + 35 * MIN;
    await vi.waitFor(() => expect(texts(pc.reqs).join("\n")).toContain("never received its end"));
    const rows = fleet.db.prepare("SELECT event, body FROM lane_events ORDER BY seq").all() as { event: string; body: string }[];
    expect(rows.map(r => r.event)).toEqual(["finished", "stale"]);
    expect(JSON.parse(rows[1]?.body ?? "{}")).toMatchObject({ reason: "no_turn_end", stalls: 1 });
    expect(texts(pc.reqs)).toHaveLength(1);
  });

  it("does not flag when a Stop arrives after the lane went busy", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: NUDGING });
    const pc = await fleet.online("pc");
    pc.inventory(api("idle"));
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "STATUS: BLOCKED T-1 x" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    clock = T0 + MIN;
    pc.inventory(api("busy"));
    await taken();
    pc.hook(2, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "STATUS: DONE\nshipped" }, { window: "api", at: clock + 1_000 });
    expect(await pc.acked(2)).toBe(2);
    clock = T0 + 30 * MIN;
    pc.inventory(api("idle"));
    await taken();
    clock = T0 + 35 * MIN;
    await new Promise(r => setTimeout(r, 150));
    const events = (fleet.db.prepare("SELECT event FROM lane_events ORDER BY seq").all() as { event: string }[]).map(r => r.event);
    expect(events).toEqual(["finished", "finished"]);
    expect(texts(pc.reqs).join("\n")).not.toContain("never received its end");
  });

  it("a window named like the manager gets nothing", async () => {
    let clock = T0;
    const fleet = await startTestFleet({ now: () => clock, laneWatchSweepMs: 20, config: NUDGING });
    const pc = await fleet.online("pc");
    const manager = (status: "busy" | "idle") => [{ workerId: "pc.3fa2c1d0.2", window: "manager", cwd: "/m", sessionId: SID, status, pid: 2 }];
    pc.inventory(manager("idle"));
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeTruthy());
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "STATUS: BLOCKED T-1 x" }, { window: "manager" });
    expect(await pc.acked(1)).toBe(1);
    clock = T0 + MIN;
    pc.inventory(manager("busy"));
    await taken();
    clock = T0 + 30 * MIN;
    pc.inventory(manager("idle"));
    await taken();
    clock = T0 + 35 * MIN;
    await new Promise(r => setTimeout(r, 150));
    expect((fleet.db.prepare("SELECT event FROM lane_events").all() as { event: string }[])).toEqual([]);
    expect(texts(pc.reqs).join("\n")).not.toContain("never received its end");
  });
});
