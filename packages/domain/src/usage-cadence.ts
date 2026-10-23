// The hub's memory of one window's cycle (plan 4.1 item 3, U7): each reset time it has seen, when it saw it, and the
// gap between two resets once a new cycle began. A reset that slid later while the old cycle was still ahead is a
// rolling window, not a new cycle, and never yields a gap; an out-of-order reading says nothing.
export type CycleBook = { cycleResetsAt: number | null; furthestMs: number | null; gapMs: number | null };
export const noCycleBook: CycleBook = { cycleResetsAt: null, furthestMs: null, gapMs: null };

// Two resets less than this apart are the same cycle's reset, seen twice.
const SAME_CYCLE_MS = 60_000;

export function observeCycle(b: CycleBook, resetsAt: number | null, now: number): CycleBook {
  throw new Error("not implemented");
}

export function cadenceInput(b: CycleBook): { observedGapMs: number | null; furthestResetMs: number | null } {
  throw new Error("not implemented");
}
