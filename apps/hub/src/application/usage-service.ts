// Application service for the Usage context (ADR-0016): the status-line reports the agents' sessions post, kept per
// account (U1 to U3), the latest state of every account on disk, and the whole pushed to every live feed when a report
// changed what is shown. Usage decides nothing (U4): nothing here touches an Escalation, the engines or a Mandate.
import { ACCOUNT_NAME, DEFAULT_ACCOUNT, accountNow, applyReport, type AccountUsage, type BoardActor, type NamedWindow, type UsageReport } from "@morndo/domain";
import type { UsageReportBody } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";

export type UsageView = { accounts: AccountUsage[]; at: number };
export type UsageResult = { ok: true; account: AccountUsage } | { ok: false; problem: "bad_account" };

// The adapter over the agent CLI's status-line JSON: epoch seconds to ms, absent or null windows to null, the lane
// from the worker token's name (a manager token: the manager's), the model's display name.
export function reportFrom(body: UsageReportBody, account: string, actor: BoardActor, at: number): UsageReport {
  const win = (w: { used_percentage?: number | null; resets_at?: number | null } | null | undefined) =>
    typeof w?.used_percentage === "number" && Number.isFinite(w.used_percentage)
      ? { usedPercentage: w.used_percentage, resetsAt: typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null }
      : null;
  const rl = body.rate_limits ?? null;
  const spendRaw = rl?.spend_limit ?? null;
  const spendWin = win(spendRaw);
  const ctx = body.context_window?.used_percentage;
  const limits = namedLimits(body.limits);
  return {
    account, sessionId: body.session_id, lane: actor.kind === "principal" ? null : actor.name, at,
    model: body.model?.display_name ?? body.model?.id ?? null,
    contextUsed: typeof ctx === "number" && Number.isFinite(ctx) ? ctx : null,
    fiveHour: win(rl?.five_hour), sevenDay: win(rl?.seven_day),
    spend: spendWin ? { ...spendWin, usedUsd: num(spendRaw?.used_usd), limitUsd: num(spendRaw?.limit_usd), period: spendRaw?.period ?? null } : null,
    limits, onDemand: limits ? (typeof body.on_demand === "string" ? body.on_demand : null) : null,
  };
}
// Absent: a status line. Present: the windows this account has, in order. A row without a percentage is dropped.
function namedLimits(raw: UsageReportBody["limits"]): NamedWindow[] | null {
  if (raw == null) return null;
  const out: NamedWindow[] = [];
  for (const w of raw) {
    if (typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) continue;
    out.push({
      label: w.label, usedPercentage: w.used_percentage,
      resetsAt: typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
      resetsOn: typeof w.resets_on === "string" ? w.resets_on : null,
    });
  }
  return out;
}
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class UsageService {
  #store: Store;
  #now: () => number;
  #accounts = new Map<string, AccountUsage>();
  #listeners = new Set<(v: UsageView) => void>();
  #lastTold = "";

  constructor(p: { store: Store; now?: () => number }) {
    this.#store = p.store;
    this.#now = p.now ?? Date.now;
    for (const a of this.#store.usageAccounts()) this.#accounts.set(a.account, a);
  }

  subscribe(fn: (v: UsageView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  view(): UsageView {
    const now = this.#now();
    return { accounts: [...this.#accounts.values()].map(a => accountNow(a, now)).sort((a, b) => a.account.localeCompare(b.account)), at: now };
  }

  // A report from a session: its account from the call's header (none: the default account). Told to the feeds only
  // when what is shown changed, since status lines report after every turn of every session.
  report(body: UsageReportBody, accountHeader: string | null, actor: BoardActor): UsageResult {
    const account = (accountHeader ?? "").trim() || DEFAULT_ACCOUNT;
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    const now = this.#now();
    const next = applyReport(this.#accounts.get(account) ?? null, reportFrom(body, account, actor, now), now);
    this.#accounts.set(account, next);
    this.#store.saveUsageAccount(next);
    const shown = JSON.stringify(this.view().accounts.map(a => ({ ...a, reportedAt: 0, sessions: a.sessions.map(s => ({ ...s, at: 0 })) })));
    if (shown !== this.#lastTold) { this.#lastTold = shown; const v = this.view(); for (const l of this.#listeners) l(v); }
    return { ok: true, account: accountNow(next, now) };
  }
}
