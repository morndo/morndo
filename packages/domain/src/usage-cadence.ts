// The hub's memory of one window's cycle (plan 4.1 item 3, U7): each reset time it has seen, when it saw it, and the
// gap between two resets once a new cycle began. A reset that slid later while the old cycle was still ahead is a
// rolling window, not a new cycle, and never yields a gap; an out-of-order reading says nothing.
export type CycleBook = { cycleResetsAt: number | null; furthestMs: number | null; gapMs: number | null };
export const noCycleBook: CycleBook = { cycleResetsAt: null, furthestMs: null, gapMs: null };

// Two resets less than this apart are the same cycle's reset, seen twice.
const SAME_CYCLE_MS = 60_000;

export function observeCycle(b: CycleBook, resetsAt: number | null, now: number): CycleBook {
  // No reset in the reading says nothing; the first one ever starts the book.
  if (resetsAt === null) return b;
  if (b.cycleResetsAt === null) return { cycleResetsAt: resetsAt, furthestMs: resetsAt - now, gapMs: null };
  // The same cycle's reset, seen again (or a few seconds off): only the horizon can widen.
  if (Math.abs(resetsAt - b.cycleResetsAt) <= SAME_CYCLE_MS)
    return { ...b, furthestMs: Math.max(b.furthestMs ?? resetsAt - now, resetsAt - now) };
  // An earlier reset by more than that is an out-of-order reading: ignored.
  if (resetsAt < b.cycleResetsAt) return b;
  if (b.cycleResetsAt <= now)
    // The old cycle had ended: this is the next one, and the gap between the two resets is the cycle's length.
    return { cycleResetsAt: resetsAt, furthestMs: resetsAt - now, gapMs: resetsAt - b.cycleResetsAt };
  // The reset slid later while the old cycle was still ahead: a rolling window, never a gap.
  return { ...b, cycleResetsAt: resetsAt, furthestMs: Math.max(b.furthestMs ?? resetsAt - now, resetsAt - now) };
}

export function cadenceInput(b: CycleBook): { observedGapMs: number | null; furthestResetMs: number | null } {
  return { observedGapMs: b.gapMs, furthestResetMs: b.furthestMs };
}
