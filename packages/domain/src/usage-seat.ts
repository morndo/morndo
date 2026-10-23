// When a seat is marked out of usage and when that mark clears (U9 words, U13, plan 4.5): a fresh reading clears a
// mark only from a lease of that seat, only stamped after the mark and its back-time, and only if the window it read
// is a new cycle that began after the mark — an old cycle's numbers never clear it, whatever they say. The words for
// why a seat is out are closed, and each has its fix from the closed list.
import type { SeatState } from "./pool.ts";
import type { UsageFix } from "./usage-reading.ts";

export type SeatWhy = "usage_limit" | "refused" | "signed_out" | "plan_ended" | "billing" | "by_hand";
export type LimitMark = { markedAt: number; backAt: number; cycleReset: number | null; windowId: string | null };   // ms; cycleReset: the limited window's reset time before the hit
export type FreshWindow = { id: string; usedPercent: number | null; resetsAt: number | null; lengthMins: number | null };
export type FreshRead = { capturedAt: number; leased: boolean; windows: readonly FreshWindow[]; ordinaryUsageAllowed?: boolean | null; rateLimitReachedType?: string | null };
export function clearsMark(m: LimitMark, r: FreshRead): boolean { throw new Error("not implemented"); }
// The worse of two seat states by the pool's order: logged-out, retired, out, low, ok.
export function worseSeatState(a: SeatState, b: SeatState): SeatState { throw new Error("not implemented"); }
export function fixFor(state: SeatState, why: SeatWhy | null): UsageFix | null { throw new Error("not implemented"); }
