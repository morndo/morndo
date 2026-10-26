// The health of a usage source (U6, U11, plan 4.3): when it last answered, when it began failing and why, and how
// often it may be read. A transient failure keeps the source merely stale for an hour before it is called
// unavailable; a source that declared how often it may be read and then went quiet is unavailable once its silence
// outruns that; anything silent for two weeks is forgotten entirely.
import { clampEvery, isTransientReason, type UsageReason, type UsageSource } from "./usage-reading.ts";

// The state of a source's health. The plan's word for this was SourceState, but the escalation context already owns
// that name in this package, so this one keeps its own.
export type HealthState = "available" | "stale" | "unavailable" | "missing";
export type SourceHealth = { source: UsageSource; lastOkAt: number | null; lastFailAt: number | null; failingSince: number | null; reason: UsageReason | null; everyS: number | null };
export const STATUS_STALE_MS = 10 * 60_000;          // the status line is always at least this fresh
export const DEFAULT_STALE_MS = 15 * 60_000;         // a source that declares nothing
export const TRANSIENT_GRACE_MS = 60 * 60_000;       // how long a transient failure stays merely stale
export const SILENCE_FLOOR_MS = 30 * 60_000;         // silence shorter than this never makes a source unavailable
export const FORGET_MS = 14 * 86_400_000;            // two weeks without a word, and the source is forgotten

export const noHealth = (source: UsageSource): SourceHealth => ({ source, lastOkAt: null, lastFailAt: null, failingSince: null, reason: null, everyS: null });

// A good read clears the failure; the declared cadence is kept clamped.
export function okRead(h: SourceHealth, capturedAt: number, everyS: unknown): SourceHealth {
  return { source: h.source, lastOkAt: capturedAt, lastFailAt: null, failingSince: null, reason: null, everyS: clampEvery(everyS) };
}
// A failed read notes when and why; failingSince only begins here, it does not move. A failure that declares nothing keeps the cadence already declared.
export function failedRead(h: SourceHealth, capturedAt: number, reason: UsageReason, everyS: unknown): SourceHealth {
  return { ...h, lastFailAt: capturedAt, reason, failingSince: h.failingSince ?? capturedAt, everyS: clampEvery(everyS) ?? h.everyS };
}

export function staleLineMs(h: SourceHealth): number {
  if (h.source === "status-line") return STATUS_STALE_MS;
  return h.everyS !== null ? Math.max(DEFAULT_STALE_MS, 2 * h.everyS * 1000) : DEFAULT_STALE_MS;
}

export function sourceState(h: SourceHealth, now: number): HealthState {
  if (h.lastOkAt === null && h.lastFailAt === null) return "missing";
  if (h.failingSince !== null) {
    if (h.reason === null || !isTransientReason(h.reason) || h.lastOkAt === null) return "unavailable";
    // A transient failure is merely stale for its grace hour, then unavailable.
    return now - h.failingSince <= TRANSIENT_GRACE_MS ? "stale" : "unavailable";
  }
  const lastWord = Math.max(h.lastOkAt ?? 0, h.lastFailAt ?? 0);
  // A source that said how often it speaks and then fell that quiet is unavailable; the status line never is.
  if (h.source !== "status-line" && h.everyS !== null && now - lastWord > Math.max(4 * h.everyS * 1000, SILENCE_FLOOR_MS)) return "unavailable";
  return now - (h.lastOkAt ?? 0) > staleLineMs(h) ? "stale" : "available";
}

export function unavailableSince(h: SourceHealth, now: number): number | null {
  if (sourceState(h, now) !== "unavailable") return null;
  if (h.failingSince !== null) {
    // A transient failure of a source that once read well turns unavailable only after its grace hour.
    if (h.reason !== null && isTransientReason(h.reason) && h.lastOkAt !== null) return h.failingSince + TRANSIENT_GRACE_MS;
    return h.failingSince;
  }
  return Math.max(h.lastOkAt ?? 0, h.lastFailAt ?? 0) + Math.max(4 * (h.everyS ?? 0) * 1000, SILENCE_FLOOR_MS);
}

export function shouldForget(h: SourceHealth, now: number): boolean {
  if (h.lastOkAt === null && h.lastFailAt === null) return false;
  if (now - Math.max(h.lastOkAt ?? 0, h.lastFailAt ?? 0) >= FORGET_MS) return true;
  const since = unavailableSince(h, now);
  return since !== null && now - since >= FORGET_MS;
}
