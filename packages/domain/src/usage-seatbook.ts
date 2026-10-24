// One seat state per account, whatever reported the limit (plan 4.5, U9): a limit hit from any source lands on the
// same record, the worse state always wins, and a fresh leased reading of a new cycle clears an "out" mark. The
// record says who derived it ("derived": the hub, from readings; "pool": the accounts pool set it by hand) and who
// reported the hit. A mark's back time is clamped between one minute and a week from the hit.
import type { SeatState } from "./pool.ts";
import { clearsMark, worseSeatState, type FreshRead, type SeatWhy } from "./usage-seat.ts";

export type LimitKind = "usage_limit" | "refused" | "signed_out" | "billing" | "unknown";
export type SeatRecord = { state: SeatState; why: SeatWhy | null; since: number; markedAt: number; backAt: number | null; cycleReset: number | null; windowId: string | null; owner: "derived" | "pool"; by: string };
export type LimitHit = { kind: LimitKind; at: number; backAt: number | null; by: string; cycle: { windowId: string; resetsAt: number | null } | null };
export const DEFAULT_MARK_MS = 60 * 60_000;
export const MIN_MARK_MS = 60_000;
export const MAX_MARK_MS = 168 * 3_600_000;

export function applyLimit(prev: SeatRecord | null, hit: LimitHit): { seat: SeatRecord | null; changed: boolean } {
  if (hit.kind === "unknown") return { seat: prev, changed: false };
  let next: SeatRecord;
  if (hit.kind === "usage_limit") {
    // The back time the reporter named, clamped to between a minute and a week from the hit; an unnamed one is an hour.
    const backAt = Math.min(Math.max(hit.backAt ?? hit.at + DEFAULT_MARK_MS, hit.at + MIN_MARK_MS), hit.at + MAX_MARK_MS);
    next = { state: "out", why: "usage_limit", since: hit.at, markedAt: hit.at, backAt, cycleReset: hit.cycle?.resetsAt ?? null, windowId: hit.cycle?.windowId ?? null, owner: "derived", by: hit.by };
  } else if (hit.kind === "refused") {
    next = { state: "retired", why: "refused", since: hit.at, markedAt: hit.at, backAt: null, cycleReset: null, windowId: null, owner: "derived", by: hit.by };
  } else if (hit.kind === "signed_out") {
    next = { state: "logged-out", why: "signed_out", since: hit.at, markedAt: hit.at, backAt: null, cycleReset: null, windowId: null, owner: "derived", by: hit.by };
  } else {
    next = { state: "retired", why: "billing", since: hit.at, markedAt: hit.at, backAt: null, cycleReset: null, windowId: null, owner: "derived", by: hit.by };
  }
  if (prev !== null) {
    // The worse state always wins, whatever reported the new hit.
    if (worseSeatState(prev.state, next.state) === prev.state && prev.state !== next.state) return { seat: prev, changed: false };
    if (prev.state === next.state && prev.why === next.why) {
      // The same state again only extends the back time; null stays null only if both are null.
      const backAt = prev.backAt !== null && next.backAt !== null ? Math.max(prev.backAt, next.backAt) : prev.backAt ?? next.backAt;
      return { seat: { ...prev, backAt }, changed: false };
    }
  }
  return { seat: next, changed: true };
}

// The pool-owned seat (U15, U17): what the accounts pool set by hand. The pool's own record, never a reading's to end.
export function poolSeat(hit: { state: SeatState; why: SeatWhy | null; backAt: number | null; at: number; by: string }): SeatRecord {
  // Round 2: owner "pool", markedAt and since the hit's own time, no cycle and no window, the back time as given.
  void hit;
  throw new Error("not implemented");
}

// The seat the principal is shown (U17): the worse of the pool's and the hub's derived one by worseSeatState; on an
// equal state, the pool's. Either null: the other; both null: null.
export function shownSeat(pool: SeatRecord | null, derived: SeatRecord | null): SeatRecord | null {
  // Round 2: worseSeatState decides, a tie goes to the pool.
  void pool; void derived;
  throw new Error("not implemented");
}

export function clearSeat(prev: SeatRecord, read: FreshRead): { seat: SeatRecord | null; cleared: boolean } {
  // A seat the pool set by hand is the pool's to end, never a reading's.
  if (prev.owner === "pool") return { seat: prev, cleared: false };
  if (prev.state === "out") {
    const cleared = clearsMark({ markedAt: prev.markedAt, backAt: prev.backAt ?? prev.markedAt, cycleReset: prev.cycleReset, windowId: prev.windowId }, read);
    return cleared ? { seat: null, cleared: true } : { seat: prev, cleared: false };
  }
  if (prev.state === "logged-out" || (prev.state === "retired" && (prev.why === "refused" || prev.why === "plan_ended"))) {
    // A sign-in that works again, seen by a leased read taken after the seat went: the account is back.
    const cleared = read.leased && read.capturedAt > prev.since && read.windows.some(w => w.usedPercent !== null);
    return cleared ? { seat: null, cleared: true } : { seat: prev, cleared: false };
  }
  return { seat: prev, cleared: false };
}
