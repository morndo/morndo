// The account pool's service (ADR-0029): it loads the Pool of a runtime, applies one domain function, saves on the version it
// read, and retries a lost save up to 8 times, as LeaseService does. It decides nothing the domain does not: which member runs
// a turn is `place`, one writer per session and one turn per account are `claim`. What it adds is the Connection gate (a member's
// Connection must be on, acknowledged at the current terms, and a subscription of the runtime) and the words of a refusal.
import {
  activateMember, addMember, bindSession, claim, err, findConnection, markOut, noteMoveBy, noteResetAdvised, noteResetSpent, ok, place,
  placeSession, recordReading, refuse, release, removeMember, resetAdvice, retireMember, seats, setMode, setSettings,
  type Advice, type Directory, type Holder, type MemberSettings, type MoveBy, type Placement, type Pool, type PoolSettings, type Reading,
  type Result, type Seat, type SeatState,
} from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { Catalog, Clock, ConnectionStore, PoolStore, Processes } from "./ports.ts";

export type PoolDeps = { clock: Clock; store: PoolStore; connections: ConnectionStore; catalog: Catalog; processes: Processes };

export type TurnStart = {
  runtime: string; claimId: string; session: string | null; pin: string | null; dir: string; night: boolean;
  model: string | null; holder: Holder;
};
export type TurnBegun = { member: string; configDir: string; claimId: string; moved: { from: string; why: SeatState } | null; continueBy: MoveBy | null };
export type TurnEnd =
  | { kind: "done" } | { kind: "auth" } | { kind: "unreadable" } | { kind: "other" }
  | { kind: "usage-limit"; resetAt: number | null; model: string | null };
// Why a call was refused, by kind, so a caller never has to read the words. exit 75 is a gate refusal (the member's Connection
// says no), 1 anything else; as `run` exits.
//   busy: the member has a turn running (PL13); session-busy: another holder writes the session (PL7);
//   unavailable: the member is out, low, signed out or retired; no-seat: no member could take the turn;
//   no-default: pinned mode and no pin; gate: the member's Connection; input: a request that makes no sense.
export type PoolWhy =
  | { kind: "busy"; member: string }
  | { kind: "session-busy"; holder: Holder }
  | { kind: "unavailable"; member: string; state: SeatState; backAt: number | null }
  | { kind: "no-seat"; backAt: number | null }
  | { kind: "no-default" }
  | { kind: "gate"; member: string }
  | { kind: "input" };
export type PoolRefusal = PoolWhy & { problem: string; exit: 1 | 75 };
export type EndOptions = { at?: number; dir?: string | null; night?: boolean; tried?: readonly string[] };
type Ended = { next: TurnBegun | null; refusal: PoolRefusal | null };

const ATTEMPTS = 8;
const HOUR = 3_600_000;
const SAME_REFUSAL_MS = 300_000;
const ADVICE_REPEAT_MS = 24 * HOUR;
const NO_DEFAULT = "no default member: set one with morndo-keys pool set defaultMember <name>";
export const NO_FREE_SEAT = "no pool account is free";

const refusal = (why: PoolWhy, problem: string, exit: 1 | 75 = 1): PoolRefusal => ({ ...why, problem, exit });
const refused = (why: PoolWhy, problem: string, exit: 1 | 75 = 1): Result<never, PoolRefusal> => err(refusal(why, problem, exit));
const input = (problem: string): Result<never, PoolRefusal> => refused({ kind: "input" }, problem);
const busy = (member: string): PoolRefusal => refusal({ kind: "busy", member }, `${member} is busy`);
const stateWords: Record<SeatState, string> = { "logged-out": "signed out", retired: "retired", out: "out", low: "low", ok: "ok" };

export class PoolService {
  readonly #deps: PoolDeps;
  constructor(deps: PoolDeps) { this.#deps = deps; }

  add(runtime: string, connection: string, settings: MemberSettings): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now, directory) => {
      const row = findConnection(directory, connection);
      if (!row || row.status === "revoked") return { pool, result: input(`no such connection: ${connection}`) };
      if (row.custody !== "morndo" || row.kind !== "subscription" || row.runtime !== runtime) {
        return { pool, result: input("a pool member is a subscription of its runtime") };
      }
      if (row.configDir === null) return { pool, result: input("a pool member needs its own --config-dir") };
      const added = addMember(pool, connection, settings, now);
      return added.ok ? { pool: added.value, result: ok(undefined) } : { pool, result: input(`${connection} is already a pool member`) };
    });
  }

  remove(runtime: string, member: string): Result<void, PoolRefusal> {
    return this.#member(runtime, member, (pool, now) => removeMember(pool, member, now));
  }

  retire(runtime: string, member: string, why: string): Result<void, PoolRefusal> {
    return this.#member(runtime, member, (pool, now) => retireMember(pool, member, why, now));
  }

  activate(runtime: string, member: string): Result<void, PoolRefusal> {
    return this.#member(runtime, member, (pool, now) => activateMember(pool, member, now));
  }

  setSettings(runtime: string, change: Partial<Omit<PoolSettings, "mode">>, by: string | null): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const next = setSettings(pool, change, by, now);
      if (next.ok) return { pool: next.value, result: ok(undefined) };
      const words = { "needs-principal": "this setting needs --by: who decided it", "unknown-member": "no such pool member", "bad-value": "that value is not allowed" };
      return { pool, result: input(words[next.error]) };
    });
  }

  setMode(runtime: string, mode: "pinned" | "rotate", by: string | null): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const next = setMode(pool, mode, by, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool, result: input("rotation needs --by: who decided it") };
    });
  }

  // The principal's move: the session is placed on `to`, pinned there.
  move(runtime: string, session: string, to: string, by: string): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      if (by.trim() === "") return { pool, result: input("a move needs --by: who decided it") };
      if (!pool.members.some(m => m.name === to)) return { pool, result: input(`no such pool member: ${to}`) };
      return { pool: placeSession(pool, session, to, true, now), result: ok(undefined) };
    });
  }

  // A claim with no session, for a read of the account (PL13): nothing is placed.
  hold(runtime: string, member: string, claimId: string, holder: Holder): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      if (!pool.members.some(m => m.name === member)) return { pool, result: input(`no such pool member: ${member}`) };
      const held = claim(pool, { id: claimId, session: null, member, holder, pinned: true }, h => this.#deps.processes.alive(h), now);
      if (held.ok) return { pool: held.value, result: ok(undefined) };
      return { pool, result: held.error.problem === "member-busy" ? err(busy(held.error.member)) : refused({ kind: "session-busy", holder: held.error.holder }, "session-busy") };
    });
  }

  release(runtime: string, claimId: string): void {
    this.#change(runtime, (pool, now) => ({ pool: release(pool, claimId, now), result: ok(undefined) }));
  }

  spent(runtime: string, member: string, by: string, outcome: string): void {
    this.#change(runtime, (pool, now) => ({ pool: noteResetSpent(pool, member, by, outcome, now), result: ok(undefined) }));
  }

  // PL4, PL6, PL7, PL13 in one versioned save: the member that runs the turn, and its claim. The placement itself moves only when
  // the turn starts (`started`), so a claim that is released first leaves the session where it was. In rotate mode a new or moved
  // session whose chosen member is busy tries the next free one; a placed session waits for its own member instead.
  begin(start: TurnStart): Result<TurnBegun, PoolRefusal> {
    return this.#change(start.runtime, (pool, now, directory) => {
      const gate = this.#gate(pool, directory);
      const view = withRetired(pool, gate, now);
      const placed = start.session === null ? undefined : pool.placements.find(x => x.session === start.session);
      const skip: string[] = [];
      let lastBusy: string | null = null;
      for (;;) {
        const answer = place(view, { session: start.session, pin: start.pin, dir: start.dir, night: start.night, model: start.model, skip }, now);
        if (!answer.ok) {
          if (answer.problem === "no-default") return { pool, result: refused({ kind: "no-default" }, NO_DEFAULT) };
          if (answer.problem === "unknown-member") return { pool, result: input(`no such pool member: ${start.pin ?? placed?.member ?? ""}`) };
          if (answer.problem === "member-unavailable") {
            const why = gate.get(answer.member);
            if (why !== undefined) return { pool, result: refused({ kind: "gate", member: answer.member }, why, 75) };
            const problem = `member ${answer.member} is ${stateWords[answer.state]}`;
            return { pool: noteRefusal(pool, start.session, problem, now), result: refused({ kind: "unavailable", member: answer.member, state: answer.state, backAt: answer.backAt }, problem) };
          }
          if (lastBusy !== null) return { pool: noteRefusal(pool, start.session, `${lastBusy} is busy`, now), result: err(busy(lastBusy)) };
          return { pool: noteRefusal(pool, start.session, NO_FREE_SEAT, now), result: refused({ kind: "no-seat", backAt: answer.problem === "no-seat" ? answer.backAt : null }, NO_FREE_SEAT) };
        }
        const pinned = placed?.pinned ?? (start.pin !== null || pool.settings.mode === "pinned");
        const claimed = claim(pool, { id: start.claimId, session: start.session, member: answer.member, holder: start.holder, pinned }, h => this.#deps.processes.alive(h), now);
        if (!claimed.ok) {
          if (claimed.error.problem === "session-busy") return { pool, result: refused({ kind: "session-busy", holder: claimed.error.holder }, "session-busy") };
          if (pool.settings.mode === "rotate" && !pinned && (placed === undefined || answer.moved !== null)) {
            skip.push(answer.member);
            lastBusy = claimed.error.member;
            continue;
          }
          return { pool: noteRefusal(pool, start.session, `${claimed.error.member} is busy`, now), result: err(busy(claimed.error.member)) };
        }
        const continueBy = answer.moved === null ? null : pool.settings.moveBy;
        return { pool: claimed.value, result: ok({ member: answer.member, configDir: this.#configDir(directory, answer.member), claimId: start.claimId, moved: answer.moved, continueBy }) };
      }
    });
  }

  // The turn is running: a known session is now placed on the claim's member, as the claim is pinned. A first turn's session
  // is placed when the runtime names it (`bind`).
  started(runtime: string, claimId: string): void {
    this.#change(runtime, (pool, now) => {
      const held = pool.claims.find(c => c.id === claimId);
      if (!held || held.session === null) return { pool, result: ok(undefined) };
      return { pool: placeSession(pool, held.session, held.member, held.pinned, now), result: ok(undefined) };
    });
  }

  // A first turn's claim binds to the session the runtime names (PL7), and places it, pinned as the claim is.
  bind(runtime: string, claimId: string, session: string): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const bound = bindSession(pool, claimId, session, h => this.#deps.processes.alive(h), now);
      if (bound.ok) return { pool: bound.value, result: ok(undefined) };
      return { pool, result: bound.error.problem === "session-busy" ? refused({ kind: "session-busy", holder: bound.error.holder }, "session-busy") : err(busy(bound.error.member)) };
    });
  }

  // The turn ended. Released always; a usage limit marks the member; and the next member to go on comes back (rotate mode,
  // a claim that is not pinned) or the same member again for a handoff (PL8, PL14). The choice keeps the turn's directory and
  // night reserve, and leaves out the members that already ran this turn (`tried`). A next member that is busy is told as busy.
  end(runtime: string, claimId: string, end: TurnEnd, options: EndOptions = {}): { next: TurnBegun | null; refusal: PoolRefusal | null } {
    const done = this.#change<Ended>(runtime, (pool, clockNow, directory) => {
      const now = options.at ?? clockNow;
      const held = pool.claims.find(c => c.id === claimId);
      if (!held) return { pool, result: ok({ next: null, refusal: null }) };
      let p = pool;
      if (end.kind === "usage-limit") p = markOut(p, held.member, end.resetAt, "usage limit", now, end.model);
      if (end.kind === "auth") {
        const last = p.readings[held.member];
        // Its identity, windows and marks stay; a reading without an identity would look like a new account and drop the marks.
        p = recordReading(p, { ...(last ?? signedOut(held.member)), signedIn: false, allowed: null, at: now }, now);
      }
      if (end.kind === "unreadable") p = noteMoveBy(p, "handoff", "pool", "the conversation can't be read under another account", now);
      p = release(p, claimId, now);
      if (end.kind === "unreadable") return this.#again(p, directory, held.member, held.session, held.holder, `${claimId}>retry`, now);
      if (end.kind !== "usage-limit") return { pool: p, result: ok({ next: null, refusal: null }) };
      if (p.settings.mode !== "rotate" || held.pinned) {
        const backAt = seats(p, now, end.model).find(s => s.member === held.member)?.backAt ?? null;
        return { pool: p, result: ok({ next: null, refusal: refusal({ kind: "unavailable", member: held.member, state: "out", backAt }, `member ${held.member} is out`) }) };
      }
      const view = withRetired(p, this.#gate(p, directory), now);
      const skip = [...(options.tried ?? [])];
      let lastBusy: string | null = null;
      for (;;) {
        const answer = place(view, { session: held.session, pin: null, dir: options.dir ?? null, night: options.night ?? false, model: end.model, skip }, now);
        if (!answer.ok) {
          const why = lastBusy !== null ? busy(lastBusy) : refusal({ kind: "no-seat", backAt: answer.problem === "no-seat" ? answer.backAt : null }, NO_FREE_SEAT);
          return { pool: p, result: ok({ next: null, refusal: why }) };
        }
        const id = `${claimId}>${answer.member}`;
        const taken = claim(p, { id, session: held.session, member: answer.member, holder: held.holder, pinned: false }, h => this.#deps.processes.alive(h), now);
        if (!taken.ok) { skip.push(answer.member); lastBusy = answer.member; continue; }
        const next: TurnBegun = { member: answer.member, configDir: this.#configDir(directory, answer.member), claimId: id, moved: answer.moved, continueBy: p.settings.moveBy };
        return { pool: taken.value, result: ok({ next, refusal: null }) };
      }
    });
    return done.ok ? done.value : { next: null, refusal: done.error };
  }

  record(runtime: string, reading: Reading): void {
    this.#change(runtime, (pool, now) => ({ pool: recordReading(pool, reading, now), result: ok(undefined) }));
  }

  list(runtime: string): { settings: PoolSettings; seats: Seat[]; placements: readonly Placement[] } {
    const { pool } = this.#deps.store.load(runtime);
    return { settings: pool.settings, seats: seats(pool, this.#deps.clock.now()), placements: pool.placements };
  }

  // The members that can run a turn now: their Connection passes the gate, they are not retired, and their last reading says
  // signed in. The engine layer's probe asks this.
  usable(runtime: string): string[] {
    const { pool } = this.#deps.store.load(runtime);
    const { directory } = this.#deps.connections.load();
    const gate = this.#gate(pool, directory);
    return pool.members.filter(m => m.retired === null && !gate.has(m.name) && pool.readings[m.name]?.signedIn === true).map(m => m.name);
  }

  // What the pool would say now, without writing anything: a look. Waiting work is the distinct sessions refused in the last hour.
  advice(runtime: string): Advice | null {
    const { pool } = this.#deps.store.load(runtime);
    return adviceOf(pool, this.#deps.clock.now());
  }

  // The advice for a notice: only the first time in a day for a member and reason, and that is recorded, so the notice does not
  // repeat. A look (`advice`) never records, so it can't use up a notice.
  adviceOnce(runtime: string): Advice | null {
    const out = this.#change<Advice | null>(runtime, (pool, now) => {
      const advised = adviceOf(pool, now);
      if (!advised) return { pool, result: ok(null) };
      const again = pool.events.some(e => e.type === "ResetAdvised" && e.member === advised.member && e.reason === advised.reason && now - e.at < ADVICE_REPEAT_MS);
      return again ? { pool, result: ok(null) } : { pool: noteResetAdvised(pool, advised, now), result: ok(advised) };
    });
    return out.ok ? out.value : null;
  }

  // The same member again, newly claimed (a handoff, PL14).
  #again(p: Pool, directory: Directory, member: string, session: string | null, holder: Holder, id: string, now: number): { pool: Pool; result: Result<Ended, PoolRefusal> } {
    const taken = claim(p, { id, session, member, holder, pinned: true }, h => this.#deps.processes.alive(h), now);
    if (!taken.ok) return { pool: p, result: ok({ next: null, refusal: busy(member) }) };
    const next: TurnBegun = { member, configDir: this.#configDir(directory, member), claimId: id, moved: null, continueBy: "handoff" };
    return { pool: taken.value, result: ok({ next, refusal: null }) };
  }

  #member(runtime: string, member: string, step: (pool: Pool, now: number) => Result<Pool, "missing">): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const next = step(pool, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool, result: input(`no such pool member: ${member}`) };
    });
  }

  // Why a member's Connection can't run a turn now, by member name; a member without a reason is usable.
  #gate(pool: Pool, directory: Directory): Map<string, string> {
    const why = new Map<string, string>();
    for (const m of pool.members) {
      const row = findConnection(directory, m.name);
      const preset = row ? findPreset(this.#deps.catalog, row.vendor) : null;
      let reason: string | null = null;
      if (!row || row.status === "revoked") reason = `member ${m.name} is revoked`;
      else if (row.status === "off") reason = `member ${m.name} is off`;
      else if (row.custody !== "morndo" || row.kind !== "subscription" || row.runtime !== pool.runtime) reason = `member ${m.name} is not a subscription of ${pool.runtime}`;
      else if (row.configDir === null) reason = `member ${m.name} needs its own --config-dir`;
      else if (row.terms === null) reason = `member ${m.name} has no terms acknowledgement`;
      else if (!preset || row.terms.revision !== preset.terms.revision) reason = `member ${m.name} has not acknowledged the current terms`;
      if (reason !== null) why.set(m.name, reason);
    }
    return why;
  }

  #configDir(directory: Directory, member: string): string {
    const row = findConnection(directory, member);
    return row?.custody === "morndo" && row.kind === "subscription" && row.configDir !== null ? row.configDir : "";
  }

  // Load, apply one step, save on the version read; a lost save starts over.
  #change<T>(runtime: string, step: (pool: Pool, now: number, directory: Directory) => { pool: Pool; result: Result<T, PoolRefusal> }): Result<T, PoolRefusal> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { pool, version } = this.#deps.store.load(runtime);
      const { directory } = this.#deps.connections.load();
      const out = step(pool, this.#deps.clock.now(), directory);
      if (out.pool === pool || this.#deps.store.save(out.pool, version)) return out.result;
    }
    return input("the pool changed under this call; try again");
  }
}

// The pool as place() should see it: members whose Connection can't run a turn are retired in this view only, never saved.
function withRetired(pool: Pool, gate: ReadonlyMap<string, string>, now: number): Pool {
  let view = pool;
  for (const [name, why] of gate) {
    const next = retireMember(view, name, why, now);
    if (next.ok) view = next.value;
  }
  return view;
}

// A refused turn, noted once for the same session and problem within a few minutes, so a waiting turn that tries again does
// not fill the pool's events.
function noteRefusal(pool: Pool, session: string | null, problem: string, now: number): Pool {
  const same = pool.events.some(e => e.type === "TurnRefused" && e.session === session && e.problem === problem && now - e.at < SAME_REFUSAL_MS);
  return same ? pool : refuse(pool, session, problem, now);
}

function signedOut(member: string): Reading {
  return { member, at: 0, signedIn: false, identity: null, plan: null, paid: null, windows: [], allowed: null, credits: null };
}

function adviceOf(pool: Pool, now: number): Advice | null {
  const recent = pool.events.filter(e => e.type === "TurnRefused" && now - e.at <= HOUR);
  const waiting = new Set(recent.map(e => (e.type === "TurnRefused" ? (e.session ?? "") : ""))).size;
  return resetAdvice(pool, waiting, now);
}
