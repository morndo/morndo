// The plain words of a usage notice (plan 4.4): what the hub itself says about a plan, a seat, a return, a threshold
// or a forgotten source. Every word comes from here and the account's own name — nothing an agent token wrote is
// ever in a notice, and nothing in one is ever a link, an address or a command.
import { fixFor } from "./usage-seat.ts";
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
  return FIX_WORDS[f];
}

export function planNoticeText(account: string, c: PlanChange): string {
  if (c.kind === "name") return `${account}: plan changed from "${c.from}" to "${c.to}".`;
  if (c.kind === "account") return `${account}: the account behind it changed. Readings start fresh.`;
  if (c.kind === "cadence") return `${account}: the ${c.window} window changed from ${c.from} to ${c.to} minutes.`;
  if (c.kind === "windows") return `${account}: the set of windows changed from ${c.from} to ${c.to}.`;
  return `${account}: the ${c.window} window fell from ${c.from}% to ${c.to}% with its reset unchanged.`;
}

export function seatNoticeText(account: string, s: SeatRecord): string {
  if (s.state === "out") {
    const back = s.backAt === null ? "an unknown time" : new Date(s.backAt).toISOString();
    return `${account}: usage limit reached. Back at ${back}. Fix: wait for the reset.`;
  }
  if (s.state === "retired" && s.why === "refused") return `${account}: sign-in was refused. Fix: use another account.`;
  if (s.state === "retired" && s.why === "plan_ended") return `${account}: the plan has ended. Fix: reactivate the seat.`;
  if (s.state === "retired" && s.why === "billing") return `${account}: billing problem. Fix: ask the org admin.`;
  if (s.state === "logged-out") return `${account}: signed out. Fix: sign in again.`;
  const fix = fixFor(s.state, s.why);
  return fix === null ? `${account}: the seat is ${s.state}.` : `${account}: the seat is ${s.state}. Fix: ${fixWords(fix)}.`;
}

export function backNoticeText(account: string, by: string): string {
  return `${account}: back in use (${by} shows a new cycle).`;
}

// A derived seat dropped because the plan or the account behind it changed (fix round on PR #125, finding 3a).
// Not implemented yet: this round only writes the red tests.
export function seatResetNoticeText(account: string): string {
  throw new Error("not implemented");
}

export function thresholdNoticeText(account: string, windowTitle: string, level: ThresholdLevel): string {
  return `${account}: the ${windowTitle} window passed ${level === "critical" ? 90 : 75}%.`;
}

export function forgottenNoticeText(account: string, source: UsageSource | null): string {
  return `${account}: no reading for 14 days${source === null ? "" : ` from ${source}`}, so it is forgotten.`;
}
