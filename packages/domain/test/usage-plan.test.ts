// Plan changes (U8): what differs between two facts, and what the principal is told — only once a later reading
// agrees (AT-28). A window whose usage falls hard while its reset stands still is a drop of points, not a reset;
// a rolling window never drops.
import { describe, expect, it } from "vitest";
import { changeSignature, noPlanWatch, observePlan, watchPlan, type PlanFact, type PlanWindow } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const win = (id: string, o: Partial<PlanWindow> = {}): PlanWindow => ({ id, lengthMins: 300, usedPercent: 50, resetsAt: NOW + 3 * DAY, rolling: false, ...o });
const fact = (o: Partial<PlanFact> = {}): PlanFact => ({ plan: "pro", identity: "seat-a@example.test", windows: [win("five-hour"), win("weekly", { lengthMins: 10080 })], ...o });

describe("plan changes (U8)", () => {
  it("a changed plan name is one change", () => {
    expect(observePlan(fact(), fact({ plan: "max" }), NOW)).toEqual([{ kind: "name", window: null, from: "pro", to: "max" }]);
    expect(observePlan(fact({ plan: null }), fact({ plan: "max" }), NOW)).toEqual([]);    // one side unknown: no change
    expect(observePlan(fact(), fact(), NOW)).toEqual([]);
  });

  it("a changed window set, length or account is a change", () => {
    expect(observePlan(fact(), fact({ identity: "seat-b@example.test" }), NOW)).toEqual([{ kind: "account", window: null, from: "seat-a@example.test", to: "seat-b@example.test" }]);
    expect(observePlan(fact(), fact({ windows: [win("five-hour"), win("other")] }), NOW)).toEqual([{ kind: "windows", window: null, from: "five-hour,weekly", to: "five-hour,other" }]);
    expect(observePlan(fact(), fact({ windows: [win("five-hour"), win("weekly", { lengthMins: 43200 })] }), NOW)).toEqual([{ kind: "cadence", window: "weekly", from: "10080", to: "43200" }]);
  });

  it("a drop needs the reset unchanged, and a rolling window never drops", () => {
    const drop = (after: PlanWindow) => observePlan(fact({ windows: [win("five-hour", { usedPercent: 80 })] }), fact({ windows: [after] }), NOW);
    expect(drop(win("five-hour", { usedPercent: 20 }))).toEqual([{ kind: "drop", window: "five-hour", from: "80", to: "20" }]);        // the reset 3 days ahead and unchanged
    expect(drop(win("five-hour", { usedPercent: 5, resetsAt: NOW + 10 * DAY }))).toEqual([]);                                          // the reset moved a cycle on
    expect(drop(win("five-hour", { usedPercent: 61 }))).toEqual([]);                                                                   // a fall of 19 is no drop
    expect(drop(win("five-hour", { usedPercent: 45, rolling: true }))).toEqual([]);                                                    // declared rolling
    expect(drop(win("five-hour", { usedPercent: 45 }))).toEqual([{ kind: "drop", window: "five-hour", from: "80", to: "45" }]);       // not rolling: it is a drop
    expect(observePlan(fact({ windows: [win("five-hour", { usedPercent: 80 })] }), fact({ windows: [win("five-hour", { usedPercent: 45 })] }), NOW, ["five-hour"])).toEqual([]);   // remembered rolling
    // the rolling memory: a fall with the reset moving later, while the old cycle is still ahead, is remembered
    const w1 = watchPlan(noPlanWatch, fact({ windows: [win("five-hour", { usedPercent: 80, resetsAt: NOW + 4 * HOUR })] }), NOW);
    const w2 = watchPlan(w1.watch, fact({ windows: [win("five-hour", { usedPercent: 45, resetsAt: NOW + 4 * HOUR + 40 * MIN })] }), NOW + 10 * MIN);
    expect(w2.watch.rolling).toEqual(["five-hour"]);
    const w3 = watchPlan(w2.watch, fact({ windows: [win("five-hour", { usedPercent: 5, resetsAt: NOW + 4 * HOUR + 40 * MIN })] }), NOW + 20 * MIN);
    expect(w3.told).toEqual([]);
    // the cycle-forward case is not remembered: the old cycle had already ended when the read came
    const c1 = watchPlan(noPlanWatch, fact({ windows: [win("five-hour", { usedPercent: 80, resetsAt: NOW + HOUR })] }), NOW);
    const c2 = watchPlan(c1.watch, fact({ windows: [win("five-hour", { usedPercent: 45, resetsAt: NOW + 5 * HOUR })] }), NOW + 2 * HOUR);
    expect(c2.watch.rolling).toEqual([]);
  });

  it("one odd reading tells nothing", () => {
    // the first fact ever is never a change
    const first = watchPlan(noPlanWatch, fact(), NOW);
    expect(first.told).toEqual([]);
    expect(first.watch.baseline).toEqual(fact());
    const a = fact({ plan: "pro" });
    const b = fact({ plan: "max" });
    // A, B, A: the odd reading is held and never told; the return to the baseline clears it
    const w1 = watchPlan(noPlanWatch, a, NOW);
    const w2 = watchPlan(w1.watch, b, NOW + MIN);
    expect(w2.told).toEqual([]);
    const w3 = watchPlan(w2.watch, a, NOW + 2 * MIN);
    expect(w3.told).toEqual([]);
    expect(w3.watch.held).toBeNull();
    expect(w3.watch.baseline).toEqual(a);
    // A, B, B: two agreeing readings tell the change once, naming the plan
    const v1 = watchPlan(noPlanWatch, a, NOW);
    const v2 = watchPlan(v1.watch, b, NOW + MIN);
    expect(v2.told).toEqual([]);
    const v3 = watchPlan(v2.watch, b, NOW + 2 * MIN);
    expect(v3.told).toEqual([{ kind: "name", window: null, from: "pro", to: "max" }]);
    expect(v3.watch.baseline).toEqual(b);
    expect(v3.watch.held).toBeNull();
    // a reading not later than the last one taken is ignored
    expect(watchPlan(v3.watch, a, NOW + 2 * MIN)).toEqual({ watch: v3.watch, told: [] });
    expect(changeSignature({ kind: "name", window: null, from: "pro", to: "max" })).toBe("name||max");
  });
});
