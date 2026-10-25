// How usage is shown on Home (ADR-0016): the words for a window and its reset, the meter's level, and the decoding of
// the `usage` feed frame. The rules (which level, which account is tightest) are the domain's. S4 (plan 4.4): the
// account's health from its sources, the lines a source and a seat say with it, and the notices of the frame.
import { ORG_WORDS, REASON_WORDS, STATE_WORDS, accountLabel, fixFor, fixWords, onDemandLine, resetsOnLabel, shownLevel, tightestShown, usageLevel, type AccountUsage, type DisagreeView, type HealthState, type SeatView, type SourceView, type UsageLevel, type UsageNotice, type UsageWindow } from "@morndo/domain";
import { AccountUsageSchema, UsageNoticeSchema, parseBody } from "@morndo/protocol";

export type { AccountUsage, UsageLevel, UsageWindow, UsageNotice, SourceView, SeatView, HealthState, DisagreeView };
export { accountLabel, fixFor, fixWords, onDemandLine, ORG_WORDS, REASON_WORDS, resetsOnLabel, shownLevel, STATE_WORDS, tightestShown, usageLevel };

export function decodeAccounts(raw: unknown[]): { accounts: AccountUsage[]; dropped: number } {
  const accounts: AccountUsage[] = [];
  let dropped = 0;
  for (const x of raw) {
    const a = parseBody(AccountUsageSchema, x);
    if (a) accounts.push(a);
    else dropped++;
  }
  return { accounts, dropped };
}

// What Home shows of an account's sources (plan 4.4): the best state among them, when it began failing, how fresh the
// numbers are. "unknown": an older hub, or an account no source speaks of.
export type AccountHealth = { state: HealthState | "unknown"; since: number | null; asOf: number | null; sources: readonly SourceView[] };

export function accountHealth(a: AccountUsage, now: number): AccountHealth {
  void now;                                                             // the states are the hub's, already judged against its clock
  const sources = a.sources ?? [];
  if (sources.length === 0) return { state: "unknown", since: null, asOf: null, sources: [] };
  const rank: Record<HealthState, number> = { available: 0, stale: 1, unavailable: 2, missing: 3 };
  let best: HealthState = "missing";
  for (const s of sources) if (rank[s.state] < rank[best]) best = s.state;
  // Since when it cannot read: the earliest any unavailable source began, and only when that is the account's state.
  const since = best === "unavailable"
    ? sources.filter(s => s.state === "unavailable").map(s => s.since).filter((t): t is number => t !== null)
        .reduce<number | null>((earliest, t) => earliest === null || t < earliest ? t : earliest, null)
    : null;
  const asOf = sources.map(s => s.asOf).filter((t): t is number => t !== null).reduce<number | null>((newest, t) => newest === null || t > newest ? t : newest, null);
  return { state: best, since, asOf, sources };
}

// "14:05" in the viewer's own clock (24 h, hour and minute).
export function clockOf(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

// One source's line under the meters, in the hub's closed words only: "app-server: can't read since 14:05, its
// screen was not in a shape Morndo knows".
export function sourceLine(s: SourceView, now: number): string {
  void now;
  if (s.state === "unavailable") {
    const when = s.since === null ? "" : ` since ${clockOf(s.since)}`;
    return `${s.source}: can't read${when}${s.reason === null ? "" : `, ${REASON_WORDS[s.reason]}`}`;
  }
  const word = STATE_WORDS[s.state];
  if (s.state === "stale" && s.reason !== null) return `${s.source}: ${word}, ${REASON_WORDS[s.reason]}`;
  return `${s.source}: ${word}`;
}

// The seat badge's words: "Out until 14:05", "Retired: use another account", "Signed out: sign in again",
// "Out (back time unknown)".
export function seatLine(seat: SeatView, now: number): string {
  void now;
  if (seat.state === "out") return seat.backAt === null ? "Out (back time unknown)" : `Out until ${clockOf(seat.backAt)}`;
  const fix = seat.fix ?? fixFor(seat.state, seat.why);
  if (seat.state === "logged-out") return fix === null ? "Signed out" : `Signed out: ${fixWords(fix)}`;
  if (seat.state === "retired") return fix === null ? "Retired" : `Retired: ${fixWords(fix)}`;
  return seat.state === "low" ? "Low" : "Fine";
}

// The frame's notices, each parsed with the protocol's schema; a row that does not parse is dropped, counted.
export function decodeNotices(raw: readonly unknown[]): { notices: UsageNotice[]; dropped: number } {
  const notices: UsageNotice[] = [];
  let dropped = 0;
  for (const x of raw) {
    const n = parseBody(UsageNoticeSchema, x);
    if (n) notices.push(n);
    else dropped++;
  }
  return { notices, dropped };
}

export const LEVEL_WORDS: Record<UsageLevel, string> = { ok: "Fine", warning: "Running low", critical: "Nearly out" };
// "23% used" at whole percent; a window near its limit says so in words beside the number (never colour alone).
export const pct = (v: number) => `${Math.round(v)}%`;

// "resets in 2 h 10 min", "resets in 3 days", "resets any minute", or nothing when the CLI gave no time.
export function resetsIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const m = Math.round((resetsAt - now) / 60_000);
  if (m < 1) return "resets any minute";
  if (m < 60) return `resets in ${m} min`;
  if (m < 48 * 60) { const h = Math.floor(m / 60); const r = m % 60; return `resets in ${h} h${r ? ` ${r} min` : ""}`; }
  return `resets in ${Math.round(m / 1440)} days`;
}
export const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};
export const usd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${v.toFixed(v < 10 ? 2 : 0)}`);
