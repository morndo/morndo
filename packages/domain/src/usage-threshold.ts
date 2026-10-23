// When a used percentage crosses a warning or critical line (U12): told once per crossing, after two readings at or
// above the line (one spike says nothing), and told again only after the level clears by USAGE_CLEAR_POINTS below it.
// A moved reset time is a new cycle: the runs and the told flags start over.
import { USAGE_CRITICAL, USAGE_WARNING } from "./usage.ts";

export type ThresholdLevel = "warning" | "critical";
export type ThresholdWatch = { resetsAt: number | null; run: { warning: number; critical: number }; told: { warning: boolean; critical: boolean } };
export const USAGE_CLEAR_POINTS = 5;      // how far below a line the usage must fall before that line may tell again
export const noThresholdWatch: ThresholdWatch = { resetsAt: null, run: { warning: 0, critical: 0 }, told: { warning: false, critical: false } };

// Two resets this far apart are different cycles.
const RESET_MOVED_MS = 60_000;

export function watchThreshold(w: ThresholdWatch, usedPercent: number | null, resetsAt: number | null): { watch: ThresholdWatch; told: ThresholdLevel | null } {
  if (usedPercent === null) return { watch: w, told: null };
  let run = { ...w.run }, told = { ...w.told }, resets = w.resetsAt;
  // A reset time that moved is a new cycle: the runs and the told flags start over, then this reading counts.
  if ((resetsAt === null) !== (resets === null) || (resetsAt !== null && resets !== null && Math.abs(resetsAt - resets) > RESET_MOVED_MS)) {
    run = { warning: 0, critical: 0 };
    told = { warning: false, critical: false };
    resets = resetsAt;
  }
  const levels: readonly [ThresholdLevel, number][] = [["warning", USAGE_WARNING], ["critical", USAGE_CRITICAL]];
  for (const [level, threshold] of levels) {
    run[level] = usedPercent >= threshold ? run[level] + 1 : 0;
    if (usedPercent < threshold - USAGE_CLEAR_POINTS) told[level] = false;
  }
  // The highest newly told level is the one told; one spike (a run of one) says nothing.
  let toldLevel: ThresholdLevel | null = null;
  if (run.critical >= 2 && !told.critical) { told.critical = true; toldLevel = "critical"; }
  if (run.warning >= 2 && !told.warning) { told.warning = true; if (toldLevel === null) toldLevel = "warning"; }
  return { watch: { resetsAt: resets, run, told }, told: toldLevel };
}
