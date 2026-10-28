// Lane stalls (2026-10-28): the stale events of one week, replayed in the running fleet by their kind. Of 74, 9 were
// Claude Code's idle compaction read as a lost turn end, 12 a wait whose "about N min" went unread, 48 a lane whose own
// background job or wake-up was still armed (36 just waited again when nudged), and most of the rest answered the nudge
// within a minute. A stale event now means a lane that needs the manager: no answer to a nudge within 10 minutes, a third
// expiry since it last settled, a lane that can't be nudged, or a turn end that really went missing. The fleet's clock is
// the test's; hooks carry the node's time.
import { describe, expect, it, vi } from "vitest";
import type { LaneEventsConfig } from "../src/config.ts";
import { health, type FakeAgent, type Req } from "./helpers/fake-agent.ts";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const TO_MANAGER: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 60_000 };
const NUDGING = { laneEvents: TO_MANAGER, laneWatch: { waitingMin: 30, noStatusMin: 15, nudge: true } };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const WORKER = "pc.3fa2c1d0.1";
const T0 = 1_700_000_000_000;                                                          // 2023-11-14T22:13:20Z
const MIN = 60_000;

const api = (status: "busy" | "idle" | "shell") => [{ workerId: WORKER, window: "api", cwd: "/w", sessionId: SID, status, pid: 1 }];
const taken = () => new Promise(r => setTimeout(r, 50));
const settle = () => new Promise(r => setTimeout(r, 150));
const rows = (fleet: TestFleet) => fleet.db.prepare("SELECT event, to_manager, body FROM lane_events ORDER BY seq").all() as { event: string; to_manager: number | null; body: string }[];
const events = (fleet: TestFleet) => rows(fleet).map(r => r.event);
const bodyOf = (fleet: TestFleet, i: number) => JSON.parse(rows(fleet)[i]?.body ?? "{}") as Record<string, unknown>;
const nudges = (pc: FakeAgent) => pc.reqs.filter((q: Req) => q.op === "lane.deliver");
const stop = (text: string, more: Record<string, unknown> = {}) => ({ session_id: SID, hook_event_name: "Stop", last_assistant_message: text, ...more });
const shellTask = { id: "b1", type: "shell", status: "running", description: "gh pr checks 12 --watch", command: "gh pr checks 12 --watch" };

async function lane(clock: { now: number }) {
  const fleet = await startTestFleet({ now: () => clock.now, laneWatchSweepMs: 20, config: NUDGING });
  const pc = await fleet.online("pc");
  pc.inventory(api("idle"));
  await vi.waitFor(() => expect(fleet.lanes.get("api")?.workerId).toBe(WORKER), { timeout: 10_000 });
  return { fleet, pc };
}

describe("lane stalls: a turn end that never arrived", () => {
  it("idle compaction is no lost turn: the session goes busy and idle with no hook from the lane, and nothing is flagged", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("STATUS: DONE T-1 shipped"), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 55 * MIN;                                                         // about an hour on, Claude Code compacts the idle conversation
    pc.inventory(api("busy"));
    await taken();
    clock.now = T0 + 56 * MIN;
    pc.inventory(api("idle"));
    await taken();
    clock.now = T0 + 63 * MIN;                                                         // past the 5-minute grace for a lost turn end
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    expect(nudges(pc)).toEqual([]);
  });

  it("a typed prompt that ends with no turn end is still flagged once, with no nudge (negative control)", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("STATUS: DONE T-1 shipped"), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 10 * MIN;
    pc.inventory(api("busy"));
    await taken();
    pc.hook(2, "/cc", { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "carry on" }, { window: "api", at: T0 + 10 * MIN + 1_000 });
    expect(await pc.acked(2)).toBe(2);
    clock.now = T0 + 11 * MIN;
    pc.inventory(api("idle"));
    await taken();
    clock.now = T0 + 17 * MIN;
    await vi.waitFor(() => expect(events(fleet)).toEqual(["finished", "stale"]));
    expect(bodyOf(fleet, 1)).toMatchObject({ reason: "no_turn_end", stalls: 1 });
    await settle();
    expect(nudges(pc)).toEqual([]);
  });
});

describe("lane stalls: a wait's deadline", () => {
  it("reads 'about 265 min' and gives the wait 1.5 times that plus 10 minutes: nothing at 30 minutes, a nudge after the lease", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("STATUS: WAITING T-107 on wave 1 to finish, about 265 min"), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    expect(bodyOf(fleet, 0)).toMatchObject({ event: "finished", status: "waiting", waitingOn: "wave 1 to finish", until: T0 + 24_450_000 });
    clock.now = T0 + 31 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    expect(nudges(pc)).toEqual([]);
    clock.now = T0 + 24_450_000 + MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    expect(events(fleet)).toEqual(["finished"]);                                       // a nudge first; no stale event yet
  });

  it("a lane whose background shell still runs is not nudged past its lease; 2 minutes after the shell is gone it is, and 10 minutes after that it is stale", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("Watching the checks.", { background_tasks: [shellTask], session_crons: [] }), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + MIN;
    pc.inventory(api("shell"));
    await taken();
    clock.now = T0 + 31 * MIN;
    await settle();
    clock.now = T0 + 90 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    expect(nudges(pc)).toEqual([]);
    pc.inventory(api("idle"));                                                         // the shell ended at T0 + 90 min and no turn followed
    await taken();
    clock.now = T0 + 91 * MIN;
    await settle();
    expect(nudges(pc)).toEqual([]);
    clock.now = T0 + 93 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    expect(events(fleet)).toEqual(["finished"]);
    clock.now = T0 + 102 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    clock.now = T0 + 104 * MIN;
    await vi.waitFor(() => expect(events(fleet)).toEqual(["finished", "stale"]));
    expect(rows(fleet)[1]?.to_manager).toBe(0);
    expect(bodyOf(fleet, 1)).toMatchObject({ reason: "waiting", waitingOn: "background work", since: T0, stalls: 1 });
  });

  it("a background shell that runs past six hours no longer holds the nudge back", async () => {
    const clock = { now: T0 };
    const { pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("Tailing the log.", { background_tasks: [shellTask], session_crons: [] }), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + MIN;
    pc.inventory(api("shell"));
    await taken();
    clock.now = T0 + 359 * MIN;
    await settle();
    expect(nudges(pc)).toEqual([]);
    clock.now = T0 + 361 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
  });

  it("a lane with a one-shot wake-up due in three hours is not nudged at 30 minutes, but after its fire time plus 5 minutes", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.health(health({ tzOffsetMin: 60 }));
    await taken();
    // T0 is 23:13:20 on the node (UTC+1): its 02:13 wake-up fires at 01:13:00Z the next day.
    const fire = Date.parse("2023-11-15T01:13:00.000Z");
    pc.hook(1, "/hook/stop", stop("STATUS: WAITING T-516 on the 05:00Z release", { background_tasks: [], session_crons: [{ id: "c1", schedule: "13 2 * * *", recurring: false, prompt: "check the release" }] }), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 31 * MIN;
    await settle();
    clock.now = fire + 4 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    expect(nudges(pc)).toEqual([]);
    clock.now = fire + 6 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    expect(events(fleet)).toEqual(["finished"]);
  });
});

describe("lane stalls: a nudge first, the manager only when it is needed", () => {
  it("a nudged lane that answers gets no stale event: the manager hears of its new turn, not of a stall", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("I pushed the branch."), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 16 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    expect(events(fleet)).toEqual(["finished"]);
    pc.hook(2, "/cc", { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "[fleet] Your last turn ended" }, { window: "api", at: T0 + 16 * MIN + 2_000 });
    pc.hook(3, "/hook/stop", stop("STATUS: WAITING on CI for 20 min"), { window: "api", at: T0 + 17 * MIN });
    expect(await pc.acked(3)).toBe(3);
    clock.now = T0 + 27 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished", "finished"]);
  });

  it("a nudge with no answer for 10 minutes becomes the stale event, for the manager", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("I pushed the branch."), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 16 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    expect(events(fleet)).toEqual(["finished"]);
    clock.now = T0 + 25 * MIN;
    await settle();
    expect(events(fleet)).toEqual(["finished"]);
    clock.now = T0 + 27 * MIN;
    await vi.waitFor(() => expect(events(fleet)).toEqual(["finished", "stale"]));
    expect(rows(fleet)[1]?.to_manager).toBe(0);
    expect(bodyOf(fleet, 1)).toMatchObject({ reason: "no_status", since: T0, stalls: 1 });
    expect(nudges(pc)).toHaveLength(1);
  });

  it("the third expiry since the lane last settled goes to the manager at once, without a nudge; the two before it were nudges only", async () => {
    const clock = { now: T0 };
    const { fleet, pc } = await lane(clock);
    pc.hook(1, "/hook/stop", stop("Still on it."), { window: "api", at: T0 });
    expect(await pc.acked(1)).toBe(1);
    clock.now = T0 + 16 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(1));
    pc.hook(2, "/hook/stop", stop("Still on it."), { window: "api", at: T0 + 17 * MIN });
    expect(await pc.acked(2)).toBe(2);
    clock.now = T0 + 33 * MIN;
    await vi.waitFor(() => expect(nudges(pc)).toHaveLength(2));
    pc.hook(3, "/hook/stop", stop("Still on it."), { window: "api", at: T0 + 34 * MIN });
    expect(await pc.acked(3)).toBe(3);
    clock.now = T0 + 50 * MIN;
    await vi.waitFor(() => expect(events(fleet)).toEqual(["finished", "finished", "finished", "stale"]));
    expect(bodyOf(fleet, 3)).toMatchObject({ reason: "no_status", stalls: 3 });
    await settle();
    expect(nudges(pc)).toHaveLength(2);
  });
});
