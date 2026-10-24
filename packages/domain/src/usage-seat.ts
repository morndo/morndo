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
export function clearsMark(m: LimitMark, r: FreshRead): boolean {
  // Only the seat's own lease may clear its mark, and only a read stamped after the mark and its back-time.
  if (!r.leased) return false;
  if (!(r.capturedAt > m.markedAt && r.capturedAt > m.backAt)) return false;
  if (r.ordinaryUsageAllowed !== undefined)
    return r.ordinaryUsageAllowed === true && (r.rateLimitReachedType === null || r.rateLimitReachedType === undefined);
  const windows = m.windowId === null ? r.windows : r.windows.filter(w => w.id === m.windowId);
  for (const w of windows) {
    // A new cycle only: not full, a known length, past the marked cycle's reset, and begun at or after the mark.
    if (w.usedPercent === null || w.usedPercent >= 100) continue;
    if (w.resetsAt === null || w.lengthMins === null) continue;
    if (m.cycleReset !== null && w.resetsAt <= m.cycleReset) continue;
    if (w.resetsAt - w.lengthMins * 60_000 < m.markedAt) continue;
    return true;
  }
  return false;
}

// The worse of two seat states by the pool's order: logged-out, retired, out, low, ok.
const SEAT_ORDER: Record<SeatState, number> = { "logged-out": 0, retired: 1, out: 2, low: 3, ok: 4 };
export function worseSeatState(a: SeatState, b: SeatState): SeatState { return SEAT_ORDER[a] <= SEAT_ORDER[b] ? a : b; }

export function fixFor(state: SeatState, why: SeatWhy | null): UsageFix | null {
  if (state === "logged-out") return "sign_in_again";
  if (state === "retired") {
    if (why === "plan_ended") return "reactivate_the_seat";
    if (why === "billing") return "ask_the_org_admin";
    return "use_another_account";
  }
  if (state === "out") return "wait_for_reset";
  return null;
}
