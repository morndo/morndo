// The account pool's service (ADR-0029): it loads the Pool of a runtime, applies one domain function, saves on the version it
// read, and retries a lost save up to 8 times, as LeaseService does. It decides nothing the domain does not: which member runs
// a turn is `place`, one writer per session and one turn per account are `claim`. What it adds is the Connection gate (a member's
// Connection must be on, acknowledged at the current terms, and a subscription of the runtime) and the words of a refusal.
import {
  activateMember, addMember, bindSession, claim, err, findConnection, markOut, noteMoveBy, noteResetSpent, ok, place,
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
// exit 75 is a gate refusal (the member's Connection says no), 1 anything else; as `run` exits.
export type PoolRefusal = { problem: string; exit: 1 | 75; holder?: Holder; backAt?: number | null };
type Ended = { next: TurnBegun | null; refusal: PoolRefusal | null };

const ATTEMPTS = 8;
const HOUR = 3_600_000;
const SAME_REFUSAL_MS = 300_000;
const ADVICE_REPEAT_MS = 24 * HOUR;
const NO_DEFAULT = "no default member: set one with morndo-keys pool set defaultMember <name>";
const NO_FREE_SEAT = "no pool account is free";

const refused = (problem: string, exit: 1 | 75 = 1, extra: Partial<PoolRefusal> = {}): Result<never, PoolRefusal> => err({ problem, exit, ...extra });
const stateWords: Record<SeatState, string> = { "logged-out": "signed out", retired: "retired", out: "out", low: "low", ok: "ok" };

export class PoolService {
  readonly #deps: PoolDeps;
  constructor(deps: PoolDeps) { this.#deps = deps; }

  add(runtime: string, connection: string, settings: MemberSettings): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now, directory) => {
      const row = findConnection(directory, connection);
      if (!row || row.status === "revoked") return { pool, result: refused(`no such connection: ${connection}`) };
      if (row.custody !== "morndo" || row.kind !== "subscription" || row.runtime !== runtime) {
        return { pool, result: refused("a pool member is a subscription of its runtime") };
      }
      if (row.configDir === null) return { pool, result: refused("a pool member needs its own --config-dir") };
      const added = addMember(pool, connection, settings, now);
      return added.ok ? { pool: added.value, result: ok(undefined) } : { pool, result: refused(`${connection} is already a pool member`) };
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
      return { pool, result: refused(words[next.error]) };
    });
  }

  setMode(runtime: string, mode: "pinned" | "rotate", by: string | null): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const next = setMode(pool, mode, by, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool, result: refused("rotation needs --by: who decided it") };
    });
  }

  // The principal's move: the session is placed on `to`, pinned there.
  move(runtime: string, session: string, to: string, by: string): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      if (by.trim() === "") return { pool, result: refused("a move needs --by: who decided it") };
      if (!pool.members.some(m => m.name === to)) return { pool, result: refused(`no such pool member: ${to}`) };
      return { pool: placeSession(pool, session, to, true, now), result: ok(undefined) };
    });
  }

  // A claim with no session, for a read of the account (PL13): nothing is placed.
  hold(runtime: string, member: string, claimId: string, holder: Holder): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      if (!pool.members.some(m => m.name === member)) return { pool, result: refused(`no such pool member: ${member}`) };
      const held = claim(pool, { id: claimId, session: null, member, holder, pinned: true }, h => this.#deps.processes.alive(h), now);
      if (held.ok) return { pool: held.value, result: ok(undefined) };
      return { pool, result: held.error.problem === "member-busy" ? refused(`${held.error.member} is busy`) : refused("session-busy", 1, { holder: held.error.holder }) };
    });
  }

  release(runtime: string, claimId: string): void {
    this.#change(runtime, (pool, now) => ({ pool: release(pool, claimId, now), result: ok(undefined) }));
  }

  spent(runtime: string, member: string, by: string, outcome: string): void {
    this.#change(runtime, (pool, now) => ({ pool: noteResetSpent(pool, member, by, outcome, now), result: ok(undefined) }));
  }

  // PL4, PL6, PL7, PL13 in one versioned save: the member that runs the turn, and its claim.
  begin(start: TurnStart): Result<TurnBegun, PoolRefusal> {
    return this.#change(start.runtime, (pool, now, directory) => {
      const gate = this.#gate(pool, directory);
      const view = withRetired(pool, gate, now);
      const placed = start.session === null ? undefined : pool.placements.find(x => x.session === start.session);
      const answer = place(view, { session: start.session, pin: start.pin, dir: start.dir, night: start.night, model: start.model }, now);
      if (!answer.ok) {
        if (answer.problem === "no-default") return { pool, result: refused(NO_DEFAULT) };
        if (answer.problem === "unknown-member") return { pool, result: refused(`no such pool member: ${start.pin ?? placed?.member ?? ""}`) };
        const why = answer.problem === "member-unavailable" ? gate.get(answer.member) : undefined;
        if (why !== undefined) return { pool, result: refused(why, 75) };
        const problem = answer.problem === "member-unavailable" ? `member ${answer.member} is ${stateWords[answer.state]}` : NO_FREE_SEAT;
        return { pool: noteRefusal(pool, start.session, problem, now), result: refused(problem, 1, { backAt: "backAt" in answer ? answer.backAt : null }) };
      }
      const pinned = placed?.pinned ?? (start.pin !== null || pool.settings.mode === "pinned");
      const claimed = claim(pool, { id: start.claimId, session: start.session, member: answer.member, holder: start.holder, pinned }, h => this.#deps.processes.alive(h), now);
      if (!claimed.ok) {
        if (claimed.error.problem === "session-busy") return { pool, result: refused("session-busy", 1, { holder: claimed.error.holder }) };
        const problem = `${claimed.error.member} is busy`;
        return { pool: noteRefusal(pool, start.session, problem, now), result: refused(problem) };
      }
      const next = start.session === null ? claimed.value : placeSession(claimed.value, start.session, answer.member, pinned, now);
      return { pool: next, result: ok({ member: answer.member, configDir: this.#configDir(directory, answer.member), claimId: start.claimId, moved: answer.moved, continueBy: null }) };
    });
  }

  // A first turn's claim binds to the session the runtime names (PL7), and places it, pinned as the claim is.
  bind(runtime: string, claimId: string, session: string): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const bound = bindSession(pool, claimId, session, h => this.#deps.processes.alive(h), now);
      if (bound.ok) return { pool: bound.value, result: ok(undefined) };
      return { pool, result: bound.error.problem === "session-busy" ? refused("session-busy", 1, { holder: bound.error.holder }) : refused(`${bound.error.member} is busy`) };
    });
  }

  // The turn ended. Released always; a usage limit marks the member; and the next member to go on comes back (rotate mode,
  // a claim that is not pinned) or the same member again for a handoff (PL8, PL14).
  end(runtime: string, claimId: string, end: TurnEnd, at?: number): { next: TurnBegun | null; refusal: PoolRefusal | null } {
    const done = this.#change<Ended>(runtime, (pool, clockNow, directory) => {
      const now = at ?? clockNow;
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
        return { pool: p, result: ok({ next: null, refusal: { problem: `member ${held.member} is out`, exit: 1 as const, backAt } }) };
      }
      const answer = place(withRetired(p, this.#gate(p, directory), now), { session: held.session, pin: null, dir: null, night: false, model: end.model }, now);
      if (!answer.ok) {
        const backAt = answer.problem === "no-seat" ? answer.backAt : null;
        return { pool: p, result: ok({ next: null, refusal: { problem: NO_FREE_SEAT, exit: 1 as const, backAt } }) };
      }
      const id = `${claimId}>${answer.member}`;
      const taken = claim(p, { id, session: held.session, member: answer.member, holder: held.holder, pinned: false }, h => this.#deps.processes.alive(h), now);
      if (!taken.ok) return { pool: p, result: ok({ next: null, refusal: { problem: `${answer.member} is busy`, exit: 1 as const } }) };
      const placed = held.session === null ? taken.value : placeSession(taken.value, held.session, answer.member, false, now);
      const next: TurnBegun = { member: answer.member, configDir: this.#configDir(directory, answer.member), claimId: id, moved: answer.moved, continueBy: placed.settings.moveBy };
      return { pool: placed, result: ok({ next, refusal: null }) };
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

  // Waiting work is the distinct sessions refused in the last hour. A piece of advice is recorded once per member and reason a day.
  advice(runtime: string): Advice | null {
    const out = this.#change<Advice | null>(runtime, (pool, now) => {
      const recent = pool.events.filter(e => e.type === "TurnRefused" && now - e.at <= HOUR);
      const waiting = new Set(recent.map(e => (e.type === "TurnRefused" ? (e.session ?? "") : ""))).size;
      const advised = resetAdvice(pool, waiting, now);
      if (!advised) return { pool, result: ok(null) };
      const again = pool.events.some(e => e.type === "ResetAdvised" && e.member === advised.member && e.reason === advised.reason && now - e.at < ADVICE_REPEAT_MS);
      const next = again ? pool : { ...pool, events: [...pool.events, { type: "ResetAdvised" as const, member: advised.member, reason: advised.reason, at: now }].slice(-500) };
      return { pool: next, result: ok(advised) };
    });
    return out.ok ? out.value : null;
  }

  // The same member again, newly claimed (a handoff, PL14).
  #again(p: Pool, directory: Directory, member: string, session: string | null, holder: Holder, id: string, now: number): { pool: Pool; result: Result<Ended, PoolRefusal> } {
    const taken = claim(p, { id, session, member, holder, pinned: true }, h => this.#deps.processes.alive(h), now);
    if (!taken.ok) return { pool: p, result: ok({ next: null, refusal: { problem: `${member} is busy`, exit: 1 as const } }) };
    const next: TurnBegun = { member, configDir: this.#configDir(directory, member), claimId: id, moved: null, continueBy: "handoff" };
    return { pool: taken.value, result: ok({ next, refusal: null }) };
  }

  #member(runtime: string, member: string, step: (pool: Pool, now: number) => Result<Pool, "missing">): Result<void, PoolRefusal> {
    return this.#change(runtime, (pool, now) => {
      const next = step(pool, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool, result: refused(`no such pool member: ${member}`) };
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
    return refused("the pool changed under this call; try again");
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
