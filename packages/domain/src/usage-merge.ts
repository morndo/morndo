// Two sources can read one window (plan 4.3 item 5): the newer reading by capture time wins, and when two recent
// readings from different sources disagree by enough, both are shown. A "last-known" reading (the same numbers the
// source already read) loses to a status line that spoke after that source's previous read, so a silent echo never
// hides the live line — but a line silent ever since that read hides nothing (PR #125, finding 1).
import type { UsageSource } from "./usage-reading.ts";

export type Candidate = { source: UsageSource; node: string | null; capturedAt: number; usedPercent: number; resetsAt: number | null; sameAsPrevious: boolean; previousCapturedAt?: number | null };
export type Merged = { shown: Candidate | null; disagree: { a: Candidate; b: Candidate } | null };
export const DISAGREE_POINTS = 15;
export const DISAGREE_WITHIN_MS = 10 * 60_000;

// The capture time each candidate counts by: a "last-known" echo of a non-status-line source is as old as nothing,
// but only while a status line spoke after the source's previous read of the window — with no line at all, or none
// that fresh, the echo is all there is and keeps its own time. A previous read unknown (null or absent) keeps the
// older rule: any line at all outranks it.
const effectiveTimes = (cands: readonly Candidate[]): number[] => {
  const line = cands.filter(c => c.source === "status-line").map(c => c.capturedAt);
  return cands.map(c => {
    if (!c.sameAsPrevious || c.source === "status-line" || line.length === 0) return c.capturedAt;
    const prevAt = c.previousCapturedAt;
    if (prevAt == null) return 0;
    return line.some(t => t > prevAt) ? 0 : c.capturedAt;
  });
};

// Newest first; a tie goes to the status line, then to the later candidate in the list.
export function mergeWindow(cands: readonly Candidate[]): Merged {
  if (cands.length === 0) return { shown: null, disagree: null };
  const eff = effectiveTimes(cands);
  const order = cands.map((c, i) => ({ c, i, e: eff[i]! })).sort((x, y) => {
    if (x.e !== y.e) return y.e - x.e;
    const sx = x.c.source === "status-line" ? 1 : 0, sy = y.c.source === "status-line" ? 1 : 0;
    if (sx !== sy) return sy - sx;
    return y.i - x.i;
  });
  const first = order[0]!;
  // The two candidates from different sources with the two largest effective capture times: shown, and the best of
  // the rest from another source. Both must have spoken within ten minutes of each other and differ by the line.
  const other = order.slice(1).find(o => o.c.source !== first.c.source) ?? null;
  if (other !== null &&
    Math.abs(first.e - other.e) <= DISAGREE_WITHIN_MS &&
    Math.abs(first.c.usedPercent - other.c.usedPercent) >= DISAGREE_POINTS)
    return { shown: first.c, disagree: { a: first.c, b: other.c } };
  return { shown: first.c, disagree: null };
}
