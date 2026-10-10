// When he comes back (ADR-0011, H4): his last activity on this device, kept in localStorage, his choice of how long
// away counts, and whether a night lies between two times on this device's calendar. The rule itself is the domain's
// isAway; this is the device's part.
import { parseAway, type AwaySetting } from "@morndo/domain";

export const LAST_ACTIVE_KEY = "morndo.lastActive";
export const AWAY_KEY = "morndo.awayAfter";
export const DIGEST_KEY = "morndo.digest";               // the digest he hasn't closed yet: { since, until }
export const WRITE_EVERY_MS = 30_000;                    // his input moves the stored time at most this often

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export const readLastActive = (s: Storage): number | null => safe(() => {
  const v = Number(s.getItem(LAST_ACTIVE_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}, null);
export const writeLastActive = (s: Storage, at: number) => safe(() => s.setItem(LAST_ACTIVE_KEY, String(at)), undefined);

// One writer for both layouts. While a return is undecided the old time must stay, so the absence is judged
// against it; otherwise his input moves the stored time at most every WRITE_EVERY_MS.
let wroteAt = 0;
let held = false;
export const holdActivity = (on: boolean) => { held = on; };
export function noteActivity(s: Storage, now: number, force = false): boolean {
  if (held) return false;
  if (!force && now - wroteAt < WRITE_EVERY_MS) return false;
  wroteAt = now;
  writeLastActive(s, now);
  return true;
}
export const readAway = (s: Storage): AwaySetting => safe(() => parseAway(s.getItem(AWAY_KEY)), parseAway(null));
export const writeAway = (s: Storage, v: AwaySetting) => safe(() => s.setItem(AWAY_KEY, v), undefined);

// A night between `from` and `to`: 4 in the morning, on this device's clock, falls inside.
export function nightBetween(from: number, to: number): boolean {
  const d = new Date(from);
  const four = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4).getTime();
  const next = four > from ? four : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 4).getTime();
  return next <= to;
}

export const AWAY_WORDS: Record<AwaySetting, string> = {
  "2h": "After 2 hours away", "4h": "After 4 hours away", "8h": "After 8 hours away", overnight: "Only after a night", never: "Never",
};
