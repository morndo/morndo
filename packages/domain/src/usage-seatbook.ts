// One seat state per account, whatever reported the limit (plan 4.5, U9): a limit hit from any source lands on the
// same record, the worse state always wins, and a fresh leased reading of a new cycle clears an "out" mark. The
// record says who derived it ("derived": the hub, from readings; "pool": the accounts pool set it by hand) and who
// reported the hit. A mark's back time is clamped between one minute and a week from the hit.
import type { SeatState } from "./pool.ts";
import type { FreshRead, SeatWhy } from "./usage-seat.ts";

export type LimitKind = "usage_limit" | "refused" | "signed_out" | "billing" | "unknown";
export type SeatRecord = { state: SeatState; why: SeatWhy | null; since: number; markedAt: number; backAt: number | null; cycleReset: number | null; windowId: string | null; owner: "derived" | "pool"; by: string };
export type LimitHit = { kind: LimitKind; at: number; backAt: number | null; by: string; cycle: { windowId: string; resetsAt: number | null } | null };
export const DEFAULT_MARK_MS = 60 * 60_000;
export const MIN_MARK_MS = 60_000;
export const MAX_MARK_MS = 168 * 3_600_000;

export function applyLimit(prev: SeatRecord | null, hit: LimitHit): { seat: SeatRecord | null; changed: boolean } {
  throw new Error("not implemented");
}

export function clearSeat(prev: SeatRecord, read: FreshRead): { seat: SeatRecord | null; cleared: boolean } {
  throw new Error("not implemented");
}
