// What the principal's view says about where usage numbers come from (plan 4.4): each source's health, the account's
// seat, and any two sources that disagree about one window. A view never carries an agent token's own words beyond
// SourceView.hint, which is cleaned before it is stored, and never a command or a link.
import type { SeatState } from "./pool.ts";
import type { SeatWhy } from "./usage-seat.ts";
import type { HealthState } from "./usage-health.ts";
import type { UsageFix, UsageReason, UsageSource } from "./usage-reading.ts";

export type SourceView = { source: UsageSource; node: string | null; state: HealthState; since: number | null; asOf: number | null; reason: UsageReason | null; fix: UsageFix | null; hint: string | null };
export type SeatView = { state: SeatState; why: SeatWhy | null; since: number; backAt: number | null; owner: "derived" | "pool"; by: string; fix: UsageFix | null };
export type DisagreeView = { window: string; a: { source: UsageSource; usedPercent: number; capturedAt: number }; b: { source: UsageSource; usedPercent: number; capturedAt: number } };
