// Application service for the proof of work (ADR-0035; B13 to B15): the brief is the assignee's word, filed as its own
// board action, and its references are checked by the hub, not by the lane. A check is a row of its own, never a change
// of the task (plan 3.4: results are rows, not events, so a re-check never moves the task's `rev`), and it is never
// pushed: a re-check is not a board change. Rows of an older brief or an earlier round are kept in the table, never
// shown.
// Step 3: the checks themselves. The hub reads each reference through the forge port (ports.ts; the adapter holds the
// credential), judges the answer with the domain's pure functions, and stores the row. Triggers ride on the board's own
// events (a move to review, a brief filed), a timer pass re-reads what is still pending or was rate-limited, and a Done
// attempt re-reads first whatever has gone stale — all through `record`, so none of it ever writes a task or an event.
import { MORNDO_REPO, YOUNG_MS, coverageOf, currentBrief, currentList, roundStart, judgeCi, judgePr, parseProofRef, proofOf, type BriefInput, type CoverageItem, type Judged, type ProofBrief, type ProofGate, type ProofMode, type ProofRef, type ProofState, type RefResult, type Task, type TaskActor, type TaskEvent } from "@morndo/domain";
import { redactKeyMaterial } from "@morndo/protocol";
import type { Store } from "../adapters/store.ts";
import { RETRYABLE_DETAIL, type ForgeChecks, type ForgeFailure } from "./ports.ts";
import type { BoardResult, BoardService } from "./board-service.ts";

// What the card shows of one task's proof (B15): the brief that still counts, its rows and the one line. No brief:
// `rev` and `brief` null, the no_brief line.
// `mode`: the gate's mode, so a reader (the panel's Accept button) says only what the gate would do.
export type ProofView = { rev: number | null; brief: ProofBrief | null; results: RefResult[]; mode: ProofMode; standIn: boolean; coverage: CoverageItem[]; state: ProofState };

const AUTO_WINDOW_MS = 3_600_000;
const REQUIRED_CACHE_MS = 10 * 60_000;
const BRIEFS_MAX = 20;
const BRIEFS_LIFETIME_MAX = 200;
const GREEN_HOLD_MS = 3_600_000;

export class ProofService {
  #store: Store;
  #board: BoardService;
  #now: () => number;
  #forge: ForgeChecks | null;
  #mode: ProofMode;
  #allowedRepos: readonly string[];
  #authenticated: boolean;
  #autoPerTask: number;                          // automatic verifications (a brief filed, a review entered, a merge recorded) one task may start an hour
  #autoHub: number;                              // and the whole hub: a lane must not spend the hub's GitHub budget (60 an hour without a token)
  #autoLog = new Map<string, number[]>();
  #autoAll: number[] = [];
  #standIn: boolean;                             // its references are read from a stand-in forge (MORNDO_FORGE_URL), not GitHub
  #chain = new Map<string, Promise<void>>();     // every run for a task, one after another (the timer's included)
  #whole = new Map<string, Promise<void>>();     // a whole-brief check out or waiting: what a refresh joins
  #verifyAll = new Map<string, Promise<void>>(); // the one that re-reads every reference: what a second verify joins
  #running = new Set<Promise<void>>();           // every check begun, for idle()
  #requiredCache = new Map<string, { names: string[]; at: number }>();

  constructor(p: { store: Store; board: BoardService; now?: () => number; forge?: ForgeChecks | null; mode?: ProofMode; allowedRepos?: readonly string[]; authenticated?: boolean; standIn?: boolean; autoBudget?: { perTask?: number; hub?: number } }) {
    this.#store = p.store; this.#board = p.board; this.#now = p.now ?? Date.now;
    this.#forge = p.forge ?? null; this.#mode = p.mode ?? "off";
    this.#allowedRepos = p.allowedRepos ?? [MORNDO_REPO];
    // `authenticated` only picks the timer's cadence (a hub with a credential may ask the forge more often); the checks
    // themselves are the same either way.
    this.#authenticated = p.authenticated ?? false;
    this.#standIn = p.standIn ?? false;
    this.#autoPerTask = p.autoBudget?.perTask ?? 6; this.#autoHub = p.autoBudget?.hub ?? 30;
    this.#board.attachProof({ gate: key => this.gate(key), refresh: key => this.refresh(key) });
    this.#board.onEvent(e => this.onBoardEvent(e));
  }

  // The gate the domain judges a Done and a brief against (B14, B16): the mode, the brief that still counts with its
  // rows, and the repositories the board checks.
  gate(key: string): ProofGate {
    const events = this.#store.taskEvents(key);
    const list = currentList(events);
    const current = currentBrief(events);
    if (current === null) return { mode: this.#mode, brief: null, results: [], allowedRepos: this.#allowedRepos, list };
    return { mode: this.#mode, brief: current.brief, results: this.#store.proofResultsOf(key, current.rev), allowedRepos: this.#allowedRepos, list };
  }

  // A brief, filed as its own board action (B13): the board judges who may file it, its words and its references, so a
  // refused brief writes nothing and seeds nothing. Every text field loses key material first, before it is judged and
  // stored (plan 3.8); the references are typed values, not prose, and pass as they are.
  async file(key: string, input: BriefInput, actor: TaskActor): Promise<BoardResult> {
    // Bounded: each brief is an event and up to 8 rows to check, so a lane takes at most BRIEFS_MAX of them in a round of
    // work; the assigner's are not counted (a lane must not be able to spend a limit that stops the Done's own brief).
    const events = this.#store.taskEvents(key);
    const since = roundStart(events);
    // And over its whole life: a lane may start a new round itself, so the round's count alone could be cycled.
    const lane = actor.kind === "worker" ? events.filter(e => e.change.kind === "briefed" && e.actor.kind === "worker") : [];
    if (actor.kind === "worker" && (lane.filter(e => e.rev > since).length >= BRIEFS_MAX || lane.length >= BRIEFS_LIFETIME_MAX))
      return { ok: false, problem: "too_many", detail: "briefs on this task" };
    const brief: BriefInput = {
      summary: redactKeyMaterial(input.summary),
      leftOut: redactKeyMaterial(input.leftOut),
      limits: redactKeyMaterial(input.limits),
      ...(input.decisions !== undefined ? { decisions: redactKeyMaterial(input.decisions) } : {}),
      ...(input.noCode !== undefined ? { noCode: redactKeyMaterial(input.noCode) } : {}),
      ...(input.refs !== undefined ? { refs: [...input.refs] } : {}),
      ...(input.attested !== undefined ? { attested: input.attested.map(a => ({ kind: a.kind, how: redactKeyMaterial(a.how) })) } : {}),
    };
    const r = await this.#board.actChecked(key, { action: "brief", brief }, actor);
    // Seeded after the event, outside its transaction: a reference with no row is read as pending by proofOf, so a
    // crash between the two leaves the same picture, and the seed's INSERT OR IGNORE keeps a row that exists standing.
    if (r.ok && r.event.change.kind === "briefed") {
      this.#store.seedProofs(key, r.event.rev, r.event.change.brief.refs, this.#now());
      if (this.#autoAllowed(key)) void this.verify(key);       // a filed brief is checked at once, in the background (within the allowance)
    }
    return r;
  }

  // The task's proof as it stands (null: no such task): the brief that still counts (currentBrief; one from before the
  // last review-to-doing move is stale) with its rows and its one line.
  view(key: string): ProofView | null {
    if (this.#store.task(key) === null) return null;
    const events = this.#store.taskEvents(key);
    const list = currentList(events);
    const current = currentBrief(events);
    const merges = this.#mergesAsOf(key);
    if (current === null) {
      const coverage = coverageOf(list, null, []);
      return { rev: null, brief: null, results: [], mode: this.#mode, standIn: this.#standIn, coverage, state: proofOf(null, [], merges, list) };
    }
    const results = this.#store.proofResultsOf(key, current.rev);
    const coverage = coverageOf(list, current.brief, results);
    return { rev: current.rev, brief: current.brief, results, mode: this.#mode, standIn: this.#standIn, coverage, state: proofOf(current.brief, results, merges, list) };
  }

  // The one line per task in review (B15), for the board view the agents read: keyed by task, `no brief` included, so
  // a glance at the board says which reviews hold something to check. Tasks in any other state are absent.
  lines(tasks: readonly Task[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of tasks) {
      if (t.status !== "review") continue;
      const v = this.view(t.key);
      if (v !== null) out[t.key] = v.state.line;
    }
    return out;
  }

  // One reference's state, as a row: never the task, never an event, never a push. Stored only for the brief that
  // still counts and only for a reference it holds; a result for a stale round or a ref the brief does not hold is
  // ignored and writes nothing, so a slow check cannot judge a round it was not asked about. The rows of a round that
  // is over stay as that round's history.
  record(key: string, briefRev: number, result: RefResult): boolean {
    if (!this.#writable(key, briefRev, result.ref)) return false;
    this.#store.saveProofResult(key, briefRev, result);
    return true;
  }

  // Whether a row may be written at all: not for a Done task (a snapshot: a check in flight at the Done writes nothing),
  // and only for the brief that still counts and a reference it holds. Every write to a proof row goes through this.
  #writable(key: string, briefRev: number, ref: string): boolean {
    if (this.#store.task(key)?.status === "done") return false;
    const current = currentBrief(this.#store.taskEvents(key));
    return current !== null && current.rev === briefRev && current.brief.refs.includes(ref);
  }

  // Every reference of the current brief, checked now (no forge: returns at once). Never rejects: a check that throws
  // is a row of none, never a refusal someone sees. One verify per task at a time: a second call while one runs waits
  // for that one — the move to review and the filing of a brief land together, and both would read the same refs twice.
  verify(key: string): Promise<void> {
    const out = this.#verifyAll.get(key);
    if (out !== undefined) return out;
    return this.#serialize(key, () => this.#check(key, brief => [...brief.brief.refs]), { whole: true, all: true });
  }

  // Like verify, but only the references whose stored result is older than `maxAgeMs` (a pending seed counts by its
  // checkedAt like any row). The Done gate's own re-read: fresh results are trusted, stale ones re-asked. A whole-brief
  // check already out re-reads at least what is stale, so it is joined rather than doubled.
  refresh(key: string, maxAgeMs = 30_000): Promise<void> {
    const out = this.#whole.get(key);
    if (out !== undefined) return out;
    return this.#serialize(key, () => {
      const now = this.#now();
      return this.#check(key, (brief, rows) => brief.brief.refs.filter(ref => now - (rows.get(ref)?.checkedAt ?? -Infinity) >= maxAgeMs));
    }, { whole: true });
  }

  // What the board's own events trigger (B14): a task that reaches review — by the board's D1, by hand, by anyone — is
  // verified in the background. The event is the whole trigger: no Run is read here.
  onBoardEvent(e: TaskEvent): void {
    if ((e.change.kind === "moved" && e.change.to === "review") || (e.change.kind === "created" && e.change.status === "review"))
      if (this.#autoAllowed(e.key)) void this.verify(e.key);
    // A merge record changes what a pull request reference means; re-read after any check already queued (not joined to verifyAll).
    if ((e.change.kind === "merged" || e.change.kind === "unmerged") && this.#autoAllowed(e.key))
      void this.#serialize(e.key, () => this.#check(e.key, brief => [...brief.brief.refs]));
  }

  // The timer pass: the tasks in review, by the board's own number, get their due references re-read — those still
  // pending, or unfetchable for a reason that passes (a rate limit, a timeout, the network down). A green, red,
  // mismatch or missing reference is never re-read here, nor any reason that will not change by asking again. Returns
  // how many references were re-read.
  async tick(): Promise<number> {
    const now = this.#now();
    const due: { key: string; refs: string[] }[] = [];
    for (const task of this.#store.tasksIn("review")) {
      const current = currentBrief(this.#store.taskEvents(task.key));
      if (current === null) continue;
      const briefAt = this.#store.taskEvents(task.key).find(e => e.change.kind === "briefed" && e.rev === current.rev)?.at ?? now;
      // A brief fresh in review is watched closely (2 minutes with a credential, 10 without); an hour past its filing,
      // half-hourly is enough — the card says what the last pass saw.
      const interval = now - briefAt < 60 * 60_000 ? (this.#authenticated ? 2 : 10) * 60_000 : 30 * 60_000;
      const rows = new Map(this.#store.proofResultsOf(task.key, current.rev).map(r => [r.ref, r] as const));
      const refs = current.brief.refs.filter(ref => {
        const row = rows.get(ref);
        // A ref with no row reads as pending (proofOf) and is due at once, like one whose check never landed.
        if (row === undefined) return true;
        if (row.state !== "pending" && !(row.state === "unfetchable" && RETRYABLE_DETAIL.test(row.detail ?? ""))) return false;
        return now - row.checkedAt >= interval;
      });
      if (refs.length > 0) due.push({ key: task.key, refs });
    }
    let checked = 0;
    await Promise.all(due.slice(0, 12).map(({ key, refs }) =>
      this.#serialize(key, () => { checked += refs.length; return this.#check(key, () => refs); })));
    return checked;
  }

  // Resolves once no check is running (the stop path waits for the checks in flight, not for the timer).
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  // One checking run for `key`: the current brief's references as `pick` selects them, asked of the forge (at most 10
  // asks out at once — an unauthenticated forge answers 60 an hour), each answer a row through `record`.
  async #check(key: string, pick: (brief: { brief: ProofBrief; rev: number; at: number }, rows: ReadonlyMap<string, RefResult>) => readonly string[]): Promise<void> {
    if (this.#forge === null) return;
    if (this.#store.task(key)?.status === "done") return;              // a Done task is a snapshot: no check, no new row
    const events = this.#store.taskEvents(key);
    const current = currentBrief(events);
    if (current === null) return;
    const briefAt = events.find(e => e.change.kind === "briefed" && e.rev === current.rev)?.at ?? 0;
    const rows = new Map(this.#store.proofResultsOf(key, current.rev).map(r => [r.ref, r] as const));
    const young = this.#now() - briefAt < YOUNG_MS;
    // Task data never widens what the hub may read: only configured repositories are asked, not merge records.
    const allowed = new Set(this.#allowedRepos.map(r => r.toLowerCase()));
    const merges = this.#mergesAsOf(key);
    const refs = pick({ brief: current.brief, rev: current.rev, at: briefAt }, rows);
    if (refs.length === 0) return;
    let next = 0;
    const ask = async () => { while (next < refs.length) await this.#checkOne(key, current.rev, refs[next++]!, allowed, young, merges); };
    await Promise.all(Array.from({ length: Math.min(10, refs.length) }, ask));
  }

  async #checkOne(key: string, briefRev: number, ref: string, allowed: ReadonlySet<string>, young: boolean, merges: readonly { repo: string; sha: string }[]): Promise<void> {
    const parsed = parseProofRef(ref);
    if (!parsed.ok) return;                        // a stored ref always parses; anything else writes nothing
    const judged = await this.#ask(parsed.value, allowed, young, merges);
    // A fresh green stands against a later failure to reach the forge (a rate limit, a timeout): a lane that spends the budget
    // must not be able to turn true greens into unfetchable ones at the Done.
    const held = this.#store.proofResultsOf(key, briefRev).find(r => r.ref === ref);
    if (held?.state === "green" && judged.state === "unfetchable" && RETRYABLE_DETAIL.test(judged.detail ?? "") && this.#now() - held.checkedAt < GREEN_HOLD_MS) {
      if (!this.#writable(key, briefRev, ref)) return;               // the same guards as record(): a Done task's row is not touched
      // Held, not refreshed: checkedAt stays the last real read (so it ages and is asked again), and the row says so.
      const at = new Date(held.checkedAt).toISOString().slice(11, 16);
      this.#store.saveProofResult(key, briefRev, { ...held, detail: `last read ${at} UTC; the forge could not be reached since` });
      return;
    }
    this.record(key, briefRev, { ref, state: judged.state, detail: judged.detail, checkedAt: this.#now() });
  }

  // One reference, asked and judged. A repository outside the allowlist is never asked (unread, not unfetched); a forge
  // failure is unfetchable with its detail; anything thrown is a network error. Nothing here reaches a task.
  async #ask(ref: ProofRef, allowed: ReadonlySet<string>, young: boolean, merges: readonly { repo: string; sha: string }[]): Promise<Judged> {
    const forge = this.#forge;
    if (forge === null || !allowed.has(ref.repo.toLowerCase())) return { state: "unfetchable", detail: "repository not checked" };
    try {
      if (ref.kind === "pr") {
        const answer = await forge.pullRequest(ref.repo, ref.number);
        if (!answer.ok) return this.#unread(answer.failure);
        const checks = await forge.checkRuns(ref.repo, ref.sha);
        if (!checks.ok) return this.#unread(checks.failure);
        const required = await this.#requiredChecks(ref.repo, answer.value.baseRef);
        return judgePr(ref, answer.value, merges, { runs: checks.value, young, required });
      }
      const answer = await forge.checkRuns(ref.repo, ref.sha);
      return answer.ok ? judgeCi(ref, answer.value, young) : this.#unread(answer.failure);
    } catch {
      return { state: "unfetchable", detail: "network error" };
    }
  }

  // The allowance for automatic verifications: a task and the hub each get so many an hour; what is not verified now waits
  // for the timer's pass (its own cadence), so a lane filing briefs in a loop slows nobody but itself.
  #autoAllowed(key: string): boolean {
    const now = this.#now();
    const fresh = (t: number) => now - t < AUTO_WINDOW_MS;
    const mine = (this.#autoLog.get(key) ?? []).filter(fresh);
    this.#autoAll = this.#autoAll.filter(fresh);
    this.#autoLog.set(key, mine);
    if (mine.length >= this.#autoPerTask || this.#autoAll.length >= this.#autoHub) return false;
    mine.push(now); this.#autoAll.push(now);
    return true;
  }

  // The task's merge records as the rules read them: live while the task is open, and as they stood at the Done once it
  // is done, so a merge recorded afterwards cannot change the card of what was accepted.
  #mergesAsOf(key: string): { repo: string; sha: string }[] {
    const task = this.#store.task(key);
    if (task?.status !== "done") return this.#store.mergesOf(key).map(m => ({ repo: m.repo, sha: m.sha }));
    // Done: replay the record up to the Done event (the table holds what stands now, a clock cannot order same-moment events).
    const events = this.#store.taskEvents(key);
    const doneRev = events.reduce((n, e) => (e.change.kind === "moved" && e.change.to === "done" && e.rev > n ? e.rev : n), 0);
    const held = new Map<string, { repo: string; sha: string }>();
    for (const e of events) {
      if (e.rev >= doneRev) break;
      if (e.change.kind === "merged") held.set(`${e.change.repo.toLowerCase()}|${e.change.sha}`, { repo: e.change.repo, sha: e.change.sha });
      if (e.change.kind === "unmerged") held.delete(`${e.change.repo.toLowerCase()}|${e.change.sha}`);
    }
    return [...held.values()];
  }

  // The checks a base branch requires, for a pull request reference (the manager's narrowing, T-450): read once per repository
  // and branch for REQUIRED_CACHE_MS, successes only. null means unreadable (no base branch known, or the forge failed): the
  // caller then counts every check, so a read that fails can only hold a Done, never let one through.
  async #requiredChecks(repo: string, baseRef: string | null): Promise<string[] | null> {
    if (baseRef === null) return null;
    const key = `${repo.toLowerCase()}|${baseRef}`;
    const now = this.#now();
    const cached = this.#requiredCache.get(key);
    if (cached !== undefined && now - cached.at < REQUIRED_CACHE_MS) return cached.names;
    const forge = this.#forge;
    if (forge === null) return null;
    const answer = await forge.requiredChecks(repo, baseRef);
    if (!answer.ok) return null;
    this.#requiredCache.set(key, { names: answer.value, at: now });
    return answer.value;
  }

  // A forge failure as a row. Without a credential the forge answers 404 for a private repository as it does for one that
  // does not exist, so a "not found" there is "not checked" (neither red nor unfetchable; no retry will change it); with
  // a credential it is a plain unfetchable, because then the hub could have seen it.
  #unread(failure: ForgeFailure): Judged {
    if (failure.reason === "not_found" && !this.#authenticated)
      return { state: "not_checked", detail: "private repo: not checked (404 without a token)" };
    return { state: "unfetchable", detail: failure.detail };
  }

  // One run per task at a time, in a chain; a run never rejects (verify never does), and every run is tracked until it
  // ends, which is what idle() waits for. `join`: the run is remembered as the task's whole-brief check (a refresh
  // joins it) and, `all`, as its full verify (a second verify joins that).
  #serialize(key: string, run: () => Promise<void>, join: { whole?: boolean; all?: boolean } = {}): Promise<void> {
    const prior = this.#chain.get(key) ?? Promise.resolve();
    const mine = prior.then(run, run);             // the run before it ends first; its outcome never blocks the next
    const end = mine.then(() => {}, () => {});
    if (join.whole) this.#whole.set(key, end);
    if (join.all) this.#verifyAll.set(key, end);
    this.#chain.set(key, end);
    this.#running.add(end);
    void end.then(() => {
      this.#running.delete(end);
      for (const m of [this.#chain, this.#whole, this.#verifyAll]) if (m.get(key) === end) m.delete(key);
    });
    return end;
  }
}
