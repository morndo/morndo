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
export const isTransientReason = (r: UsageReason): boolean => { throw new Error("not implemented"); };
// U14: a used percentage that is not a finite number in 0..101 is not a reading of that window: dropped, never clamped.
export function takePercent(v: unknown): number | null { throw new Error("not implemented"); }
// The wire carries free strings; only the closed list counts, anything else reads as an unreadable screen.
export function reasonOf(v: unknown): UsageReason { throw new Error("not implemented"); }
// Free text, minus control characters, links, addresses and extra whitespace; empty is nothing to say.
export function cleanHint(v: unknown): string | null { throw new Error("not implemented"); }
// A fix shown to the principal comes from the closed list; free text is no fix at all.
export function fixOf(v: unknown): UsageFix | null { throw new Error("not implemented"); }
// How often a source may be read, kept between one minute and six hours.
export function clampEvery(v: unknown): number | null { throw new Error("not implemented"); }
// A window note: the same cleaning as a hint, but shorter.
export function cleanNote(v: unknown): string | null { throw new Error("not implemented"); }
// A window length is a finite positive whole number of minutes, else unknown.
export function cleanLength(v: unknown): number | null { throw new Error("not implemented"); }
