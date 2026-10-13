// The lane watch (reliable lanes §3.2): each lane's last turn and its deadline, one stale event per turn past it with
// nothing since, a nudge to the lane while it is worth one, stalls counted until the lane settles, and a rebuild at
// start that never calls a lane stale for time the fleet did not see. Driven with its own clock; the fleet wiring is in
// lane-watch-intake.test.ts.
import { describe, expect, it } from "vitest";
import type { HookEvent, LaneEvent } from "@morndo/protocol";
import type { LaneEventDraft } from "../src/adapters/lane-events-store.ts";
import type { DeliveryRequest } from "../src/application/deliveries.ts";
import { LaneWatch, NUDGE_MAX_STALLS, REBUILD_WINDOW_MS, nudgeText, type LaneWatchConfig } from "../src/application/lane-watch.ts";
import { quiet } from "./helpers/fleet.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const CONFIG: LaneWatchConfig = { waitingMin: 30, noStatusMin: 15, nudge: true };

function rig(o: { config?: LaneWatchConfig; alive?: boolean; online?: () => boolean; nudgeable?: () => boolean } = {}) {
  let now = T0;
  let seq = 0;
  const raised: LaneEventDraft[] = [];
  const nudged: DeliveryRequest[] = [];
  const alive = { value: o.alive ?? true };
  const watch = new LaneWatch({
    config: o.config ?? CONFIG, log: quiet, now: () => now, alive: () => alive.value, ...(o.online ? { online: o.online } : {}), ...(o.nudgeable ? { nudgeable: o.nudgeable } : {}),
    raise: d => { raised.push(d); return { ...d, seq: ++seq } as LaneEvent; },
    nudge: async r => { nudged.push(r); },
  });
  let n = 0;
  const finished = (at: number, over: Partial<LaneEvent> = {}): LaneEvent =>
    ({ v: 1, t: "lane", seq: ++n, event: "finished", node: "pc", window: "api", lane: "api", at, status: null, firstLine: "", bg: 0, crons: 0, ...over });
  const hook = (at: number, path: HookEvent["path"] = "/cc"): HookEvent => ({ streamId: "s", seq: ++n, at, path, node: "pc", window: "api", body: {} });
  return { watch, raised, nudged, alive, finished, hook, at: (t: number) => { now = t; } };
}

describe("the lane watch", () => {
  it("gives each kind of turn end its deadline: no status 15 min, background work 30, a wait its lease, a settled turn none", () => {
    const r = rig();
    r.watch.turn(r.finished(T0));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 15 * MIN, reason: "no_status", status: null });
    r.watch.turn(r.finished(T0, { bg: 2 }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 30 * MIN, reason: "waiting", waitingOn: "background work" });
    r.watch.turn(r.finished(T0, { crons: 1 }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 30 * MIN, waitingOn: "a scheduled wake-up" });
    r.watch.turn(r.finished(T0, { status: "waiting", waitingOn: "CI", until: T0 + 5 * MIN }));
    expect(r.watch.view()[0]).toMatchObject({ deadline: T0 + 5 * MIN, reason: "waiting", waitingOn: "CI", status: "waiting" });
    for (const status of ["done", "blocked", "needs_decision"] as const) {
      r.watch.turn(r.finished(T0, { status, bg: 1 }));
      expect(r.watch.view()[0]).toMatchObject({ deadline: null, status });
      expect(r.watch.view()[0]?.reason).toBeUndefined();
    }
  });

  it("past the deadline with nothing since: one stale event and one nudge for that turn; any hook since keeps it quiet", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { status: "waiting", waitingOn: "CI", until: T0 + 10 * MIN, sessionId: "s1" }));
    r.at(T0 + 10 * MIN - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // not yet
    r.at(T0 + 10 * MIN);
    r.watch.sweep();
    r.watch.sweep();                                                                    // once per turn
    expect(r.raised).toEqual([{ v: 1, t: "lane", event: "stale", node: "pc", window: "api", lane: "api", at: T0 + 10 * MIN, sessionId: "s1", reason: "waiting", waitingOn: "CI", since: T0, stalls: 1 }]);
    expect(r.nudged).toHaveLength(1);
    expect(r.nudged[0]).toMatchObject({ id: `fleet:nudge:pc:${T0}`, lane: "api" });
    expect(r.nudged[0]?.text).toContain("waiting on CI");
    expect(r.nudged[0]?.text).toContain("STATUS: DONE");
    // A new turn with a hook after it: activity, so no stale event (negative control: without the hook, one more).
    // Status line refreshes are not activity: Claude Code may re-run it on a timer while the lane sits idle.
    r.watch.turn(r.finished(T0 + 20 * MIN));
    r.watch.saw(r.hook(T0 + 21 * MIN));
    const idle = rig();
    idle.watch.turn(idle.finished(T0));
    for (let m = 1; m <= 16; m++) idle.watch.saw(idle.hook(T0 + m * MIN, "/sl"));
    idle.at(T0 + 16 * MIN);
    idle.watch.sweep();
    expect(idle.raised).toHaveLength(1);
    r.at(T0 + 60 * MIN);
    r.watch.sweep();
    expect(r.raised).toHaveLength(1);
  });

  it("counts stalls until the lane settles, and stops nudging after the second", () => {
    const r = rig();
    let t = T0;
    for (let i = 1; i <= NUDGE_MAX_STALLS + 1; i++) {
      r.watch.turn(r.finished(t));
      t += 16 * MIN;
      r.at(t);
      r.watch.sweep();
      expect(r.raised.at(-1)?.stalls).toBe(i);
    }
    expect(r.raised).toHaveLength(3);
    expect(r.nudged).toHaveLength(NUDGE_MAX_STALLS);                                   // the third is the orchestrator's to re-plan
    r.watch.turn(r.finished(t, { status: "done" }));
    r.watch.turn(r.finished(t + 1));
    r.at(t + 20 * MIN);
    r.watch.sweep();
    expect(r.raised.at(-1)?.stalls).toBe(1);                                            // DONE reset the count
  });

  it("drops a lane whose window is gone instead of calling it stale; nudges off by config", () => {
    const gone = rig({ alive: false });
    gone.watch.turn(gone.finished(T0));
    gone.at(T0 + 16 * MIN);
    gone.watch.sweep();
    expect([gone.raised, gone.watch.view()]).toEqual([[], []]);
    const noSession = rig({ nudgeable: () => false });                                 // a lane that runs no agent CLI
    noSession.watch.turn(noSession.finished(T0));
    noSession.at(T0 + 16 * MIN);
    noSession.watch.sweep();
    expect([noSession.raised.length, noSession.nudged.length]).toEqual([1, 0]);
    const quietRig = rig({ config: { ...CONFIG, nudge: false } });
    quietRig.watch.turn(quietRig.finished(T0));
    quietRig.at(T0 + 16 * MIN);
    quietRig.watch.sweep();
    expect([quietRig.raised.length, quietRig.nudged.length]).toEqual([1, 0]);
  });

  it("rebuilds from stored events with the restart as the new base: a deadline runs again in full, a reported turn stays reported", () => {
    const r = rig();
    const restart = T0 + 60 * MIN;
    r.at(restart);
    r.watch.rebuild([
      r.finished(T0, { window: "api", lane: "api" }),
      r.finished(T0, { window: "web", lane: "web" }),
      { v: 1, t: "lane", seq: 99, event: "stale", node: "pc", window: "web", lane: "web", at: T0 + 16 * MIN, since: T0, stalls: 1, reason: "no_status" },
    ]);
    expect(r.watch.view().find(v => v.window === "api")).toMatchObject({ deadline: restart + 15 * MIN, stale: false });
    expect(r.watch.view().find(v => v.window === "web")).toMatchObject({ stale: true, stalls: 1 });
    r.at(restart + 15 * MIN - 1);
    r.watch.sweep();
    expect(r.raised).toEqual([]);                                                       // negative control: no rebase, stale at once
    r.at(restart + 15 * MIN);
    r.watch.sweep();
    expect(r.raised.map(e => e.window)).toEqual(["api"]);
  });

  it("leaves a lane alone while its node is not online, and reports it once the node is back", () => {
    let online = false;
    const r = rig({ online: () => online });
    r.watch.turn(r.finished(T0));
    r.at(T0 + 16 * MIN);
    r.watch.sweep();
    expect([r.raised, r.watch.view().length]).toEqual([[], 1]);                     // kept, not dropped as gone
    online = true;
    r.watch.sweep();
    expect(r.raised).toHaveLength(1);
  });

  it("lets go of a settled turn a day old", () => {
    const r = rig();
    r.watch.turn(r.finished(T0, { status: "done" }));
    r.at(T0 + REBUILD_WINDOW_MS + 1);
    r.watch.sweep();
    expect(r.watch.view()).toEqual([]);
  });

  it("says in the nudge how long ago, on what, and the line to start with", () => {
    expect(nudgeText({ at: T0, reason: "no_status" }, T0 + 16 * MIN)).toMatch(/^\[fleet\] Your last turn ended 16 min ago without a status line/);
    expect(nudgeText({ at: T0, reason: "waiting", waitingOn: "the deploy" }, T0 + 31 * MIN)).toContain("31 min ago waiting on the deploy");
  });
});
