// Application service for the Usage context (ADR-0016): the status-line reports the agents' sessions post, kept per
// account (U1 to U3), the latest state of every account on disk, and the whole pushed to every live feed when a report
// changed what is shown. Usage decides nothing (U4): nothing here touches an Escalation, the engines or a Mandate.
import { ACCOUNT_NAME, DEFAULT_ACCOUNT, accountNow, applyReport, takeNamed, type AccountProfile, type AccountUsage, type BoardActor, type LimitKind, type NamedWindow, type UsageNotice, type UsageReport, type UsageSource } from "@morndo/domain";
import type { UsageReadingsBody, UsageReportBody } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import { LeaseBook } from "./usage-leases.ts";

export type UsageView = { accounts: AccountUsage[]; at: number; notices: UsageNotice[] };
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
// Translate the wire rows and let the domain drop a bad one and cap what remains. No second label rule or cap here.
function namedLimits(raw: UsageReportBody["limits"]): NamedWindow[] | null {
  if (raw == null) return null;
  const rows: NamedWindow[] = [];
  for (const w of raw) {
    if (w == null) continue;
    rows.push({
      label: typeof w.label === "string" ? w.label : "",
      usedPercentage: typeof w.used_percentage === "number" ? w.used_percentage : Number.NaN,
      resetsAt: typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
      resetsOn: typeof w.resets_on === "string" ? w.resets_on : null,
    });
  }
  return takeNamed(rows);
}
const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const EMPTY_PROFILES: ReadonlyMap<string, AccountProfile> = new Map();

export class UsageService {
  #store: Store;
  #now: () => number;
  #accounts = new Map<string, AccountUsage>();
  #listeners = new Set<(v: UsageView) => void>();
  #lastTold = "";
  #profiles: () => ReadonlyMap<string, AccountProfile>;
  #leaseBook: LeaseBook;

  constructor(p: { store: Store; now?: () => number; profiles?: () => ReadonlyMap<string, AccountProfile>; leases?: LeaseBook }) {
    this.#store = p.store;
    this.#now = p.now ?? Date.now;
    this.#profiles = p.profiles ?? (() => EMPTY_PROFILES);
    this.#leaseBook = p.leases ?? new LeaseBook(this.#now);
    for (const a of this.#store.usageAccounts()) this.#accounts.set(a.account, a);
  }

  // The seat leases (U13), for tests and the S5 route.
  get leases(): LeaseBook { return this.#leaseBook; }

  subscribe(fn: (v: UsageView) => void) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  // The label parts (U5) are overlaid here, on what the principal sees, and nowhere else: a stored account never
  // carries them, and the agent door's reply (report, below) never does.
  view(): UsageView {
    const now = this.#now();
    const profiles = this.#profiles();
    return {
      accounts: [...this.#accounts.values()]
        .map(a => ({ ...accountNow(a, now), profile: profiles.get(a.account) ?? a.profile ?? null }))
        .sort((a, b) => a.account.localeCompare(b.account)),
      at: now,
      notices: [],
    };
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
    this.#tellIfChanged();
    return { ok: true, account: accountNow(next, now) };
  }

  // The pool's file can change with no report in sight (every lane quiet): what it changed is told the same way.
  refreshProfiles() { this.#tellIfChanged(); }

  // A usage reading a source posts (plan 4.3, U14): the windows it can see now, or the one reason it cannot. The
  // account comes from the header, as with a status line's report; the body's own `source` says who read it.
  reading(body: UsageReadingsBody, accountHeader: string | null, actor: BoardActor): { ok: true } | { ok: false; problem: "bad_account" | "bad_reading" } {
    throw new Error("not implemented");
  }

  // A seat's limit hit as any source reports it (plan 4.5, U9): one seat record per account, one notice per change.
  // `fix` and `hint` are ignored — the Fix shown always comes from the domain's closed list.
  noteLimit(l: { account: string | null; kind: LimitKind; backAt: number | null; by: string; at: number | null; fix?: unknown; hint?: unknown }): { ok: true; resolved: boolean } | { ok: false; problem: "bad_account" } {
    throw new Error("not implemented");
  }

  // The principal's own forget of a source (AT-23): without a source, the whole account is gone. No tombstone — a
  // later post is a first reading. True when something was removed.
  forget(account: string, source?: UsageSource, node?: string | null): boolean {
    throw new Error("not implemented");
  }

  // The silence and forgetting pass (AT-24): every 60 s from main.ts. A source silent for two weeks is forgotten,
  // with one notice; an account with no sources and nothing said for two weeks goes too.
  sweep(): void {
    throw new Error("not implemented");
  }

  #tellIfChanged() {
    const shown = JSON.stringify(this.view().accounts.map(a => ({ ...a, reportedAt: 0, sessions: a.sessions.map(s => ({ ...s, at: 0 })) })));
    if (shown !== this.#lastTold) { this.#lastTold = shown; const v = this.view(); for (const l of this.#listeners) l(v); }
  }
}
