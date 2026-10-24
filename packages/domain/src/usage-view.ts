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

// The words Home says of a source's health and a failed read's reason (plan 4.4): one closed list each, plain words,
// never colour alone. The one Fix wording is fixWords (usage-notice.ts), re-exported so the view reads one place.
export { fixWords } from "./usage-notice.ts";
export const REASON_WORDS: Record<UsageReason, string> = {
  unknown_screen: "its screen was not in a shape Morndo knows",
  signed_out: "it is signed out",
  refused: "its organization refused it",
  no_usage_for_plan: "this plan has no usage to read",
  plan_ended: "the plan has ended",
  no_scope: "this sign-in cannot read usage",
  rate_limited: "the provider is limiting reads",
  unreachable: "the provider could not be reached",
  timeout: "the read took too long",
};
export const STATE_WORDS: Record<HealthState, string> = {
  available: "reading now",
  stale: "last read a while ago",
  unavailable: "can't read",
  missing: "no reading yet",
};
