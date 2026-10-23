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
    expect(drop(win("five-hour", { usedPercent: 20 }))).toEqual([{ kind: "drop", window: "five-hour", from: "80", to: "20", resetsAt: NOW + 3 * DAY }]);        // the reset 3 days ahead and unchanged
    expect(drop(win("five-hour", { usedPercent: 5, resetsAt: NOW + 10 * DAY }))).toEqual([]);                                          // the reset moved a cycle on
    expect(drop(win("five-hour", { usedPercent: 61 }))).toEqual([]);                                                                   // a fall of 19 is no drop
    expect(drop(win("five-hour", { usedPercent: 45, rolling: true }))).toEqual([]);                                                    // declared rolling
    expect(drop(win("five-hour", { usedPercent: 45 }))).toEqual([{ kind: "drop", window: "five-hour", from: "80", to: "45", resetsAt: NOW + 3 * DAY }]);       // not rolling: it is a drop
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

  it("a drop is confirmed by a second drop of the same window and reset, not by the same number", () => {
    const at = (pct: number, resetsAt = NOW + 3 * DAY) => fact({ windows: [win("five-hour", { usedPercent: pct, resetsAt })] });
    const a = watchPlan(noPlanWatch, at(80), NOW);
    const b = watchPlan(a.watch, at(20), NOW + MIN);
    expect(b.told).toEqual([]);
    const c = watchPlan(b.watch, at(22, NOW + 3 * DAY + 20_000), NOW + 2 * MIN);        // another number, the reset a few seconds apart
    expect(c.told).toEqual([{ kind: "drop", window: "five-hour", from: "80", to: "22", resetsAt: NOW + 3 * DAY + 20_000 }]);
    // a different window dropping, or the reset moved, is not the same change
    const two = (w: PlanWindow) => fact({ windows: [win("five-hour", { usedPercent: 80 }), win("weekly", { lengthMins: 10080, usedPercent: 80 })].map(x => (x.id === w.id ? w : x)) });
    const d1 = watchPlan(noPlanWatch, two(win("five-hour", { usedPercent: 80 })), NOW);
    const d2 = watchPlan(d1.watch, two(win("five-hour", { usedPercent: 20 })), NOW + MIN);
    const d3 = watchPlan(d2.watch, two(win("weekly", { lengthMins: 10080, usedPercent: 20 })), NOW + 2 * MIN);
    expect(d3.told).toEqual([]);
    expect(changeSignature({ kind: "drop", window: "five-hour", from: "80", to: "20", resetsAt: NOW + 3 * DAY })).toBe(changeSignature({ kind: "drop", window: "five-hour", from: "80", to: "26", resetsAt: NOW + 3 * DAY }));
    expect(changeSignature({ kind: "drop", window: "five-hour", from: "80", to: "20", resetsAt: NOW + 3 * DAY })).not.toBe(changeSignature({ kind: "drop", window: "weekly", from: "80", to: "20", resetsAt: NOW + 3 * DAY }));
  });

  it("a window the status line leaves out is no change, however often it goes and comes back", () => {
    const withBoth = fact();
    const without = fact({ windows: [win("weekly", { lengthMins: 10080 })] });
    let w = watchPlan(noPlanWatch, withBoth, NOW).watch;
    let told: unknown[] = [];
    for (const [i, f] of [without, without, withBoth, withBoth, without, without, withBoth, withBoth].entries()) {
      const r = watchPlan(w, f, NOW + (i + 1) * MIN);
      w = r.watch;
      told = told.concat(r.told);
    }
    expect(told).toEqual([]);
    // a reading that declares it carries the whole set can tell a removal, once a second such reading agrees
    const complete = (ws: PlanWindow[]) => fact({ windows: ws, complete: true });
    const c1 = watchPlan(noPlanWatch, complete([win("five-hour"), win("weekly", { lengthMins: 10080 })]), NOW);
    const c2 = watchPlan(c1.watch, complete([win("weekly", { lengthMins: 10080 })]), NOW + MIN);
    expect(c2.told).toEqual([]);
    const c3 = watchPlan(c2.watch, complete([win("weekly", { lengthMins: 10080 })]), NOW + 2 * MIN);
    expect(c3.told).toEqual([{ kind: "windows", window: null, from: "five-hour,weekly", to: "weekly" }]);
    // a window never seen before is a change even from a reading that is not complete, and told once
    const n1 = watchPlan(noPlanWatch, withBoth, NOW);
    const n2 = watchPlan(n1.watch, fact({ windows: [...withBoth.windows, win("other")] }), NOW + MIN);
    const n3 = watchPlan(n2.watch, fact({ windows: [...withBoth.windows, win("other")] }), NOW + 2 * MIN);
    expect(n3.told.map(c => c.kind)).toEqual(["windows"]);
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
