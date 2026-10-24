// Application service for the Usage context (ADR-0016): the status-line reports the agents' sessions post, kept per
// account (U1 to U3), the latest state of every account on disk, and the whole pushed to every live feed when a report
// changed what is shown. Usage decides nothing (U4): nothing here touches an Escalation, the engines or a Mandate.
// S2 (plan 4.2 to 4.5): the readings every other source posts and their health, the seat one limit hit marks whatever
// reported it, the watches that turn readings into notices told once, and the forgetting of what went quiet.
import {
  ACCOUNT_NAME, DEFAULT_ACCOUNT, FORGET_MS, NOTICE_KEEP, SESSION_FRESH_MS,
  accountNow, applyLimit, applyReport, backNoticeText, cadenceInput, cadenceOf, changeSignature, cleanHint, cleanLength,
  cleanNote, clearSeat, failedRead, fixFor, fixForReason, forgottenNoticeText, mergeWindow, noCycleBook, noHealth,
  noPlanWatch, noThresholdWatch, observeCycle, okRead, planNoticeText, reasonOf, seatNoticeText, sourceState,
  shouldForget, takeNamed, takePercent, thresholdNoticeText, unavailableSince, watchPlan, watchThreshold, windowTitle,
  type AccountProfile, type AccountUsage, type BoardActor, type Candidate, type CycleBook, type DisagreeView,
  type FreshRead, type LimitHit, type LimitKind, type NamedWindow, type PlanFact, type PlanWatch, type SeatRecord,
  type SeatView, type SourceView, type ThresholdWatch, type UsageNotice, type UsageReport, type UsageSource,
  type UsageWindow, type WindowReading, type NoticeKind,
} from "@morndo/domain";
import type { UsageReadingsBody, UsageReportBody } from "@morndo/protocol";
import type { Store, UsageSourceBody, UsageSourceRow } from "../adapters/store.ts";
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
  // U14: a window the status line carries but whose percentage is not readable (a timestamp, a null) is unknown, not absent.
  const unreadable = (w: { used_percentage?: number | null } | null | undefined) => w != null && !(typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage));
  const unknown = ([["fiveHour", rl?.five_hour], ["sevenDay", rl?.seven_day], ["spend", spendRaw]] as const).filter(([, w]) => unreadable(w)).map(([k]) => k);
  return {
    account, sessionId: body.session_id, lane: actor.kind === "principal" ? null : actor.name, at,
    model: body.model?.display_name ?? body.model?.id ?? null,
    contextUsed: typeof ctx === "number" && Number.isFinite(ctx) ? ctx : null,
    fiveHour: win(rl?.five_hour), sevenDay: win(rl?.seven_day),
    spend: spendWin ? { ...spendWin, usedUsd: num(spendRaw?.used_usd), limitUsd: num(spendRaw?.limit_usd), period: spendRaw?.period ?? null } : null,
    limits, onDemand: limits ? (typeof body.on_demand === "string" ? body.on_demand : null) : null,
    ...(unknown.length > 0 ? { unknown } : {}),
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
// A source row that carries a reading (the sameAsPrevious rule's memory of the one before lives in the same row).
type ReadRow = UsageSourceRow & { body: UsageSourceBody & { reading: NonNullable<UsageSourceBody["reading"]> } };
const hasReading = (r: UsageSourceRow): r is ReadRow => r.body.reading !== null;

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
  // carries them, and the agent door's reply (report, below) never does. Beside the status line's own accounts stand
  // the accounts only a source speaks of, with no sessions of their own.
  view(): UsageView {
    const now = this.#now();
    const profiles = this.#profiles();
    const rows = this.#store.usageSources();
    const seats = new Map(this.#store.usageSeats().map(s => [s.account, s.record]));
    const byAccount = new Map<string, UsageSourceRow[]>();
    for (const r of rows) {
      const mine = byAccount.get(r.account) ?? [];
      mine.push(r);
      byAccount.set(r.account, mine);
    }
    const names = [...new Set([...this.#accounts.keys(), ...byAccount.keys(), ...seats.keys()])].sort((a, b) => a.localeCompare(b));
    const accounts = names.map(account => {
      const mine = byAccount.get(account) ?? [];
      const base = this.#accounts.has(account) ? accountNow(this.#accounts.get(account)!, now) : this.#skeleton(account, mine);
      return { ...this.#accountView(base, mine, seats.get(account) ?? null, now), profile: profiles.get(account) ?? base.profile ?? null };
    });
    return { accounts, at: now, notices: this.#store.usageNotices(NOTICE_KEEP) };
  }

  // An account only sources speak of: no status line ever reported, so no windows of its own — its readings are its card.
  #skeleton(account: string, rows: readonly UsageSourceRow[]): AccountUsage {
    let reportedAt = 0;
    for (const r of rows) if (r.body.reading !== null && r.body.reading.capturedAt > reportedAt) reportedAt = r.body.reading.capturedAt;
    return { account, reportedAt, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, profile: null, sessions: [] };
  }

  // One account as the principal sees it (plan 4.4): every source's health, the windows the sources read under the
  // 5-hour and weekly rows the status line owns, the windows a source names itself, the account's seat, and any two
  // sources that disagree about one window. All of it is computed here, never stored.
  #accountView(base: AccountUsage, rows: readonly UsageSourceRow[], seat: SeatRecord | null, now: number): AccountUsage {
    const stateOf = (r: UsageSourceRow) => sourceState(r.body.health, now);
    const sources: SourceView[] = rows.map(r => {
      const state = stateOf(r);
      // A source that reads well says nothing about why it cannot; a hint is the last failure's, cleaned before it was stored.
      const reason = state === "available" || state === "missing" ? null : r.body.health.reason;
      return {
        source: r.source as UsageSource, node: r.node === "" ? null : r.node, state,
        since: unavailableSince(r.body.health, now), asOf: r.body.health.lastOkAt, reason,
        fix: reason === null ? null : fixForReason(reason),
        hint: state === "available" || state === "missing" ? null : r.body.hint,
      };
    });
    // The reading sources that still count (plan 4.3 item 5): an unavailable source's meters are gone, not dimmed.
    const readings = rows.filter((r): r is ReadRow => r.source !== "status-line" && stateOf(r) !== "unavailable" && hasReading(r));
    // A window of a reading that says exactly what the source's last reading said of it is last-known data (F28).
    const echo = (r: ReadRow, w: WindowReading): boolean => {
      const p = r.body.previous?.windows.find(x => x.id === w.id);
      return p !== undefined && p.usedPercent === w.usedPercent && p.resetsAt === w.resetsAt;
    };
    const alive = (w: WindowReading): boolean => w.resetsAt === null || w.resetsAt > now;
    const found = new Map<string, { cand: Candidate; win: WindowReading }[]>();
    for (const r of readings) for (const w of r.body.reading.windows) {
      if (w.usedPercent === null || !alive(w)) continue;
      const list = found.get(w.id) ?? [];
      list.push({ cand: { source: r.source as UsageSource, node: r.node === "" ? null : r.node, capturedAt: r.body.reading.capturedAt, usedPercent: w.usedPercent, resetsAt: w.resetsAt, sameAsPrevious: echo(r, w) }, win: w });
      found.set(w.id, list);
    }
    // The status line's own windows stand as its readings of the 5-hour and weekly rows — unless it went unavailable,
    // which silence never does to it (plan 4.3 item 4).
    const statusLive = !rows.some(r => r.source === "status-line" && stateOf(r) === "unavailable");
    const statusCand = (usedPercent: number, resetsAt: number | null): { cand: Candidate; win: WindowReading | null } =>
      ({ cand: { source: "status-line", node: null, capturedAt: base.reportedAt, usedPercent, resetsAt, sameAsPrevious: false }, win: null });
    const side = (c: Candidate): DisagreeView["a"] => ({ source: c.source, usedPercent: c.usedPercent, capturedAt: c.capturedAt });
    const disagree: DisagreeView[] = [];
    const overlay = (id: "five_hour" | "seven_day"): UsageWindow | null => {
      const own = id === "five_hour" ? base.fiveHour : base.sevenDay;
      const cands = [...(own !== null && statusLive ? [statusCand(own.usedPercentage, own.resetsAt)] : []), ...(found.get(id) ?? [])];
      const m = mergeWindow(cands.map(c => c.cand));
      if (m.disagree !== null) disagree.push({ window: id, a: side(m.disagree.a), b: side(m.disagree.b) });
      if (m.shown === null || m.shown.source === "status-line") return own;
      return { usedPercentage: m.shown.usedPercent, resetsAt: m.shown.resetsAt };
    };
    const fiveHour = overlay("five_hour");
    const sevenDay = overlay("seven_day");
    // A window a source names itself (plan 4.1): titled from its own numbers, never from a caption the provider printed.
    const limits: NamedWindow[] = base.limits === null ? [] : [...base.limits];
    const named = new Map<string, { cand: Candidate; win: WindowReading | null }[]>();
    if (base.limits !== null) for (const w of base.limits) named.set(w.label, [statusCand(w.usedPercentage, w.resetsAt)]);
    for (const [id, cands] of found) {
      if (id === "five_hour" || id === "seven_day") continue;
      named.set(id, [...(named.get(id) ?? []), ...cands]);
    }
    if (named.size > 0) {
      const watches = this.#watchMap(base.account);
      for (const [id, cands] of named) {
        const m = mergeWindow(cands.map(c => c.cand));
        if (m.disagree !== null) disagree.push({ window: id, a: side(m.disagree.a), b: side(m.disagree.b) });
        if (m.shown === null || m.shown.source === "status-line") continue;    // the status line's own row stands as it reported it
        const win = cands.find(c => c.cand === m.shown)?.win ?? null;
        if (win === null) continue;
        const book = (watches.get(`cycle|${id}`) as CycleBook | undefined) ?? noCycleBook;
        const at = limits.findIndex(w => w.label === id);
        const row: NamedWindow = {
          label: id, usedPercentage: m.shown.usedPercent, resetsAt: m.shown.resetsAt,
          resetsOn: at !== -1 ? limits[at]!.resetsOn : null,
          lengthMins: win.lengthMins, rolling: win.rolling, note: win.note,
          title: windowTitle(cadenceOf({ lengthMins: win.lengthMins, ...cadenceInput(book), family: null }), win.resetsAt, now),
        };
        if (at !== -1) limits[at] = row; else limits.push(row);
      }
    }
    const seatView: SeatView | null = seat === null ? null
      : { state: seat.state, why: seat.why, since: seat.since, backAt: seat.backAt, owner: seat.owner, by: seat.by, fix: fixFor(seat.state, seat.why) };
    return {
      account: base.account, reportedAt: base.reportedAt, fiveHour, sevenDay, spend: base.spend,
      limits: limits.length > 0 ? limits : null, onDemand: base.onDemand, profile: base.profile, sessions: base.sessions,
      sources, disagree, ...(seatView !== null ? { seat: seatView } : {}),
    };
  }

  // A report from a session: its account from the call's header (none: the default account). Told to the feeds only
  // when what is shown changed, since status lines report after every turn of every session. Each report is also a
  // good read of the status-line source (plan 4.3 item 1), so its health shows beside the others'.
  report(body: UsageReportBody, accountHeader: string | null, actor: BoardActor): UsageResult {
    const account = (accountHeader ?? "").trim() || DEFAULT_ACCOUNT;
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    const now = this.#now();
    const next = applyReport(this.#accounts.get(account) ?? null, reportFrom(body, account, actor, now), now);
    this.#accounts.set(account, next);
    this.#store.saveUsageAccount(next);
    const row = this.#store.usageSources().find(r => r.account === account && r.source === "status-line" && r.node === "");
    const health = okRead(row?.body.health ?? noHealth("status-line"), now, null);
    this.#store.saveUsageSource(account, "status-line", "", { health, reading: null, previous: null, hint: null });
    // The thresholds (U12) watch the status line's own windows too, with the lengths their documented names carry.
    const shown = accountNow(next, now);
    const watches = this.#watchMap(account);
    if (shown.fiveHour !== null) this.#threshold(account, "five_hour", shown.fiveHour.usedPercentage, shown.fiveHour.resetsAt, 300, watches, now);
    if (shown.sevenDay !== null) this.#threshold(account, "seven_day", shown.sevenDay.usedPercentage, shown.sevenDay.resetsAt, 10080, watches, now);
    for (const w of shown.limits ?? []) this.#threshold(account, `named:${w.label}`, w.usedPercentage, w.resetsAt, w.lengthMins ?? null, watches, now);
    this.#tellIfChanged();
    return { ok: true, account: shown };
  }

  // The pool's file can change with no report in sight (every lane quiet): what it changed is told the same way.
  refreshProfiles() { this.#tellIfChanged(); }

  // A usage reading a source posts (plan 4.3, U14): the windows it can see now, or the one reason it cannot. The
  // account comes from the header, as with a status line's report; the body's own `source` says who read it.
  reading(body: UsageReadingsBody, accountHeader: string | null, actor: BoardActor): { ok: true } | { ok: false; problem: "bad_account" | "bad_reading" } {
    void actor;      // a reading carries no session; who posted it is the source's own business, not the card's
    const account = (accountHeader ?? "").trim() || DEFAULT_ACCOUNT;
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    if (body.source === "status-line") return { ok: false, problem: "bad_reading" };   // the status line has its own route
    const now = this.#now();
    const node = body.node ?? "";
    const capturedAt = body.captured_at * 1000;
    const row = this.#store.usageSources().find(r => r.account === account && r.source === body.source && r.node === node);
    const prev: UsageSourceBody = row?.body ?? { health: noHealth(body.source), reading: null, previous: null, hint: null };
    if (body.failure != null) {
      // A failure keeps the last good reading and its memory; what it says of itself is cleaned before it is stored.
      const health = failedRead(prev.health, capturedAt, reasonOf(body.failure.reason), body.every_s);
      this.#store.saveUsageSource(account, body.source, node, { health, reading: prev.reading, previous: prev.previous, hint: cleanHint(body.failure.hint) });
      this.#tellIfChanged();
      return { ok: true };
    }
    // 300 minutes is the 5-hour window and 10080 the weekly one, whatever the source called them (plan 4.1).
    const windows = new Map<string, WindowReading>();
    for (const w of body.windows ?? []) {
      const id = typeof w.id === "string" ? w.id.trim() : "";
      const usedPercent = takePercent(w.used_percent);
      if (id === "" || id.length > 40 || usedPercent === null) continue;
      const lengthMins = cleanLength(w.length_mins);
      const canonical = lengthMins === 300 ? "five_hour" : lengthMins === 10080 ? "seven_day" : id;
      windows.set(canonical, {
        id: canonical, usedPercent, lengthMins, rolling: w.rolling === true, note: cleanNote(w.note),
        resetsAt: typeof w.resets_at === "number" && Number.isFinite(w.resets_at) ? w.resets_at * 1000 : null,
      });
    }
    const list = [...windows.values()];
    const health = okRead(prev.health, capturedAt, body.every_s);
    // `previous` is the sameAsPrevious rule's memory (plan 4.3 item 5): the reading before this one.
    const previous = prev.reading === null ? null : { windows: prev.reading.windows.map(w => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt })) };
    this.#store.saveUsageSource(account, body.source, node, { health, reading: { capturedAt, plan: body.plan ?? null, windows: list }, previous, hint: null });
    this.#observe(account, list, capturedAt, now, body.source, body.plan ?? null, body.lease_id);
    this.#tellIfChanged();
    return { ok: true };
  }

  // What one good reading changes: the plan watch, the cycle books, the thresholds, and a seat mark it may end.
  #observe(account: string, windows: readonly WindowReading[], capturedAt: number, now: number, source: UsageSource, plan: string | null, leaseId: unknown): void {
    const watches = this.#watchMap(account);
    // The plan watch (plan 4.2): a difference is held, and told only once a later reading agrees with it.
    const fact: PlanFact = {
      plan, identity: null,
      windows: windows.map(w => ({ id: w.id, lengthMins: w.lengthMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt, rolling: w.rolling })),
      // claude-usage and app-server name every window the account has, so a window missing from them is really gone.
      ...(source === "claude-usage" || source === "app-server" ? { complete: true } : {}),
    };
    const planWatch = (watches.get("plan|") as PlanWatch | undefined) ?? noPlanWatch;
    const seen = watchPlan(planWatch, fact, capturedAt);
    if (seen.watch !== planWatch) this.#store.saveUsageWatch(account, "plan", "", seen.watch);
    for (const c of seen.told) this.#note(account, "plan", changeSignature(c), planNoticeText(account, c));
    for (const w of windows) {
      const bookPrev = (watches.get(`cycle|${w.id}`) as CycleBook | undefined) ?? noCycleBook;
      const book = observeCycle(bookPrev, w.resetsAt, capturedAt);
      if (book !== bookPrev) this.#store.saveUsageWatch(account, "cycle", w.id, book);
      this.#threshold(account, w.id, w.usedPercent, w.resetsAt, w.lengthMins, watches, now, book);
    }
    // A fresh leased reading of a new cycle is the one thing that ends a seat mark (plan 4.5, U13).
    const seat = this.#store.usageSeats().find(s => s.account === account)?.record ?? null;
    if (seat !== null) {
      const read: FreshRead = { capturedAt, leased: this.#leaseBook.valid(leaseId, account, source), windows: windows.map(w => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt, lengthMins: w.lengthMins })) };
      if (clearSeat(seat, read).cleared) {
        this.#store.deleteUsageSeat(account);
        this.#note(account, "back", `back|${seat.markedAt}`, backNoticeText(account, "a fresh reading"));
      }
    }
  }

  // A seat's limit hit as any source reports it (plan 4.5, U9): one seat record per account, one notice per change.
  // `fix` and `hint` are ignored — the Fix shown always comes from the domain's closed list.
  noteLimit(l: { account: string | null; kind: LimitKind; backAt: number | null; by: string; at: number | null; fix?: unknown; hint?: unknown }): { ok: true; resolved: boolean } | { ok: false; problem: "bad_account" } {
    void l.fix; void l.hint;
    const account = l.account === null ? null : l.account.trim();
    if (account === null || account === "") return { ok: true, resolved: false };
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    if (l.kind === "unknown") return { ok: true, resolved: false };      // an unknown kind changes no seat (U9)
    const now = this.#now();
    // The cycle the hit limited, if any reading of the account names one: the 5-hour window with a reset, else the
    // fullest window shown.
    const a = this.view().accounts.find(x => x.account === account) ?? null;
    const cycle = this.#cycleOf(a);
    const prev = this.#store.usageSeats().find(s => s.account === account)?.record ?? null;
    const r = applyLimit(prev, { kind: l.kind, at: l.at ?? now, backAt: l.backAt, by: l.by, cycle });
    if (r.seat !== null && r.seat !== prev) this.#store.saveUsageSeat(account, r.seat);
    if (r.changed && r.seat !== null)
      this.#note(account, "seat", `${r.seat.state}|${r.seat.why}|${r.seat.markedAt}`, seatNoticeText(account, r.seat));
    this.#tellIfChanged();
    return { ok: true, resolved: r.changed };
  }

  // The window a limit hit limited (plan 4.5): the 5-hour window when a reading of it names a reset, else the fullest
  // window the account shows. No reading at all: no cycle, so the mark keeps only its own back time.
  #cycleOf(a: AccountUsage | null): LimitHit["cycle"] {
    if (a === null) return null;
    if (a.fiveHour !== null && a.fiveHour.resetsAt !== null) return { windowId: "five_hour", resetsAt: a.fiveHour.resetsAt };
    const all: { id: string; usedPercentage: number; resetsAt: number | null }[] = [];
    if (a.fiveHour !== null) all.push({ id: "five_hour", ...a.fiveHour });
    if (a.sevenDay !== null) all.push({ id: "seven_day", ...a.sevenDay });
    for (const w of a.limits ?? []) all.push({ id: w.label, usedPercentage: w.usedPercentage, resetsAt: w.resetsAt });
    if (all.length === 0) return null;
    let best = all[0]!;
    for (const w of all) if (w.usedPercentage > best.usedPercentage) best = w;
    return { windowId: best.id, resetsAt: best.resetsAt };
  }

  // The principal's own forget of a source (AT-23): without a source, the whole account is gone. No tombstone — a
  // later post is a first reading, so the watches go with the last of the account's sources. True when something was
  // removed.
  forget(account: string, source?: UsageSource, node?: string | null): boolean {
    if (!ACCOUNT_NAME.test(account)) return false;
    const rows = this.#store.usageSources().filter(r => r.account === account);
    if (source === undefined) {
      const had = rows.length > 0 || this.#accounts.has(account) || this.#store.usageSeats().some(s => s.account === account);
      this.#store.deleteUsageSources(account);
      this.#store.deleteUsageWatches(account);
      this.#store.deleteUsageSeat(account);
      this.#store.deleteUsageAccount(account);
      this.#accounts.delete(account);
      if (had) this.#tellIfChanged();
      return had;
    }
    const any = node === undefined || node === null;
    const existed = rows.some(r => r.source === source && (any || r.node === node));
    this.#store.deleteUsageSources(account, source, any ? undefined : node);
    if (!this.#store.usageSources().some(r => r.account === account)) this.#store.deleteUsageWatches(account);
    if (existed) this.#tellIfChanged();
    return existed;
  }

  // The silence and forgetting pass (AT-24): every 60 s from main.ts. A source silent for two weeks is forgotten,
  // with one notice; an account with no sources, no seat and nothing said for two weeks goes too.
  sweep(): void {
    const now = this.#now();
    const byAccount = new Map<string, UsageSourceRow[]>();
    for (const r of this.#store.usageSources()) {
      const mine = byAccount.get(r.account) ?? [];
      mine.push(r);
      byAccount.set(r.account, mine);
    }
    for (const [account, rows] of byAccount) {
      const gone = new Set<string>();
      for (const r of rows) if (shouldForget(r.body.health, now)) {
        this.#store.deleteUsageSources(account, r.source as UsageSource, r.node);
        gone.add(r.source);
      }
      for (const source of gone) this.#note(account, "forgotten", source, forgottenNoticeText(account, source as UsageSource));
      if (gone.size > 0 && !this.#store.usageSources().some(r => r.account === account)) this.#store.deleteUsageWatches(account);
    }
    const remaining = new Set(this.#store.usageSources().map(r => r.account));
    const seated = new Set(this.#store.usageSeats().map(s => s.account));
    for (const a of [...this.#accounts.values()]) {
      if (remaining.has(a.account) || seated.has(a.account)) continue;
      if (now - a.reportedAt < FORGET_MS) continue;
      if (a.sessions.some(s => now - s.at < SESSION_FRESH_MS)) continue;
      this.#store.deleteUsageAccount(a.account);
      this.#store.deleteUsageWatches(a.account);
      this.#accounts.delete(a.account);
      this.#note(a.account, "forgotten", "", forgottenNoticeText(a.account, null));
    }
    this.#tellIfChanged();
  }

  // One window's threshold watch (U12): told once per crossing, after two readings at or above the line.
  #threshold(account: string, key: string, usedPercent: number | null, resetsAt: number | null, lengthMins: number | null, watches: Map<string, unknown>, now: number, book: CycleBook = noCycleBook): void {
    const prev = (watches.get(`threshold|${key}`) as ThresholdWatch | undefined) ?? noThresholdWatch;
    const r = watchThreshold(prev, usedPercent, resetsAt);
    if (r.watch !== prev) { this.#store.saveUsageWatch(account, "threshold", key, r.watch); watches.set(`threshold|${key}`, r.watch); }
    if (r.told !== null) {
      const title = windowTitle(cadenceOf({ lengthMins, ...cadenceInput(book), family: null }), resetsAt, now);
      this.#note(account, "threshold", `threshold|${key}|${r.told}|${now}`, thresholdNoticeText(account, title, r.told));
    }
  }

  #watchMap(account: string): Map<string, unknown> {
    return new Map(this.#store.usageWatches(account).map(w => [`${w.kind}|${w.key}`, w.body]));
  }

  // The notices the hub itself writes (plan 4.4): the signature is the once-only key, so the same event told twice —
  // across a restart too — tells nobody. Every word of one comes from the domain, never from an agent token.
  #note(account: string, kind: NoticeKind, signature: string, text: string): void {
    this.#store.saveUsageNotice({ id: `${account}|${kind}|${signature}`, kind, account, at: this.#now(), text }, signature);
  }

  #tellIfChanged() {
    const v = this.view();
    // What is shown, minus how long ago it was said: a newer timestamp alone never tells anybody anything.
    const shown = JSON.stringify({
      notices: v.notices.map(n => n.id),
      accounts: v.accounts.map(a => ({
        ...a, reportedAt: 0,
        sources: (a.sources ?? []).map(s => ({ ...s, asOf: null })),
        sessions: a.sessions.map(s => ({ ...s, at: 0 })),
      })),
    });
    if (shown !== this.#lastTold) { this.#lastTold = shown; for (const l of this.#listeners) l(v); }
  }
}
