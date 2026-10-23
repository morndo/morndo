// The health of a usage source (U6, U11, plan 4.3): when it last answered, when it began failing and why, and how
// often it may be read. A transient failure keeps the source merely stale for an hour before it is called
// unavailable; a source that declared how often it may be read and then went quiet is unavailable once its silence
// outruns that; anything silent for two weeks is forgotten entirely.
import type { UsageReason, UsageSource } from "./usage-reading.ts";

// The state of a source's health. The plan's word for this was SourceState, but the escalation context already owns
// that name in this package, so this one keeps its own.
export type HealthState = "available" | "stale" | "unavailable" | "missing";
export type SourceHealth = { source: UsageSource; lastOkAt: number | null; lastFailAt: number | null; failingSince: number | null; reason: UsageReason | null; everyS: number | null };
export const STATUS_STALE_MS = 10 * 60_000;          // the status line is always at least this fresh
export const DEFAULT_STALE_MS = 15 * 60_000;         // a source that declares nothing
export const TRANSIENT_GRACE_MS = 60 * 60_000;       // how long a transient failure stays merely stale
export const SILENCE_FLOOR_MS = 30 * 60_000;         // silence shorter than this never makes a source unavailable
export const FORGET_MS = 14 * 86_400_000;            // two weeks without a word, and the source is forgotten

export const noHealth = (source: UsageSource): SourceHealth => { throw new Error("not implemented"); };
export function okRead(h: SourceHealth, capturedAt: number, everyS: unknown): SourceHealth { throw new Error("not implemented"); }
export function failedRead(h: SourceHealth, capturedAt: number, reason: UsageReason, everyS: unknown): SourceHealth { throw new Error("not implemented"); }
export function staleLineMs(h: SourceHealth): number { throw new Error("not implemented"); }
export function sourceState(h: SourceHealth, now: number): HealthState { throw new Error("not implemented"); }
export function unavailableSince(h: SourceHealth, now: number): number | null { throw new Error("not implemented"); }
export function shouldForget(h: SourceHealth, now: number): boolean { throw new Error("not implemented"); }
