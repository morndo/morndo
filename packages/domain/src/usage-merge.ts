// Two sources can read one window (plan 4.3 item 5): the newer reading by capture time wins, and when two recent
// readings from different sources disagree by enough, both are shown. A "last-known" reading (the same numbers the
// source already read) loses to any status line that spoke after it, so a silent echo never hides the live line.
import type { UsageSource } from "./usage-reading.ts";

export type Candidate = { source: UsageSource; node: string | null; capturedAt: number; usedPercent: number; resetsAt: number | null; sameAsPrevious: boolean; previousCapturedAt?: number | null };
export type Merged = { shown: Candidate | null; disagree: { a: Candidate; b: Candidate } | null };
export const DISAGREE_POINTS = 15;
export const DISAGREE_WITHIN_MS = 10 * 60_000;

// The capture time a candidate counts by: a "last-known" echo of a non-status-line source is as old as nothing,
// but only while a status line spoke at all — with none, the echo is all there is and keeps its own time.
const effective = (c: Candidate, anyStatusLine: boolean): number =>
  c.sameAsPrevious && c.source !== "status-line" && anyStatusLine ? 0 : c.capturedAt;

// Newest first; a tie goes to the status line, then to the later candidate in the list.
const ranksFirst = (a: Candidate, ai: number, b: Candidate, bi: number, anyStatusLine: boolean): boolean => {
  const ea = effective(a, anyStatusLine), eb = effective(b, anyStatusLine);
  if (ea !== eb) return ea > eb;
  const sa = a.source === "status-line", sb = b.source === "status-line";
  if (sa !== sb) return sa;
  return ai > bi;
};

export function mergeWindow(cands: readonly Candidate[]): Merged {
  if (cands.length === 0) return { shown: null, disagree: null };
  const anyStatusLine = cands.some(c => c.source === "status-line");
  const order = cands.map((c, i) => ({ c, i })).sort((x, y) => (ranksFirst(x.c, x.i, y.c, y.i, anyStatusLine) ? -1 : ranksFirst(y.c, y.i, x.c, x.i, anyStatusLine) ? 1 : 0));
  const shown = order[0]!.c;
  // The two candidates from different sources with the two largest effective capture times: shown, and the best of
  // the rest from another source. Both must have spoken within ten minutes of each other and differ by the line.
  const other = order.slice(1).find(o => o.c.source !== shown.source)?.c ?? null;
  if (other !== null &&
    Math.abs(effective(shown, anyStatusLine) - effective(other, anyStatusLine)) <= DISAGREE_WITHIN_MS &&
    Math.abs(shown.usedPercent - other.usedPercent) >= DISAGREE_POINTS)
    return { shown, disagree: { a: shown, b: other } };
  return { shown, disagree: null };
}
