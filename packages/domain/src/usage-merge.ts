// Two sources can read one window (plan 4.3 item 5): the newer reading by capture time wins, and when two recent
// readings from different sources disagree by enough, both are shown. A "last-known" reading (the same numbers the
// source already read) loses to any status line that spoke after it, so a silent echo never hides the live line.
import type { UsageSource } from "./usage-reading.ts";

export type Candidate = { source: UsageSource; node: string | null; capturedAt: number; usedPercent: number; resetsAt: number | null; sameAsPrevious: boolean };
export type Merged = { shown: Candidate | null; disagree: { a: Candidate; b: Candidate } | null };
export const DISAGREE_POINTS = 15;
export const DISAGREE_WITHIN_MS = 10 * 60_000;

export function mergeWindow(cands: readonly Candidate[]): Merged {
  throw new Error("not implemented");
}
