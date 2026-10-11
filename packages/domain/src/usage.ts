// Usage context (docs/domain.md "Usage: how much of each account is spent"; ADR-0016): what each connected account
// has used of its rate-limit windows, as the agent CLI's own status line reports it from inside each session. A report
// comes only through an agent token, named for an account (U1); per account the newest report sets the windows, and a
// window missing from a report is kept until its reset time has passed (U2); the sessions reporting are kept while
// fresh (U3); usage grants and decides nothing (U4): it is a read model, like Observation.
export type UsageWindow = { usedPercentage: number; resetsAt: number | null };            // resetsAt in ms
export type SpendWindow = UsageWindow & { usedUsd: number | null; limitUsd: number | null; period: string | null };
// A window the account names itself (Cursor's "Cursor models"), with the calendar date the provider printed
// (`resetsOn`, YYYY-MM-DD) when the reset is a day rather than an instant.
export type NamedWindow = UsageWindow & { label: string; resetsOn: string | null };
export type SessionUsage = { sessionId: string; lane: string | null; model: string | null; contextUsed: number | null; at: number };

// One status-line report, as the adapter translates it (the raw shape is the agent CLI's own).
// `limits` null: a status line (5-hour, weekly, spend). An array: these are the windows the account has.
export type UsageReport = {
  account: string; sessionId: string; lane: string | null; model: string | null; at: number;
  fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; spend: SpendWindow | null; contextUsed: number | null;
  limits: NamedWindow[] | null; onDemand: string | null;
};
export type AccountUsage = {
  account: string; reportedAt: number;
  fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; spend: SpendWindow | null;
  limits: NamedWindow[] | null; onDemand: string | null;
  sessions: SessionUsage[];
};

export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,79}$/;
export const DEFAULT_ACCOUNT = "default";
// A session counts as reporting while its last report is this fresh.
export const SESSION_FRESH_MS = 10 * 60_000;
// Where a window's fill changes state (a meter's severity; the words and the icon go with it, never colour alone).
export const USAGE_WARNING = 75;
export const USAGE_CRITICAL = 90;
export type UsageLevel = "ok" | "warning" | "critical";
export const usageLevel = (usedPercentage: number): UsageLevel => (usedPercentage >= USAGE_CRITICAL ? "critical" : usedPercentage >= USAGE_WARNING ? "warning" : "ok");

const clampPct = (v: number) => Math.min(100, Math.max(0, v));
const window = (w: UsageWindow | null): UsageWindow | null => (w ? { usedPercentage: clampPct(w.usedPercentage), resetsAt: w.resetsAt } : null);
// A window kept from before is dropped once its reset time has passed (the CLI drops it then too).
const keep = <W extends UsageWindow>(w: W | null, now: number): W | null => (w && (w.resetsAt === null || w.resetsAt > now) ? w : null);
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const calendarDate = (v: string | null): string | null => {
  if (!v) return null;
  const m = DATE.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return v;
};
const printable = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c !== 127) out += s.charAt(i);
  }
  return out;
};
const labelOf = (s: string) => printable(s).trim().slice(0, 80);
const demandOf = (s: string | null): string | null => {
  if (!s) return null;
  const t = printable(s).trim().slice(0, 80);
  if (t === "off" || t === "unavailable") return t;
  if (/^on-demand [A-Za-z0-9$.,() -]+$/.test(t)) return t;
  return null;
};
const named = (w: NamedWindow): NamedWindow | null => {
  const label = labelOf(w.label);
  if (!label) return null;
  return { label, usedPercentage: clampPct(w.usedPercentage), resetsAt: w.resetsAt, resetsOn: calendarDate(w.resetsOn) };
};
const keepNamed = (ws: NamedWindow[] | null | undefined, now: number): NamedWindow[] | null =>
  (ws == null ? null : ws.filter(w => w.resetsAt === null || w.resetsAt > now));

// U2: the account after one report. A report older than the account's last never moves the windows (reports from
// several sessions of one account can cross), but its session is still noted when it is newer than that session's last.
export function applyReport(current: AccountUsage | null, r: UsageReport, now: number): AccountUsage {
  const base: AccountUsage = current
    ? { ...current, limits: current.limits ?? null, onDemand: current.onDemand ?? null }
    : { account: r.account, reportedAt: 0, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, sessions: [] };
  const newer = r.at >= base.reportedAt;
  const session: SessionUsage = { sessionId: r.sessionId, lane: r.lane, model: r.model, contextUsed: r.contextUsed === null ? null : clampPct(r.contextUsed), at: r.at };
  const had = base.sessions.find(s => s.sessionId === r.sessionId);
  const sessions = had && had.at > r.at ? base.sessions : [...base.sessions.filter(s => s.sessionId !== r.sessionId), session];
  if (!newer) return { ...base, sessions: pruneSessions(sessions, now) };
  // A report that names its windows replaces them. One that doesn't (a status line) keeps them until each reset.
  const namedNow = r.limits == null ? null : r.limits.flatMap(w => { const n = named(w); return n ? [n] : []; });
  const limits = namedNow ?? keepNamed(base.limits, now);
  return {
    account: base.account,
    reportedAt: r.at,
    fiveHour: window(r.fiveHour) ?? keep(base.fiveHour, now),
    sevenDay: window(r.sevenDay) ?? keep(base.sevenDay, now),
    spend: r.spend ? { ...r.spend, usedPercentage: clampPct(r.spend.usedPercentage) } : keep(base.spend, now),
    limits,
    onDemand: namedNow ? demandOf(r.onDemand) : (limits === null ? null : base.onDemand),
    sessions: pruneSessions(sessions, now),
  };
}

// U3: the sessions that reported within SESSION_FRESH_MS, newest first.
export const pruneSessions = (sessions: readonly SessionUsage[], now: number): SessionUsage[] =>
  sessions.filter(s => now - s.at < SESSION_FRESH_MS).sort((a, b) => b.at - a.at);

// What the dashboard shows of an account now: its windows as kept, with past resets dropped, and only fresh sessions.
export function accountNow(a: AccountUsage, now: number): AccountUsage {
  const limits = keepNamed(a.limits, now);
  return {
    ...a, fiveHour: keep(a.fiveHour, now), sevenDay: keep(a.sevenDay, now), spend: keep(a.spend, now),
    limits, onDemand: limits === null ? null : (a.onDemand ?? null), sessions: pruneSessions(a.sessions, now),
  };
}

// The account nearest its limit on a window, for the headline tiles; null when no account reports that window.
export function tightest(accounts: readonly AccountUsage[], which: "fiveHour" | "sevenDay"): { account: string; window: UsageWindow } | null {
  let best: { account: string; window: UsageWindow } | null = null;
  for (const a of accounts) {
    const w = a[which];
    if (w && (!best || w.usedPercentage > best.window.usedPercentage)) best = { account: a.account, window: w };
  }
  return best;
}
