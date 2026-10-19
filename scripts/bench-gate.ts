// The hook swap's gate (fleet clients spec §6, "Gate for the swap"; Task 17): measured with scripts/bench-relay.ts on the
// owner's PC, its HDD, at 2 hooks a second, a hook reaches a subscriber within 1 s at p95, and no client op through the
// fleet takes over 2 s while hooks flow. If it isn't met, the fleet's intake commits move to a worker thread (spec §6), and
// the swap waits. Percentiles are by the nearest-rank method: the smallest sample with at least p % of the samples at or
// below it, so a p95 is always a time some hook really took.
// Its last line is `gate: PASS`, or `gate: FAIL (<which bound>)` (plan/RECONCILIATION.md ruling 38), which the rollout
// greps for (its step 3, outside this tree); the line before it gives the measured numbers.
export const GATE = { deliverP95Ms: 1000, opMaxMs: 2000, minRate: 2 } as const;

export function nearestRank(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

// One run as bench-relay counts it: the hooks sent, answered by the relay and delivered to the subscriber; the deliver
// times (from a hook's answer to its arrival at the subscriber) and the client ops' times while hooks flowed, in ms; the
// ops that failed or gave up.
export type BenchRun = {
  rate: number; hooks: number; answered: number; delivered: number; hookFailures: number; opFailures: number; deliver: number[]; op: number[];
};

const ms = (v: number | null) => (v === null ? "none" : `${v.toFixed(1)} ms`);

export function gate(r: BenchRun): { pass: boolean; lines: string[] } {
  const p95 = nearestRank(r.deliver, 95);
  const slowest = r.op.length ? Math.max(...r.op) : null;
  const failed: string[] = [];
  if (r.rate < GATE.minRate) failed.push(`rate ${r.rate}/s under ${GATE.minRate}/s`);
  if (r.hookFailures > 0 || r.answered < r.hooks) failed.push(`${r.hooks - r.answered} of ${r.hooks} hooks failed at the relay`);
  if (r.delivered < r.answered) failed.push(`${r.answered - r.delivered} hooks never reached the subscriber`);
  if (p95 === null) failed.push("no hook reached the subscriber");
  else if (p95 > GATE.deliverP95Ms) failed.push(`deliver p95 ${ms(p95)} over ${GATE.deliverP95Ms} ms`);
  if (r.opFailures > 0) failed.push(`${r.opFailures} client ops failed or gave up`);
  if (slowest === null) failed.push("no client op ran");
  else if (slowest > GATE.opMaxMs) failed.push(`slowest op ${ms(slowest)} over ${GATE.opMaxMs} ms`);
  const measured = `gate: deliver p95 ${ms(p95)} (bound ${GATE.deliverP95Ms} ms), slowest op ${ms(slowest)} (bound ${GATE.opMaxMs} ms), `
    + `${r.delivered}/${r.hooks} hooks delivered at ${r.rate}/s`;
  return { pass: failed.length === 0, lines: [measured, failed.length ? `gate: FAIL (${failed.join("; ")})` : "gate: PASS"] };
}
