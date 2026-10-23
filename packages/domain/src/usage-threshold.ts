// When a used percentage crosses a warning or critical line (U12): told once per crossing, after two readings at or
// above the line (one spike says nothing), and told again only after the level clears by USAGE_CLEAR_POINTS below it.
// A moved reset time is a new cycle: the runs and the told flags start over.
export type ThresholdLevel = "warning" | "critical";
export type ThresholdWatch = { resetsAt: number | null; run: { warning: number; critical: number }; told: { warning: boolean; critical: boolean } };
export const USAGE_CLEAR_POINTS = 5;      // how far below a line the usage must fall before that line may tell again
export const noThresholdWatch: ThresholdWatch = { resetsAt: null, run: { warning: 0, critical: 0 }, told: { warning: false, critical: false } };
export function watchThreshold(w: ThresholdWatch, usedPercent: number | null, resetsAt: number | null): { watch: ThresholdWatch; told: ThresholdLevel | null } { throw new Error("not implemented"); }
