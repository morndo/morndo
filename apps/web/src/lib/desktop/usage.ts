// How usage is shown on Home (ADR-0016): the words for a window and its reset, the meter's level, and the decoding of
// the `usage` feed frame. The rules (which level, which account is tightest) are the domain's.
import { onDemandLine, resetsOnLabel, shownLevel, tightest, tightestShown, usageLevel, type AccountUsage, type UsageLevel, type UsageWindow } from "@morndo/domain";
import { AccountUsageSchema, parseBody } from "@morndo/protocol";

export type { AccountUsage, UsageLevel, UsageWindow };
export { onDemandLine, resetsOnLabel, shownLevel, tightest, tightestShown, usageLevel };

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
