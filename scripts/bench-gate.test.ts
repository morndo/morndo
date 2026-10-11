// The hook swap's gate (scripts/bench-gate.ts; fleet clients spec §6, "Gate for the swap"; plan/RECONCILIATION.md ruling 38)
// on numbers made up to sit on each side of its limits: the arithmetic, not the bench. scripts/bench-relay.ts --gate prints
// these lines, the last one `gate: PASS` or `gate: FAIL (…)`, and exits 1 when the gate fails.
import { describe, expect, it } from "vitest";
import { GATE, gate, nearestRank, type BenchRun } from "./bench-gate.ts";

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));
// A run that passes: 2 hooks a second, all 100 answered and delivered, deliveries of 1 to 100 ms, ops of 10 ms.
const good: BenchRun = {
  rate: 2, hooks: 100, answered: 100, delivered: 100, hookFailures: 0, opFailures: 0, deliver: range(100, i => i + 1), op: range(40, () => 10),
};
const last = (r: BenchRun) => gate(r).lines.at(-1);

describe("nearestRank", () => {
  it("is the smallest sample with at least p % of the samples at or below it", () => {
    expect(nearestRank(range(100, i => i + 1), 95)).toBe(95);
    expect(nearestRank(range(20, i => i + 1), 95)).toBe(19);
    expect(nearestRank([7], 95)).toBe(7);
    expect(nearestRank([], 95)).toBeNull();
    expect(nearestRank([5, 1, 4, 2, 3], 50)).toBe(3);               // in any order
    expect(nearestRank([5, 1, 4, 2, 3], 100)).toBe(5);
  });
});

describe("the gate", () => {
  it("passes a run within both limits: the measured numbers, then exactly `gate: PASS`", () => {
    expect(gate(good)).toEqual({
      pass: true,
      lines: ["gate: deliver p95 95.0 ms (bound 1000 ms), slowest op 10.0 ms (bound 2000 ms), 100/100 hooks delivered at 2/s", "gate: PASS"],
    });
  });

  it("holds the deliver p95 to 1 s: exactly 1000 ms passes, a little over fails", () => {
    const at = (ms: number): BenchRun => ({ ...good, deliver: range(100, i => (i < 94 ? 10 : ms)) });   // the 95th sample and up
    expect(last(at(GATE.deliverP95Ms))).toBe("gate: PASS");
    expect(gate(at(1000.5))).toMatchObject({ pass: false });
    expect(last(at(1000.5))).toBe("gate: FAIL (deliver p95 1000.5 ms over 1000 ms)");
  });

  it("holds every op to 2 s: one slow op among fast ones fails", () => {
    expect(last({ ...good, op: [...good.op, GATE.opMaxMs] })).toBe("gate: PASS");
    expect(last({ ...good, op: [...good.op, 2000.1] })).toBe("gate: FAIL (slowest op 2000.1 ms over 2000 ms)");
  });

  it("counts an op that failed or gave up as over the limit", () => {
    expect(last({ ...good, opFailures: 1 })).toBe("gate: FAIL (1 client ops failed or gave up)");
  });

  it("fails a run that lost hooks: unanswered at the relay, or never at the subscriber", () => {
    expect(last({ ...good, answered: 99, hookFailures: 1 })).toBe("gate: FAIL (1 of 100 hooks failed at the relay)");
    expect(last({ ...good, delivered: 97 })).toBe("gate: FAIL (3 hooks never reached the subscriber)");
  });

  it("fails a run slower than the gate's rate, or one with nothing measured, naming every bound it missed", () => {
    expect(last({ ...good, rate: 1 })).toBe("gate: FAIL (rate 1/s under 2/s)");
    const empty = gate({ ...good, hooks: 0, answered: 0, delivered: 0, deliver: [], op: [] });
    expect(empty).toEqual({
      pass: false,
      lines: ["gate: deliver p95 none (bound 1000 ms), slowest op none (bound 2000 ms), 0/0 hooks delivered at 2/s",
        "gate: FAIL (no hook reached the subscriber; no client op ran)"],
    });
  });
});
