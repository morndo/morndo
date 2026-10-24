// A usage reading (U14): which source it came from, when it was taken, and the limit windows it names. A reason a
// read fails is one closed list, split into transient ones (worth retrying) and permanent ones (not); a fix is one
// closed list of words too, never free text; a hint is free text, cleaned of links and addresses before it is shown.
export const USAGE_SOURCES = ["status-line", "claude-usage", "app-server", "cli-screen", "vendor-api"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];
export const TRANSIENT_REASONS = ["rate_limited", "unreachable", "timeout"] as const;
export const PERMANENT_REASONS = ["unknown_screen", "signed_out", "refused", "no_usage_for_plan", "plan_ended", "no_scope"] as const;
export const USAGE_REASONS = [...PERMANENT_REASONS, ...TRANSIENT_REASONS] as const;
export type UsageReason = (typeof USAGE_REASONS)[number];
export const USAGE_FIXES = ["sign_in_again", "use_another_account", "wait_for_reset", "ask_the_org_admin", "reactivate_the_seat", "check_the_source", "sign_in_fully_here"] as const;
export type UsageFix = (typeof USAGE_FIXES)[number];
export const HINT_LIMIT = 120;
export const EVERY_MIN_S = 60;
export const EVERY_MAX_S = 21_600;
// resetsAt in ms; a window's note is what the provider said about it, e.g. "shared with a second product".
export type WindowReading = { id: string; usedPercent: number | null; resetsAt: number | null; lengthMins: number | null; rolling: boolean; note: string | null };
export type UsageReading = { source: UsageSource; node: string | null; capturedAt: number; plan: string | null; everyS: number | null; windows: readonly WindowReading[] };
export type ReadingFailure = { source: UsageSource; node: string | null; capturedAt: number; reason: UsageReason; hint: string | null; everyS: number | null };

// A transient reason is worth retrying; a permanent one is not fixed by waiting.
export const isTransientReason = (r: UsageReason): boolean => (TRANSIENT_REASONS as readonly string[]).includes(r);
// U14: a used percentage that is not a finite number in 0..101 is not a reading of that window: dropped, never clamped.
export function takePercent(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < 0 || v > 101) return null;
  return v > 100 ? 100 : v;
}
// The wire carries free strings; only the closed list counts, anything else reads as an unreadable screen.
export function reasonOf(v: unknown): UsageReason {
  return typeof v === "string" && (USAGE_REASONS as readonly string[]).includes(v) ? (v as UsageReason) : "unknown_screen";
}
const listed = <T extends string>(list: readonly T[], v: unknown): T | null =>
  (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
// Free text, minus control characters, links, addresses and extra whitespace; empty is nothing to say.
const cleanText = (v: unknown, limit: number): string | null => {
  if (typeof v !== "string") return null;
  let plain = "";
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 32 && c !== 127) plain += v.charAt(i);
  }
  // A token that is a link or holds an address is gone whole, not masked.
  const kept = plain.split(/\s+/).filter(t => t !== "" && !t.includes("://") && !t.startsWith("www.") && !t.includes("@"));
  const t = kept.join(" ").slice(0, limit).trim();
  return t === "" ? null : t;
};
export const cleanHint = (v: unknown): string | null => cleanText(v, HINT_LIMIT);
// A fix shown to the principal comes from the closed list; free text is no fix at all.
export const fixOf = (v: unknown): UsageFix | null => listed(USAGE_FIXES, v);
// How often a source may be read, kept between one minute and six hours.
export function clampEvery(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.round(Math.min(EVERY_MAX_S, Math.max(EVERY_MIN_S, v)));
}
// A window note: the same cleaning as a hint, but shorter.
export const cleanNote = (v: unknown): string | null => cleanText(v, 40);
// A window length is a finite positive whole number of minutes, else unknown.
export function cleanLength(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || !Number.isInteger(v)) return null;
  return v;
}
// The fix a failed source's reason names (plan 4.4): one closed list, never free text; a reason with no fix of its
// own (a meter that will come back, a hub that could not reach it) shows none.
export function fixForReason(r: UsageReason): UsageFix | null {
  if (r === "signed_out") return "sign_in_again";
  if (r === "refused") return "use_another_account";
  if (r === "no_scope") return "sign_in_fully_here";
  if (r === "unknown_screen") return "check_the_source";
  if (r === "plan_ended") return "reactivate_the_seat";
  return null;
}
