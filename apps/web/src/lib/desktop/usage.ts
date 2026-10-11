// How usage is shown on Home (ADR-0016): the words for a window and its reset, the meter's level, and the decoding of
// the `usage` feed frame. The rules (which level, which account is tightest) are the domain's.
import { tightest, usageLevel, type AccountUsage, type UsageLevel, type UsageWindow } from "@morndo/domain";
import { AccountUsageSchema, parseBody } from "@morndo/protocol";

export type { AccountUsage, UsageLevel, UsageWindow };
export { tightest, usageLevel };

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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// "resets 7 Nov" from a calendar date the provider printed (YYYY-MM-DD). Nothing when it isn't a real date.
export function resetsOnLabel(resetsOn: string | null): string | null {
  if (!resetsOn) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(resetsOn);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const month = MONTHS[mo - 1];
  if (!month) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `resets ${d} ${month}`;
}

// The one line under a named account's bars. "off" is Cursor's "On-demand usage is off".
export function onDemandLine(v: string | null): string | null {
  if (v === "off") return "on-demand off";
  if (v === "unavailable") return "on-demand limit unavailable";
  if (v && /^on-demand [A-Za-z0-9$.,() -]{1,60}$/.test(v)) return v;
  return null;
}
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
