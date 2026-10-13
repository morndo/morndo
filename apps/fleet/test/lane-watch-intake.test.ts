// The lane watch in the running fleet (reliable lanes §3.2): a Stop hook without a status makes a turn the watch holds;
// past its deadline the fleet stores a `stale` lane event (for the manager with the others), queues one nudge to the lane
// as a delivery, and GET /v1/lane-watch shows it. The fleet's clock is the test's.
import { describe, expect, it, vi } from "vitest";
import type { LaneEvent, LaneWatchEntry } from "@morndo/protocol";
import type { LaneEventsConfig } from "../src/config.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

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
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe("pc.3fa2c1d0.1"));
    pc.hook(1, "/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "I pushed the branch." }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    clock = T0 + 1 + 15 * MIN - 1;
    await new Promise(r => setTimeout(r, 100));
    const rows = () => fleet.db.prepare("SELECT event, lane, to_manager, body FROM lane_events ORDER BY seq").all() as { event: string; lane: string; to_manager: number | null; body: string }[];
    expect(rows().map(r => r.event)).toEqual(["finished"]);                            // not before its deadline
    clock = T0 + 1 + 15 * MIN;
    await vi.waitFor(() => expect(rows().map(r => r.event)).toEqual(["finished", "stale"]));
    expect(rows()[1]).toMatchObject({ lane: "api", to_manager: 0 });
    const lane = (await client(fleet.config.socketPath).get("/v1/lane-events?since=1"))?.body as { events: LaneEvent[] };
    expect(lane.events[0]).toMatchObject({ event: "stale", node: "pc", lane: "api", reason: "no_status", stalls: 1, sessionId: SID });
    await vi.waitFor(() => expect(pc.reqs.filter(q => q.op === "lane.deliver")).toHaveLength(1));
    const nudge = pc.reqs.find(q => q.op === "lane.deliver")?.args as { id: string; target: unknown; text: string };
    expect(nudge).toMatchObject({ id: `fleet:nudge:pc:${T0 + 1}`, target: { lane: "api" } });
    expect(nudge.text).toContain("without a status line");
    const watch = (await client(fleet.config.socketPath).get("/v1/lane-watch"))?.body as { lanes: LaneWatchEntry[] };
    expect(watch.lanes).toEqual([{ node: "pc", window: "api", at: T0 + 1, status: null, deadline: T0 + 1 + 15 * MIN, reason: "no_status", stale: true, stalls: 1 }]);
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
