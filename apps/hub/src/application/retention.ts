// Retention (ADR-0008, A8): what the hub stops keeping once it can no longer matter. Pairing tokens expired or redeemed
// more than 30 days ago, and sessions ended more than 90 days ago (or never ended but unseen for 90 days: past the
// longest sign-in any policy allows, 30 days, so over for good). The audit log and the decisions are provenance (A1,
// E8) and are never pruned. Since phase C also send records older than 24 hours (S5), and since phase E Link requests
// a day past their life (their trail is in the audit). Runs on start, then daily.
import type { Store } from "../adapters/store.ts";

const DAY = 24 * 3_600_000;
export const RETENTION = { tokensMs: 30 * DAY, sessionsMs: 90 * DAY, linksMs: DAY, everyMs: DAY } as const;

export type Pruned = { tokens: number; sessions: number; sends: number; links: number };

export function pruneOnce(store: Pick<Store, "pruneTokens" | "pruneSessions" | "pruneSends" | "pruneLinks">, now: number): Pruned {
  return {
    tokens: store.pruneTokens(now - RETENTION.tokensMs),
    sessions: store.pruneSessions(now - RETENTION.sessionsMs),
    sends: store.pruneSends(now),                                     // S5: a request id's record lives 24 hours
    links: store.pruneLinks(now - RETENTION.linksMs),
  };
}

// Prunes now and every day after; returns the stop function. `done` hears each run's counts (for the log); a run that
// fails (a locked database, say) is reported to `failed` and tried again the next day, never thrown (review L1).
export function startRetention(
  store: Pick<Store, "pruneTokens" | "pruneSessions" | "pruneSends" | "pruneLinks">, now: () => number = Date.now,
  done: (r: Pruned) => void = () => {}, failed: (e: unknown) => void = () => {},
): () => void {
  const run = () => {
    try { done(pruneOnce(store, now())); }
    catch (e) { failed(e); }
  };
  run();
  const timer = setInterval(run, RETENTION.everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
