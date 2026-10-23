// The plain words of a usage notice (plan 4.4): what the hub itself says about a plan, a seat, a return, a threshold
// or a forgotten source. Every word comes from here and the account's own name — nothing an agent token wrote is
// ever in a notice, and nothing in one is ever a link, an address or a command.
import type { SeatWhy } from "./usage-seat.ts";
import type { PlanChange } from "./usage-plan.ts";
import type { ThresholdLevel } from "./usage-threshold.ts";
import type { UsageFix, UsageSource } from "./usage-reading.ts";
import type { SeatRecord } from "./usage-seatbook.ts";

export type NoticeKind = "plan" | "seat" | "back" | "threshold" | "forgotten";
export type UsageNotice = { id: string; kind: NoticeKind; account: string; at: number; text: string };
export const NOTICE_KEEP = 50;

// The fix words (U9): one closed list, from fixFor; never free text.
export const FIX_WORDS: Record<UsageFix, string> = {
  sign_in_again: "sign in again",
  use_another_account: "use another account",
  wait_for_reset: "wait for the reset",
  ask_the_org_admin: "ask the org admin",
  reactivate_the_seat: "reactivate the seat",
  check_the_source: "check the source",
  sign_in_fully_here: "sign in fully on this machine",
};
export function fixWords(f: UsageFix): string {
  throw new Error("not implemented");
}

export function planNoticeText(account: string, c: PlanChange): string {
  throw new Error("not implemented");
}
export function seatNoticeText(account: string, s: SeatRecord): string {
  throw new Error("not implemented");
}
export function backNoticeText(account: string, by: string): string {
  throw new Error("not implemented");
}
export function thresholdNoticeText(account: string, windowTitle: string, level: ThresholdLevel): string {
  throw new Error("not implemented");
}
export function forgottenNoticeText(account: string, source: UsageSource | null): string {
  throw new Error("not implemented");
}
