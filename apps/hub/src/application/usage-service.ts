// Application service for the Usage context (ADR-0016): the status-line reports the agents' sessions post, kept per
// account (U1 to U3), the latest state of every account on disk, and the whole pushed to every live feed when a report
// changed what is shown. Usage decides nothing (U4): nothing here touches an Escalation, the engines or a Mandate.
// S2 (plan 4.2 to 4.5): the readings every other source posts and their health, the seat one limit hit marks whatever
// reported it, the watches that turn readings into notices told once, and the forgetting of what went quiet.
import {
  ACCOUNT_NAME, DEFAULT_ACCOUNT, FORGET_MS, NOTICE_KEEP, SESSION_FRESH_MS,
  accountNow, applyLimit, applyReport, backNoticeText, cadenceInput, cadenceOf, changeSignature, cleanHint, cleanLength,
  cleanNote, clearSeat, failedRead, fixFor, fixForReason, forgottenNoticeText, limitKindOfError, markExpired, mergeWindow, noCycleBook,
  noHealth, noPlanWatch, noThresholdWatch, observeCycle, okRead, planNoticeText, pruneSessions, reasonOf, resolveAccount,
  seatExpiredNoticeText, seatNoticeText,
  seatResetNoticeText, shownSeat, sourceState, shouldForget, takeNamed, takePercent, thresholdNoticeText, unavailableSince,
  watchPlan, watchThreshold, windowTitle,
  poolSeat as poolSeatOf,
  type AccountProfile, type AccountUsage, type BoardActor, type Candidate, type CycleBook, type DisagreeView,
  type FreshRead, type FreshSession, type LaneRecord, type LimitHit, type LimitKind, type NamedWindow, type PlanFact,
  type PlanWatch, type SeatRecord, type SeatState, type SeatView, type SeatWhy, type SourceView, type ThresholdWatch,
  type UsageNotice, type UsageReport, type UsageSource, type UsageWindow, type WindowReading, type NoticeKind,
} from "@morndo/domain";
import { UsageTapBody } from "@morndo/protocol";
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
// How far ahead of the hub's clock a source's own stamp may run before the hub caps it (two machines' clocks differ).
export const CLOCK_SKEW_MS = 5 * 60_000;
// How much older than the hub's clock a fleet failure may be before it is a replay, not news (PR #127, finding 3a).
export const STALE_FAILURE_MS = 5 * 60_000;
// Fix round on PR #125. The hint the hub itself writes when a reading carried no readable window at all (finding 4a),
// how often the status line's health row may be rewritten (finding 5a) and what notice retention keeps (finding 5c).
const UNREADABLE_HINT = "the reading had no readable window";
const STATUS_LINE_HEALTH_MS = 60_000;
const NOTICE_KEEP_ROWS = 500;
const NOTICE_KEEP_MS = 30 * 24 * 3_600_000;
const EMPTY_PROFILES: ReadonlyMap<string, AccountProfile> = new Map();
// A source row that carries a reading (the sameAsPrevious rule's memory of the one before lives in the same row).
type ReadRow = UsageSourceRow & { body: UsageSourceBody & { reading: NonNullable<UsageSourceBody["reading"]> } };
const hasReading = (r: UsageSourceRow): r is ReadRow => r.body.reading !== null;
// One window as the merge shows it, with the capture time of the candidate that showed it and the keys its threshold
// watch and cycle book sit under (fix round on PR #125, finding 4b): what a threshold counts, never a source's raw numbers.
type ShownWindow = { key: string; cycleKey: string; usedPercent: number; resetsAt: number | null; lengthMins: number | null; capturedAt: number };
type MergedView = { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; limits: NamedWindow[] | null; disagree: DisagreeView[]; shown: readonly ShownWindow[] };

export class UsageService {
  #store: Store;
  #now: () => number;
  #accounts = new Map<string, AccountUsage>();
  #listeners = new Set<(v: UsageView) => void>();
  #lastTold = "";
  #profiles: () => ReadonlyMap<string, AccountProfile>;
  #leaseBook: LeaseBook;
  #laneNode: (lane: string) => string | null;
  #onNotice: ((kind: NoticeKind) => void) | null;

  constructor(p: { store: Store; now?: () => number; profiles?: () => ReadonlyMap<string, AccountProfile>; leases?: LeaseBook; laneNode?: (lane: string) => string | null; onNotice?: (kind: NoticeKind) => void }) {
    this.#store = p.store;
    this.#now = p.now ?? Date.now;
    this.#profiles = p.profiles ?? (() => EMPTY_PROFILES);
    this.#leaseBook = p.leases ?? new LeaseBook(this.#now);
    // S3 (plan 4.5 item 4): where a lane runs, for the lane records a report writes and a failure resolves through.
    // Without a fleet the hub knows no lane's node, so a record is kept under node "" and never serves a node's rule.
    this.#laneNode = p.laneNode ?? (() => null);
    // S4 (plan 4.4): who hears of a notice newly written (the NotificationService, through a late-bound closure).
    this.#onNotice = p.onNotice ?? null;
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
    const derived = new Map(this.#store.usageSeats().map(s => [s.account, s.record]));
    // The pool's own seats (U15, U17) stand beside the derived ones; what the principal is shown is the worse of the two.
    const pooled = new Map(this.#store.usagePoolSeats().map(s => [s.account, s.record]));
    const byAccount = new Map<string, UsageSourceRow[]>();
    for (const r of rows) {
      const mine = byAccount.get(r.account) ?? [];
      mine.push(r);
      byAccount.set(r.account, mine);
    }
    const names = [...new Set([...this.#accounts.keys(), ...byAccount.keys(), ...derived.keys(), ...pooled.keys()])].sort((a, b) => a.localeCompare(b));
    const accounts = names.map(account => {
      const mine = byAccount.get(account) ?? [];
      const base = this.#accounts.has(account) ? accountNow(this.#accounts.get(account)!, now) : this.#skeleton(account, mine);
      return { ...this.#accountView(base, mine, shownSeat(pooled.get(account) ?? null, derived.get(account) ?? null), now), profile: profiles.get(account) ?? base.profile ?? null };
    });
    return { accounts, at: now, notices: this.#store.usageNotices(NOTICE_KEEP) };
  }

  // An account only sources speak of: no status line ever reported, so no windows of its own — its readings are its card.
  #skeleton(account: string, rows: readonly UsageSourceRow[]): AccountUsage {
    let reportedAt = 0;
    for (const r of rows) if (r.body.reading !== null && r.body.reading.capturedAt > reportedAt) reportedAt = r.body.reading.capturedAt;
    return { account, reportedAt, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, profile: null, sessions: [] };
  }

  // The windows one account shows, merged across its sources (plan 4.3 item 5), and the capture time of the candidate
  // that showed each (fix round on PR #125, finding 4b): one function for the principal's view and for the thresholds,
  // so a watch always counts what the merge of every source shows, never one source's raw numbers.
  #mergedWindows(base: AccountUsage, rows: readonly UsageSourceRow[], now: number): MergedView {
    const stateOf = (r: UsageSourceRow) => sourceState(r.body.health, now);
    // The reading sources that still count (plan 4.3 item 5): an unavailable source's meters are gone, not dimmed.
    const readings = rows.filter((r): r is ReadRow => r.source !== "status-line" && stateOf(r) !== "unavailable" && hasReading(r));
    // A window of a reading that says exactly what the source's last reading said of it is last-known data (F28), as
    // old as the read it repeats unless no status line spoke since then (PR #125, finding 1).
    const echo = (r: ReadRow, w: WindowReading): boolean => {
      const p = r.body.previous?.windows.find(x => x.id === w.id);
      return p !== undefined && p.usedPercent === w.usedPercent && p.resetsAt === w.resetsAt;
    };
    const alive = (w: WindowReading): boolean => w.resetsAt === null || w.resetsAt > now;
    const found = new Map<string, { cand: Candidate; win: WindowReading }[]>();
    for (const r of readings) for (const w of r.body.reading.windows) {
      if (w.usedPercent === null || !alive(w)) continue;
      const list = found.get(w.id) ?? [];
      list.push({ cand: { source: r.source as UsageSource, node: r.node === "" ? null : r.node, capturedAt: r.body.reading.capturedAt, usedPercent: w.usedPercent, resetsAt: w.resetsAt, sameAsPrevious: echo(r, w), previousCapturedAt: r.body.previous?.capturedAt ?? null }, win: w });
      found.set(w.id, list);
    }
    // The status line's own windows stand as its readings of the 5-hour and weekly rows — unless it went unavailable,
    // which silence never does to it (plan 4.3 item 4).
    const statusLive = !rows.some(r => r.source === "status-line" && stateOf(r) === "unavailable");
    const statusCand = (usedPercent: number, resetsAt: number | null): { cand: Candidate; win: WindowReading | null } =>
      ({ cand: { source: "status-line", node: null, capturedAt: base.reportedAt, usedPercent, resetsAt, sameAsPrevious: false }, win: null });
    const side = (c: Candidate): DisagreeView["a"] => ({ source: c.source, usedPercent: c.usedPercent, capturedAt: c.capturedAt });
    const disagree: DisagreeView[] = [];
    const shown: ShownWindow[] = [];
    // A source's window counts by when its reading was taken; the status line's own row by when the account last reported.
    const atOf = (cand: Candidate | null): number => cand !== null && cand.source !== "status-line" ? cand.capturedAt : base.reportedAt;
    const overlay = (id: "five_hour" | "seven_day"): UsageWindow | null => {
      const own = id === "five_hour" ? base.fiveHour : base.sevenDay;
      const cands = [...(own !== null && statusLive ? [statusCand(own.usedPercentage, own.resetsAt)] : []), ...(found.get(id) ?? [])];
      const m = mergeWindow(cands.map(c => c.cand));
      if (m.disagree !== null) disagree.push({ window: id, a: side(m.disagree.a), b: side(m.disagree.b) });
      const win = m.shown === null || m.shown.source === "status-line" ? own : { usedPercentage: m.shown.usedPercent, resetsAt: m.shown.resetsAt };
      if (win !== null) shown.push({ key: id, cycleKey: id, usedPercent: win.usedPercentage, resetsAt: win.resetsAt, lengthMins: id === "five_hour" ? 300 : 10080, capturedAt: atOf(m.shown) });
      return win;
    };
    const fiveHour = overlay("five_hour");
    const sevenDay = overlay("seven_day");
    // A window a source names itself (plan 4.1): titled from its own numbers, never from a caption the provider printed.
    const limits: NamedWindow[] = base.limits === null ? [] : [...base.limits];
    const namedAt = new Map<string, number>();
    if (base.limits !== null) for (const w of base.limits) namedAt.set(w.label, base.reportedAt);
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
        namedAt.set(id, m.shown.capturedAt);
      }
    }
    for (const row of limits) shown.push({ key: `named:${row.label}`, cycleKey: row.label, usedPercent: row.usedPercentage, resetsAt: row.resetsAt, lengthMins: row.lengthMins ?? null, capturedAt: namedAt.get(row.label) ?? base.reportedAt });
    return { fiveHour, sevenDay, limits: limits.length > 0 ? limits : null, disagree, shown };
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
    const { fiveHour, sevenDay, limits, disagree } = this.#mergedWindows(base, rows, now);
    const seatView: SeatView | null = seat === null ? null
      : { state: seat.state, why: seat.why, since: seat.since, backAt: seat.backAt, owner: seat.owner, by: seat.by, fix: fixFor(seat.state, seat.why) };
    return {
      account: base.account, reportedAt: base.reportedAt, fiveHour, sevenDay, spend: base.spend,
      limits, onDemand: base.onDemand, profile: base.profile, sessions: base.sessions,
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
    // S3 (plan 4.5 item 4): a lane's report writes the lane record its failures resolve from, replacing the record of
    // that (node, lane) — the lane may have moved to another account since its last report. A lane the fleet's list
    // places on no node writes none (PR #127, finding 4a): no node "" records are written any more, though resolution
    // still tolerates the ones stored before. The store keeps a start record of the last twelve hours against a report.
    const lane = actor.kind === "principal" ? null : actor.name;
    if (lane !== null && lane !== "") {
      const laneNodeOf = this.#laneNode(lane);
      if (laneNodeOf !== null) this.#store.saveLaneAccount(laneNodeOf, lane, account, now, "report");
    }
    const next = applyReport(this.#accounts.get(account) ?? null, reportFrom(body, account, actor, now), now);
    this.#accounts.set(account, next);
    this.#store.saveUsageAccount(next);
    // The status line's health row is rewritten at most once a minute of the hub clock (PR #125, finding 5a): a lane
    // reports after every turn of every session, and the row says only when it last spoke.
    const row = this.#store.usageSource(account, "status-line", "");
    const lastOk = row?.body.health.lastOkAt ?? null;
    if (lastOk === null || now - lastOk >= STATUS_LINE_HEALTH_MS) {
      const health = okRead(row?.body.health ?? noHealth("status-line"), now, null);
      this.#store.saveUsageSource(account, "status-line", "", { health, reading: null, previous: null, hint: null });
    }
    // The thresholds (U12) watch the merged shown windows — the status line's own rows and whatever a reading source
    // shows of them — each with the capture time of the candidate that showed it (PR #125, finding 4b).
    const shown = accountNow(next, now);
    this.#thresholds(account, this.#mergedWindows(shown, this.#store.usageSourcesOf(account), now), now);
    this.#tellIfChanged();
    return { ok: true, account: shown };
  }

  // The pool's file can change with no report in sight (every lane quiet): what it changed is told the same way.
  refreshProfiles() { this.#tellIfChanged(); }

  // The fleet's usage tap (plan 4.5 item 4): a lane's start with an account writes its lane record; a limit failure
  // resolves to an account — the hook's own word, the lane's record, the session, the node's only one — and marks that
  // account's seat. A failure that resolves to nothing is kept as nothing (U9): no seat changes, and no account is
  // ever created by one.
  fromFleet(node: string, body: unknown): void {
    const parsed = UsageTapBody.safeParse(body);
    if (!parsed.success) return;
    const tap = parsed.data;
    if (tap.kind === "lane_account") {
      this.#store.saveLaneAccount(node, tap.lane, tap.account, tap.at, "start");
      return;
    }
    const kind = limitKindOfError(tap.error);
    if (kind === null) return;
    const now = this.#now();
    // A failure older than the skew is a node replaying its events after a reconnect (PR #127, finding 3a): not news,
    // no mark. A failure stamped ahead of the hub's clock is capped as a reading's stamp is.
    if (now - tap.at > STALE_FAILURE_MS) return;
    const at = Math.min(tap.at, now + CLOCK_SKEW_MS);
    // The fresh sessions of every account, as pruneSessions keeps them: a failure's session id resolves through them.
    const sessions: FreshSession[] = [];
    for (const a of this.#accounts.values()) for (const s of pruneSessions(a.sessions, now)) sessions.push({ account: a.account, sessionId: s.sessionId, lane: s.lane });
    const records: readonly LaneRecord[] = this.#store.laneAccounts();
    // The hook's own word is passed on only for an account this node is seen to run (PR #127, finding 1): a lane record
    // of this node names it, or a fresh session of it sits on a lane of this node. Either one means the hub knows the
    // account (a record or a session is how it learns one), so no separate "known" test is left to fail alone. Anything
    // else is dropped and resolution goes on without it: a failure naming an account nobody knows creates nothing, and
    // one node's word never marks another node's account.
    const hook = typeof tap.account === "string" && this.#seenOnNode(tap.account, node, records, sessions) ? tap.account : null;
    const resolved = resolveAccount({
      hookAccount: hook, node, lane: tap.lane, sessionId: tap.sessionId ?? null, now,
      records, sessions, laneNode: this.#laneNode,
    });
    // An unresolved hit is kept as nothing (U9): no seat changes. `by` is the lane's name, cleaned inside noteLimit.
    if (resolved.account === null) return;
    // A pool-owned seat in state "retired" or "logged-out" takes no further hits from a lane (finding 1): the pool's
    // word is final for that account, and no derived mark is made behind it.
    const pool = this.#store.usagePoolSeats().find(s => s.account === resolved.account)?.record ?? null;
    if (pool !== null && (pool.state === "retired" || pool.state === "logged-out")) return;
    this.noteLimit({ account: resolved.account, kind, backAt: null, by: tap.lane ?? "a lane", at });
  }

  // Whether this node runs the account (PR #127, finding 1): a lane record of this node naming it, or a fresh session
  // of it whose lane the fleet's list places on this node.
  #seenOnNode(account: string, node: string, records: readonly LaneRecord[], sessions: readonly FreshSession[]): boolean {
    return records.some(r => r.node === node && r.account === account)
      || sessions.some(s => s.account === account && s.lane !== null && this.#laneNode(s.lane) === node);
  }

  // The pool's own word on a seat (U15): set by a token with the usage-pool scope, cleared by the same or by the
  // principal. One seat notice per change, one back notice per clear.
  poolSeat(a: { account: string; action: "set" | "cleared"; state?: SeatState; why?: SeatWhy | null; backAt: number | null; at: number | null; by: string }): { ok: true } | { ok: false; problem: "bad_account" | "bad_state" } {
    if (!ACCOUNT_NAME.test(a.account)) return { ok: false, problem: "bad_account" };
    if (a.action === "cleared") {
      const prev = this.#store.usagePoolSeats().find(s => s.account === a.account)?.record ?? null;
      if (prev === null) return { ok: true };
      this.#store.atomically(() => {
        this.#store.deleteUsagePoolSeat(a.account);
        this.#note(a.account, "back", `pool|back|${prev.markedAt}`, backNoticeText(a.account, "the pool"));
      });
      this.#tellIfChanged();
      return { ok: true };
    }
    if (a.state === undefined) return { ok: false, problem: "bad_state" };
    // `by` is a reporter's untrusted display text, cleaned before it is stored, like every limit's.
    const by = cleanNote(a.by) ?? "a source";
    const at = a.at ?? this.#now();
    const record = poolSeatOf({ state: a.state, why: a.why ?? null, backAt: a.backAt, at, by });
    const prev = this.#store.usagePoolSeats().find(s => s.account === a.account)?.record ?? null;
    // One seat notice when the state or the why differs from what is already there; no seat yet is a change too.
    const changed = prev === null || prev.state !== record.state || prev.why !== record.why;
    this.#store.atomically(() => {
      this.#store.saveUsagePoolSeat(a.account, record);
      if (changed) this.#note(a.account, "seat", `pool|${record.state}|${record.why}|${at}`, seatNoticeText(a.account, record));
    });
    this.#tellIfChanged();
    return { ok: true };
  }

  // The principal's own clear of a seat (U17): true when something was removed, with one back notice. Without an
  // owner, both the pool's and the derived one go.
  clearSeat(account: string, owner?: "pool" | "derived"): boolean {
    if (!ACCOUNT_NAME.test(account)) return false;
    const pool = owner === undefined || owner === "pool" ? this.#store.usagePoolSeats().find(s => s.account === account)?.record ?? null : null;
    const derived = owner === undefined || owner === "derived" ? this.#store.usageSeats().find(s => s.account === account)?.record ?? null : null;
    if (pool === null && derived === null) return false;
    const now = this.#now();
    this.#store.atomically(() => {
      if (pool !== null) this.#store.deleteUsagePoolSeat(account);
      if (derived !== null) this.#store.deleteUsageSeat(account);
      this.#note(account, "back", `cleared|${now}`, backNoticeText(account, "the principal"));
    });
    this.#tellIfChanged();
    return true;
  }

  // A usage reading a source posts (plan 4.3, U14): the windows it can see now, or the one reason it cannot. The
  // account comes from the header, as with a status line's report; the body's own `source` says who read it.
  reading(body: UsageReadingsBody, accountHeader: string | null, actor: BoardActor): { ok: true } | { ok: false; problem: "bad_account" | "bad_reading" } {
    void actor;      // a reading carries no session; who posted it is the source's own business, not the card's
    const account = (accountHeader ?? "").trim() || DEFAULT_ACCOUNT;
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    if (body.source === "status-line") return { ok: false, problem: "bad_reading" };   // the status line has its own route
    const now = this.#now();
    const node = body.node ?? "";
    // A reading is stamped when its source took it: never later than the hub's clock plus the skew two machines may have.
    const capturedAt = Math.min(body.captured_at * 1000, now + CLOCK_SKEW_MS);
    const row = this.#store.usageSource(account, body.source, node);
    const prev: UsageSourceBody = row?.body ?? { health: noHealth(body.source), reading: null, previous: null, hint: null };
    // The ordering guard (PR #125, finding 2): a reading, good or bad, older than the newest stamp the source ever
    // gave is a late replay. It changes nothing — health, reading, watches, seats and notices all stand — and is answered ok.
    // For ordering alone the stamp is capped at the hub's own clock when it is RECEIVED, and stored that way (R3 on PR
    // #125): a source whose clock runs ahead is ordered as of the receipt, so it never locks out an honest reading that
    // arrives after it (clamping at each later compare would leave the future stamp equal to the hub's clock for ever).
    // What is stored as capturedAt, shown as asOf, keeps the freshness cap of the clock plus the skew.
    const orderingAt = Math.min(body.captured_at * 1000, now);
    const legacy = [prev.health.lastOkAt, prev.health.lastFailAt, prev.reading?.capturedAt ?? null]
      .filter((s): s is number => s !== null).map(s => Math.min(s, now));
    const prevOrdered = prev.orderedAt ?? (legacy.length > 0 ? Math.max(...legacy) : null);
    if (prevOrdered !== null && orderingAt < prevOrdered) return { ok: true };
    const orderedAt = Math.max(prevOrdered ?? orderingAt, orderingAt);
    if (body.failure != null) {
      // A failure keeps the last good reading and its memory; what it says of itself is cleaned before it is stored.
      const health = failedRead(prev.health, capturedAt, reasonOf(body.failure.reason), body.every_s);
      this.#store.saveUsageSource(account, body.source, node, { health, reading: prev.reading, previous: prev.previous, hint: cleanHint(body.failure.hint), orderedAt });
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
    if (list.length === 0) {
      // Nothing readable is a failure the principal sees, not silence (PR #125, finding 4a): the source cannot read
      // its screen, and the hub's own hint says so. The last good reading is kept, as any failure keeps it.
      const health = failedRead(prev.health, capturedAt, "unknown_screen", body.every_s);
      this.#store.saveUsageSource(account, body.source, node, { health, reading: prev.reading, previous: prev.previous, hint: UNREADABLE_HINT, orderedAt });
      this.#tellIfChanged();
      return { ok: false, problem: "bad_reading" };
    }
    const health = okRead(prev.health, capturedAt, body.every_s);
    // `previous` is the sameAsPrevious rule's memory (plan 4.3 item 5): the reading before this one, and when it was
    // taken — the echo rule's line to draw against a status line's last word (PR #125, finding 1).
    const previous = prev.reading === null ? null : { capturedAt: prev.reading.capturedAt, windows: prev.reading.windows.map(w => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt })) };
    this.#store.saveUsageSource(account, body.source, node, { health, reading: { capturedAt, plan: body.plan ?? null, windows: list }, previous, hint: null, orderedAt });
    this.#observe(account, list, capturedAt, body.source, body.plan ?? null, body.lease_id);
    this.#thresholds(account, this.#mergedWindows(this.#baseOf(account, now), this.#store.usageSourcesOf(account), now), now);
    this.#tellIfChanged();
    return { ok: true };
  }

  // An account's own state for a merged pass outside view(): the status line's last word, or the skeleton of an
  // account only sources speak of.
  #baseOf(account: string, now: number): AccountUsage {
    const own = this.#accounts.get(account);
    return own !== undefined ? accountNow(own, now) : this.#skeleton(account, this.#store.usageSourcesOf(account));
  }

  // What one good reading changes: the plan watch, the cycle books, and a seat mark it may end or drop. The
  // thresholds no longer run here: they watch the merged shown windows, after the reading is stored (finding 4b).
  #observe(account: string, windows: readonly WindowReading[], capturedAt: number, source: UsageSource, plan: string | null, leaseId: unknown): void {
    const watches = this.#watchMap(account);
    // The plan watch (plan 4.2): a difference is held, and told only once a later reading agrees with it.
    const fact: PlanFact = {
      plan, identity: null,
      windows: windows.map(w => ({ id: w.id, lengthMins: w.lengthMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt, rolling: w.rolling })),
      // Only the headless usage report lists the account's whole window set, so only a window missing from it is really gone.
      ...(source === "claude-usage" ? { complete: true } : {}),
    };
    const planWatch = (watches.get(`plan|${source}`) as PlanWatch | undefined) ?? noPlanWatch;
    const seen = watchPlan(planWatch, fact, capturedAt);
    this.#store.atomically(() => {
      if (seen.watch !== planWatch) this.#store.saveUsageWatch(account, "plan", source, seen.watch);
      for (const c of seen.told) this.#note(account, "plan", `${changeSignature(c)}|${capturedAt}`, planNoticeText(account, c));
    });
    // A plan or account change the plan watch tells drops the seat the old plan's limit marked (PR #125, finding 3a):
    // a mark from a plan that is gone no longer applies. A pool-owned seat is the pool's, never a reading's, and a
    // mark made after the telling reading was taken stands (PR #125 fix round 2, finding 1a): the change was already
    // observed when the mark landed, so it cannot be what the mark was made under.
    if (seen.told.some(c => c.kind === "name" || c.kind === "account")) {
      const marked = this.#store.usageSeat(account)?.record ?? null;
      if (marked !== null && marked.owner === "derived" && marked.markedAt <= capturedAt) {
        this.#store.atomically(() => {
          this.#store.deleteUsageSeat(account);
          this.#note(account, "back", `reset|${capturedAt}`, seatResetNoticeText(account));
        });
      }
    }
    for (const w of windows) {
      const bookPrev = (watches.get(`cycle|${w.id}`) as CycleBook | undefined) ?? noCycleBook;
      const book = observeCycle(bookPrev, w.resetsAt, capturedAt);
      if (book !== bookPrev) this.#store.saveUsageWatch(account, "cycle", w.id, book);
    }
    // A fresh leased reading of a new cycle is the one thing that ends a seat mark (plan 4.5, U13).
    const seat = this.#store.usageSeat(account)?.record ?? null;
    if (seat !== null) {
      const read: FreshRead = { capturedAt, leased: this.#leaseBook.valid(leaseId, account, source), windows: windows.map(w => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt, lengthMins: w.lengthMins })) };
      if (clearSeat(seat, read).cleared) {
        this.#store.atomically(() => {
          this.#store.deleteUsageSeat(account);
          this.#note(account, "back", `back|${seat.markedAt}`, backNoticeText(account, "a fresh reading"));
        });
      }
    }
  }

  // A seat's limit hit as any source reports it (plan 4.5, U9): one seat record per account, one notice per change.
  // `fix` and `hint` are ignored — the Fix shown always comes from the domain's closed list — and `by` is untrusted
  // display text, cleaned before it is stored (PR #125, finding 3b): nothing an agent token wrote is ever shown raw.
  noteLimit(l: { account: string | null; kind: LimitKind; backAt: number | null; by: string; at: number | null; fix?: unknown; hint?: unknown }): { ok: true; resolved: boolean } | { ok: false; problem: "bad_account" } {
    void l.fix; void l.hint;
    const account = l.account === null ? null : l.account.trim();
    if (account === null || account === "") return { ok: true, resolved: false };
    if (!ACCOUNT_NAME.test(account)) return { ok: false, problem: "bad_account" };
    if (l.kind === "unknown") return { ok: true, resolved: true };      // the account is known, the kind is not: no seat changes (U9)
    const now = this.#now();
    const by = cleanNote(l.by) ?? "a source";       // control characters, links and addresses gone, 40 characters
    // The cycle the hit limited, if any reading of the account names one: the 5-hour window with a reset, else the
    // fullest window shown. One account's view, from its own rows alone (PR #125 fix round 2, finding 3c) — not the
    // whole board's, which nobody asked for here.
    const a = this.#accountView(this.#baseOf(account, now), this.#store.usageSourcesOf(account), this.#store.usageSeat(account)?.record ?? null, now);
    const cycle = this.#cycleOf(a);
    const prev = this.#store.usageSeat(account)?.record ?? null;
    const r = applyLimit(prev, { kind: l.kind, at: l.at ?? now, backAt: l.backAt, by, cycle });
    this.#store.atomically(() => {
      if (r.seat !== null && r.seat !== prev) this.#store.saveUsageSeat(account, r.seat);
      if (r.changed && r.seat !== null)
        this.#note(account, "seat", `${r.seat.state}|${r.seat.why}|${r.seat.markedAt}`, seatNoticeText(account, r.seat));
    });
    this.#tellIfChanged();
    return { ok: true, resolved: true };
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
    const rows = this.#store.usageSourcesOf(account);
    if (source === undefined) {
      const had = rows.length > 0 || this.#accounts.has(account) || this.#store.usageSeat(account) !== null || this.#store.usagePoolSeats().some(s => s.account === account);
      this.#store.deleteUsageSources(account);
      this.#store.deleteUsageWatches(account);
      this.#store.deleteUsageSeat(account);
      this.#store.deleteUsagePoolSeat(account);
      this.#store.deleteUsageAccount(account);
      this.#accounts.delete(account);
      if (had) this.#tellIfChanged();
      return had;
    }
    const any = node === undefined || node === null;
    const existed = rows.some(r => r.source === source && (any || r.node === node));
    this.#store.deleteUsageSources(account, source, any ? undefined : node);
    if (this.#store.usageSourcesOf(account).length === 0) this.#store.deleteUsageWatches(account);
    if (existed) this.#tellIfChanged();
    return existed;
  }

  // The silence and forgetting pass (AT-24): every 60 s from main.ts. A source silent for two weeks is forgotten,
  // with one notice; an account with no sources, no seat and nothing said for two weeks goes too; and a derived out
  // mark past its back time by six hours expires, with one notice (PR #127, finding 3b).
  sweep(): void {
    const now = this.#now();
    this.#store.pruneUsageNotices(NOTICE_KEEP_ROWS, NOTICE_KEEP_MS, now);      // retention (PR #125, finding 5c)
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
      for (const source of gone) this.#note(account, "forgotten", `${source}|${now}`, forgottenNoticeText(account, source as UsageSource));
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
      // The pool's seat goes with the whole account (U15): the pool sets it again if its word still stands.
      this.#store.deleteUsagePoolSeat(a.account);
      this.#accounts.delete(a.account);
      this.#note(a.account, "forgotten", `|${now}`, forgottenNoticeText(a.account, null));
    }
    // A derived out mark whose back time passed more than six hours ago, with no newer limit post to push it out
    // (applyLimit extends backAt), is dropped with one notice (PR #127, finding 3b). The pool's seats are kept
    // elsewhere and never expire by time; neither does a retired or logged-out derived one.
    for (const s of this.#store.usageSeats()) {
      if (!markExpired(s.record, now)) continue;
      this.#store.atomically(() => {
        this.#store.deleteUsageSeat(s.account);
        this.#note(s.account, "back", `expired|${s.record.markedAt}`, seatExpiredNoticeText(s.account));
      });
    }
    this.#tellIfChanged();
  }

  // Every merged shown window of one account fed to its threshold watch (PR #125, finding 4b). The cycle book of the
  // window's own id titles the notice, as the readings that observed the cycle left it.
  #thresholds(account: string, m: MergedView, now: number): void {
    const watches = this.#watchMap(account);
    for (const w of m.shown) {
      const book = (watches.get(`cycle|${w.cycleKey}`) as CycleBook | undefined) ?? noCycleBook;
      this.#threshold(account, w.key, w.usedPercent, w.resetsAt, w.lengthMins, watches, now, book, w.capturedAt);
    }
  }

  // One window's threshold watch (U12): told once per crossing, after two readings at or above the line. The watch
  // stores the capture time of the shown candidate it last counted (PR #125, finding 4b): a value whose time is not
  // later than that is a retried duplicate post or a stale echo, and counts nothing. A body stored in the old shape
  // (the watch alone) reads as time 0, so every fresh reading counts.
  #threshold(account: string, key: string, usedPercent: number | null, resetsAt: number | null, lengthMins: number | null, watches: Map<string, unknown>, now: number, book: CycleBook = noCycleBook, at: number = 0): void {
    const storedRaw = watches.get(`threshold|${key}`);
    const held = storedRaw != null && typeof storedRaw === "object" && "watch" in storedRaw
      ? { watch: (storedRaw as { watch: ThresholdWatch }).watch ?? noThresholdWatch, at: typeof (storedRaw as { at?: unknown }).at === "number" ? (storedRaw as { at?: unknown }).at as number : 0 }
      : { watch: (storedRaw as ThresholdWatch | undefined) ?? noThresholdWatch, at: 0 };
    if (at <= held.at) return;
    const r = watchThreshold(held.watch, usedPercent, resetsAt);
    const body = { watch: r.watch, at };
    this.#store.atomically(() => {
      this.#store.saveUsageWatch(account, "threshold", key, body);
      if (r.told !== null) {
        const title = windowTitle(cadenceOf({ lengthMins, ...cadenceInput(book), family: null }), resetsAt, now);
        this.#note(account, "threshold", `threshold|${key}|${r.told}|${now}`, thresholdNoticeText(account, title, r.told));
      }
    });
    watches.set(`threshold|${key}`, body);
  }

  #watchMap(account: string): Map<string, unknown> {
    return new Map(this.#store.usageWatches(account).map(w => [`${w.kind}|${w.key}`, w.body]));
  }

  // The notices the hub itself writes (plan 4.4): the signature is the once-only key, so the same event told twice —
  // across a restart too — tells nobody. Every word of one comes from the domain, never from an agent token.
  #note(account: string, kind: NoticeKind, signature: string, text: string): void {
    this.#store.saveUsageNotice({ id: `${account}|${kind}|${signature}`, kind, account, at: this.#now(), text }, signature);
    // S4: told once per notice newly inserted (a repeat the store ignored tells nobody), after the write, and never
    // for "forgotten". The exact once-only and kind rules land with the push (round 2).
    this.#onNotice?.(kind);
  }

  #tellIfChanged() {
    // No feed is open: nothing to tell and no view to rebuild (PR #125, finding 5b) — a hub nobody watches keeps its
    // clock for view().
    if (this.#listeners.size === 0) return;
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
