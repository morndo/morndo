// The key pool's service (ADR-0037): load the pool, apply one domain function, save on the version read, and retry a lost
// save up to 8 times. Creating a pool is one save. A pick saves the ring position before the attempt, and writes the pick
// after it returns; a pooled run opens its grant in that same save. A hand-off writes the directory, then the grant, then
// the audit line, and the next call repairs a crash between those writes. Alerts name a member or the pool and a reason
// word; a provider's text never lands here. A hand-off never sees a key.
import {
  KEY_PROBE_COST_USD, KEY_POOL_RECHECK_DEFAULT_MS, LEASE_REFUSED, acknowledgeKeyPoolTerms, attributeToGrant, bindFilter as bindGrantFilter, chooseKey, claimProbe, closeGrant as dropGrant, createKeyPool, dueMembers, err, findConnection, isKey,
  joinKeyPool, keyPicked, keyPoolBackAt, keyPoolStanding, keyRotated, leaveKeyPool, moveGrant, moveKeyMember, newKeyPoolEvents, nextHelperWindow, noteLent, noteSeen, ok,
  openGrant, releaseKey, reportKeyOutcome, reviveKey, servableOrder, setKeyPoolPolicy, settleKeyPool, touchGrant, unreachable,
  type Actor, type Directory, type Grant, type GrantRequest, type HelperWindow, type Holder, type KeyPool, type KeyPoolEvent,
  type Lease, type Names, type Outcome, type ProbeWhy, type Result, type RotationMode, type RotationPolicy, type Standing,
} from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { LeaseService } from "./lease-service.ts";
import type { AlertSink, Catalog, Classifiers, Clock, ConnectionLifecycle, ConnectionStore, Failure, KeyPoolStore, LeaseRequest, PoolNames, PoolRouting, ProbeAnswer, ProcId, Processes, ProviderProbe, ProviderSignal } from "./ports.ts";

export type KeyPoolFailure = Failure & { backAt?: number | null; member?: string };
export type PoolView = {
  name: string;
  runtime: string;
  vendor: string;
  mode: RotationMode;
  recheckEveryMs: number;
  standing: Standing;
  termsRevision: string | null;
  lastPick: string | null;
  members: {
    credential: string;
    state: "active" | "exhausted" | "failing";
    reason: string | null;
    since: number;
    nextCheck: number | null;
  }[];
  probe: { costUsd: number; last24h: number };
};
export type ProbeResult = {
  member: string;
  outcome: "recovered" | "healthy" | "exhausted" | "failing" | "limited" | "unknown" | "unreachable" | "declined" | "skipped";
  word?: string;
};

type Deps = {
  clock: Clock;
  store: KeyPoolStore;
  connections: ConnectionStore;
  catalog: Catalog;
  alerts: AlertSink;
  processes: Processes;
  classifiers: Classifiers;
  leases: Leases;
  helper: { limit: number; ttlMs: number };
  probe: ProviderProbe;
};
export type GrantSeed = { lease: string; holder: Holder; request: GrantRequest; startedAt: number };
type HandOffCaller = { id: ProcId; ppid: number | null; filter: string | null };
type Leases = Pick<LeaseService, "swap" | "refresh" | "helper" | "serve" | "lease" | "close">;
export type LaneProof = { kind: "lane"; lease: string; caller: { pid: number; startedAt: number; bootId: string } };
export type ReportBy = Actor | LaneProof;
type CreateInput = {
  name: string;
  vendor: string;
  runtime: string;
  mode?: RotationMode;
  recheckEveryMs?: number;
  members: readonly string[];
  by: string;
  confirmOwn: boolean;
  organizations?: Readonly<Record<string, string | null>>;
};
type Advance =
  | { kind: "go"; member: string; previous: string | null }
  | { kind: "empty" }
  | { kind: "stop"; error: KeyPoolFailure };

const ATTEMPTS = 8;
// The call cap a probe lease uses, the same figure the command line uses for one.
const PROBE_LEASES = 8;
const DAY_MS = 86_400_000;
const fail = (problem: string): Result<never, Failure> => err({ problem });
// A refresh refused for one of these swaps. Anything else (a missing lease, a lost save) is returned as it is.
const REFRESH_SWAP = new Set(["budget", "expired", "off", "terms"]);

function isPrincipal(actor: Actor): boolean {
  return actor.kind === "principal" && actor.command.trim() !== "";
}

function openKeyLease(directory: Directory, id: string): { name: string; holder: { pid: number; startedAt: number; bootId: string } } | null {
  for (const connection of directory.connections) {
    if (!isKey(connection)) continue;
    const row = connection.leases.find(lease => lease.id === id && lease.authority === "live");
    if (row) return { name: connection.name, holder: row.holder };
  }
  return null;
}

const MARKS = new Set<Outcome["kind"]>(["exhausted", "failing", "limited"]);

// The run's own child (the agent), as a helper call or a report names it: pid, start ticks and boot id.
export function sessionKey(id: ProcId): string {
  return `${id.pid}:${id.startedAt}:${id.bootId}`;
}

function leaveRevoked(pool: KeyPool, directory: Directory, now: number): KeyPool | null {
  for (const member of pool.members) {
    const row = findConnection(directory, member.credential);
    if (row !== null && row.status !== "revoked") continue;
    const left = leaveKeyPool(pool, member.credential, now, "revoked");
    return left.ok ? left.value : null;
  }
  return null;
}

export class KeyPoolService implements ConnectionLifecycle {
  readonly #deps: Deps;
  #routing: PoolRouting | null = null;
  constructor(deps: Deps) { this.#deps = deps; }

  attachRouting(routing: PoolRouting): void { this.#routing = routing; }

  routingPools(): readonly PoolNames[] {
    const pools: PoolNames[] = [];
    for (const name of this.#deps.store.names().live) {
      const { pool } = this.#deps.store.load(name);
      if (!pool || pool.members.length === 0) continue;
      pools.push({ name: pool.name, members: pool.members.map(member => member.credential) });
    }
    return pools;
  }

  // Each live pool is folded again. The first failure is the answer; the rest still run.
  sync(): Result<void, Failure> {
    if (!this.#routing) return ok(undefined);
    let first: Failure | null = null;
    for (const pool of this.routingPools()) {
      const result = this.#routing.joined(pool.name, pool.members);
      if (!result.ok && !first) first = result.error;
    }
    return first ? err(first) : ok(undefined);
  }

  // Whether some member could serve now. The ring, the pick and the alerts stay as they are.
  async canServe(pool: string, attempt: (member: string) => Promise<Result<unknown, Failure>>): Promise<Result<{ member: string }, KeyPoolFailure>> {
    const loaded = this.#deps.store.load(pool);
    if (!loaded.pool) return fail("missing");
    const terms = this.#terms(loaded.pool);
    if (!terms.ok) return err(terms.error);
    const failing = loaded.pool.members.find(member => member.health.state === "failing");
    if (failing) return err({ problem: "pool_blocked", exit: LEASE_REFUSED, member: failing.credential });
    const order = servableOrder(loaded.pool);
    if (order.length === 0) return err({ problem: "pool_empty", exit: LEASE_REFUSED, backAt: keyPoolBackAt(loaded.pool) });
    let first: Failure | null = null;
    for (const member of order) {
      const result = await attempt(member);
      if (result.ok) return ok({ member });
      if (result.error.exit !== LEASE_REFUSED) return err(result.error);
      if (!first) first = result.error;
    }
    return err(first ?? { problem: "none_left", exit: LEASE_REFUSED });
  }

  create(input: CreateInput, actor: Actor): Result<void, Failure> {
    const terms = this.#deps.catalog.keyPool(input.vendor);
    if (!terms) return fail("no_classifier");
    const by = input.by.trim();
    if (by === "") return fail("ack_needed");
    const now = this.#deps.clock.now();
    const specified = input.mode !== undefined || input.recheckEveryMs !== undefined;
    const created = createKeyPool({
      name: input.name, runtime: input.runtime, vendor: input.vendor,
      ...(specified ? { policy: { mode: input.mode ?? "round-robin" as const, recheckEveryMs: input.recheckEveryMs ?? KEY_POOL_RECHECK_DEFAULT_MS } } : {}),
    }, this.#names(), actor, now);
    if (!created.ok) return fail(created.error);
    let pool = created.value;
    const directory = this.#deps.connections.load().directory;
    const elsewhere = this.#elsewhere();
    for (const member of input.members) {
      const connection = findConnection(directory, member);
      if (!connection) return fail("missing");
      const joined = joinKeyPool(
        pool, connection, { elsewhere }, input.organizations?.[member] ?? null, input.confirmOwn, actor, now,
      );
      if (!joined.ok) return fail(joined.error);
      pool = joined.value;
    }
    const acked = acknowledgeKeyPoolTerms(pool, terms.termsRevision, by, actor, now);
    if (!acked.ok) return fail(acked.error);
    if (!this.#deps.store.save(acked.value, 0)) return fail("taken");
    this.#alerts({ ...acked.value, events: [], seq: 0 }, acked.value);
    return this.#joined(acked.value.name, acked.value.members.map(member => member.credential));
  }

  join(pool: string, member: string, own: { confirmOwn: boolean; organization?: string | null }, actor: Actor): Result<void, Failure> {
    const changed = this.#change(pool, (current, now) => {
      const connection = findConnection(this.#deps.connections.load().directory, member);
      if (!connection) return { pool: current, result: fail("missing") };
      const next = joinKeyPool(
        current, connection, { elsewhere: this.#elsewhere(current.name) }, own.organization ?? null, own.confirmOwn, actor, now,
      );
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
    if (!changed.ok) return changed;
    const members = this.#deps.store.load(pool).pool?.members.map(row => row.credential) ?? [];
    return this.#joined(pool, members);
  }

  leave(pool: string, member: string, actor: Actor): Result<void, Failure> {
    if (!isPrincipal(actor)) return fail("principal");
    const changed = this.#change(pool, (current, now) => {
      const next = leaveKeyPool(current, member, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
    if (!changed.ok) return changed;
    const remaining = this.#deps.store.load(pool).pool?.members.map(row => row.credential) ?? [];
    return this.#left(pool, [member], remaining);
  }

  move(pool: string, member: string, to: number, actor: Actor): Result<void, Failure> {
    return this.#change(pool, (current, now) => {
      const next = moveKeyMember(current, member, to, actor, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  setPolicy(pool: string, change: Partial<RotationPolicy>, actor: Actor): Result<void, Failure> {
    if (!isPrincipal(actor)) return fail("principal");
    return this.#change(pool, (current, now) => {
      const next = setKeyPoolPolicy(current, change, actor.kind === "principal" ? actor.command : null, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  revive(pool: string, member: string, actor: Actor): Result<void, Failure> {
    return this.#change(pool, (current, now) => {
      const next = reviveKey(current, member, actor, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  delete(pool: string, actor: Actor): Result<void, Failure> {
    if (!isPrincipal(actor)) return fail("principal");
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const loaded = this.#deps.store.load(pool);
      if (!loaded.pool) return fail("missing");
      const members = loaded.pool.members.map(row => row.credential);
      if (!this.#deps.store.tombstone(pool, loaded.version, this.#deps.clock.now())) continue;
      return this.#left(pool, members, []);
    }
    return fail("conflict");
  }

  report(pool: string, member: string, outcome: Outcome, observedAt: number, by: ReportBy, via?: "probe" | "report"): Result<void, Failure> {
    const allowed = this.#mayReport(member, outcome, by);
    if (!allowed.ok) return allowed;
    return this.#change(pool, (current, now) => {
      const next = via === undefined
        ? reportKeyOutcome(current, member, outcome, observedAt, now)
        : reportKeyOutcome(current, member, outcome, observedAt, now, via);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  reportSignal(pool: string, member: string, signal: ProviderSignal, observedAt: number, via: "probe" | "report" = "report"): Result<Outcome, Failure> {
    const loaded = this.#deps.store.load(pool);
    if (!loaded.pool) return fail("missing");
    const dialect = this.#deps.catalog.keyPool(loaded.pool.vendor)?.errorDialect;
    if (!dialect) return fail("no_classifier");
    const classifier = this.#deps.classifiers.for(dialect);
    if (!classifier) return fail("no_classifier");
    const outcome = classifier.classify(signal);
    if (outcome.kind === "unknown" && signal.status !== null && signal.status >= 400 && signal.status <= 499) {
      const kind = (signal.kind ?? "-").slice(0, 64);
      this.#deps.alerts.raise({ kind: "unclassified", name: member, detail: `${signal.status} ${kind}` });
    }
    const reported = this.report(pool, member, outcome, observedAt, { kind: "operator" }, via);
    return reported.ok ? ok(outcome) : reported;
  }

  // Claim, then the member's own gate, then one probe. A refusal before the request sends nothing. The instant of the
  // claim is the observation time, so an answer that left before a later change cannot undo it.
  async probeMember(pool: string, member: string, input: { why: ProbeWhy; holder: Holder }): Promise<ProbeResult> {
    const loaded = this.#deps.store.load(pool);
    if (!loaded.pool) return { member, outcome: "skipped", word: "missing" };
    const model = this.#deps.catalog.keyPoolProbe(loaded.pool.vendor)?.model;
    if (!model) return { member, outcome: "skipped", word: "no_probe_model" };
    const baseUrl = probeBase(this.#deps.catalog, loaded.pool);
    const claimed = this.#change(pool, (current, now) => {
      const next = claimProbe(current, member, now, input.why);
      return next.ok ? { pool: next.value, result: ok(now) } : { pool: current, result: fail(next.error) };
    });
    if (!claimed.ok) return { member, outcome: "skipped", word: claimed.error.problem };
    const at = claimed.value;
    const granted = this.#deps.leases.lease(member, {
      role: "probe", entry: model, holder: input.holder, workspacePath: "/",
      limit: PROBE_LEASES, reserve: KEY_PROBE_COST_USD, margin: 0, probe: true,
    });
    if (!granted.ok) {
      const word = granted.error.problem;
      return granted.error.exit === LEASE_REFUSED
        ? { member, outcome: "declined", word }
        : { member, outcome: "skipped", word };
    }
    const answer = await this.#ask(member, granted.value.id, { connection: member, model, baseUrl });
    if (!("signal" in answer)) return { member, outcome: "unreachable" };
    const reported = this.reportSignal(pool, member, answer.signal, at, "probe");
    if (!reported.ok) return { member, outcome: "skipped", word: reported.error.problem };
    const active = this.#deps.store.load(pool).pool?.members.find(row => row.credential === member)?.health.state === "active";
    return probed(member, reported.value, active, input.why);
  }

  // One pool, or every live pool. A named member is probed now; otherwise only the members that are due, in ring order.
  async recheck(input: { holder: Holder; pool?: string; member?: string }): Promise<ProbeResult[]> {
    const names = input.pool === undefined ? this.#deps.store.names().live : [input.pool];
    const now = this.#deps.clock.now();
    const results: ProbeResult[] = [];
    for (const name of names) {
      if (input.member !== undefined) {
        results.push(await this.probeMember(name, input.member, { why: "manual", holder: input.holder }));
        continue;
      }
      const loaded = this.#deps.store.load(name);
      if (!loaded.pool) continue;
      for (const member of dueMembers(loaded.pool, now)) {
        results.push(await this.probeMember(name, member, { why: "due", holder: input.holder }));
      }
    }
    return results;
  }

  // Everything before the first `await` is synchronous, so two picks started together each see the ring position the
  // other already saved. A refusal puts that reservation back before the next member is tried, or before the call returns.
  // An empty pool with a member due claims that probe before this call yields, so the others find the claim and stop.
  async pick<T>(pool: string, attempt: (member: string) => Promise<Result<T, Failure>>, options?: { skip?: readonly string[]; grant?: (member: string, value: T) => GrantSeed; probe?: Holder }): Promise<Result<{ member: string; value: T; grant?: string }, KeyPoolFailure>> {
    if (options?.probe !== undefined && this.#dueToProbe(pool)) await this.recheck({ holder: options.probe, pool });
    return this.#choose(pool, attempt, options);
  }

  // The run's own filter socket, recorded once. A second call is refused, even for the same path.
  bindFilter(pool: string, grant: string, path: string): Result<void, KeyPoolFailure> {
    return this.#change(pool, current => {
      const next = bindGrantFilter(current, grant, path);
      if (next.ok) return { pool: next.value, result: ok(undefined) };
      const problem = next.error === "missing" ? "grant_missing" : next.error === "bound" ? "filter_bound" : "filter_path";
      return { pool: current, result: fail(problem) };
    });
  }

  // The pooled helper's call. The ring advances, the directory swaps, the pool saves the pick and the grant together,
  // then the audit line is written. A lost save, a lease another call already swapped, or a lease waiting to be adopted
  // starts the round again. A thrown error is the crash the next call repairs; it is not caught here.
  async handOff(pool: string, grant: string, caller: HandOffCaller): Promise<Result<{ connection: string; lease: string }, KeyPoolFailure>> {
    const { leases, helper } = this.#deps;
    // A swap, a re-lease, or this call's helper count already counted it. A later round that finds that lease still
    // refreshes and re-checks its authority, and does not count the call again.
    let countedCall = false;
    const noteSwap = (): void => { countedCall = true; };
    for (let round = 0; round < ATTEMPTS; round++) {
      const loaded = this.#deps.store.load(pool);
      if (!loaded.pool) return fail("missing");
      const current = loaded.pool;
      const held = current.grants.find(row => row.id === grant);
      if (!held) return fail("grant_missing");
      if (!this.#holds(held.holder, caller.id)) return fail("not_holder");
      if (held.filter === null || held.filter !== caller.filter) return fail("filter");
      const directory = this.#deps.connections.load().directory;
      const request: LeaseRequest = { ...held.request, holder: held.holder, probe: false };
      const found = keyLease(directory, held.lease);
      if (found) {
        if (keyPoolStanding(current) === "blocked") return blocked(current);
        const capped = found.row.authority === "ended" && directory.events.some(event => event.type === "AuthorityEnded" && event.lease === found.row.id);
        if (capped) return fail("authority");
        const state = current.members.find(member => member.credential === held.member)?.health.state;
        // A member that has left or been revoked is no longer in the pool. Hand off as for an exhausted member; the
        // swap closes the old lease, including one whose authority a revoke already ended.
        let why: "exhausted" | "refused" | "left" | null = state === undefined
          ? "left"
          : found.row.authority === "ended" || state === "exhausted" ? (state === "exhausted" ? "exhausted" : "refused") : null;
        if (!why) {
          const refreshed = leases.refresh(found.name, found.row.id);
          if (!refreshed.ok) {
            if (!REFRESH_SWAP.has(refreshed.error.problem)) return err(refreshed.error);
            why = "refused";
          } else {
            if (!countedCall) {
              const noted = leases.helper(found.name, found.row.id, caller.id, helper.limit, helper.ttlMs);
              if (!noted.ok) return err(noted.error);
              countedCall = true;
            }
            const again = keyLease(this.#deps.connections.load().directory, found.row.id);
            if (!again || again.row.authority === "ended") return fail("authority");
            const served = this.#serve(leases, pool, held, again.name, again.row, caller);
            if (isRetry(served)) continue;
            return served;
          }
        }
        const counted = nextHelperWindow(found.row, helper.limit, helper.ttlMs, this.#deps.clock.now());
        if (counted.over) {
          leases.helper(found.name, found.row.id, caller.id, helper.limit, helper.ttlMs);
          return fail("authority");
        }
        const window = { calls: counted.calls, windowStart: counted.windowStart };
        const reason = why ?? "refused";
        const taken = await this.#reseat(pool, held, { name: held.member, id: held.lease }, request, window, reason, leases, caller, noteSwap);
        if (isRetry(taken)) continue;
        return taken;
      }
      const adopted = adoptable(directory, current, held);
      if (adopted) {
        const moved = this.#change(pool, (candidate, now) => {
          const next = moveGrant(candidate, held.id, {
            member: adopted.name, lease: adopted.row.id,
            window: { calls: adopted.row.calls, windowStart: adopted.row.windowStart }, movedAt: adopted.row.start,
          }, "adopted", now);
          return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: candidate, result: fail(next.error) };
        });
        if (!moved.ok && moved.error.problem !== "conflict") return moved;
        continue;
      }
      if (keyPoolStanding(current) === "blocked") return blocked(current);
      const counted = nextHelperWindow(held.window, helper.limit, helper.ttlMs, this.#deps.clock.now());
      if (counted.over) return fail("authority");
      const window = { calls: counted.calls, windowStart: counted.windowStart };
      const state = current.members.find(member => member.credential === held.member)?.health.state;
      // Gone from the pool: do not re-lease that member. The next one is picked, as when the member is exhausted.
      let why: "exhausted" | "refused" | "left" = state === undefined ? "left" : state === "exhausted" ? "exhausted" : "refused";
      if (state === "active") {
        const swapped = leases.swap(null, held.member, request, window, current.members.map(member => member.credential));
        if (swapped.ok) {
          countedCall = true;
          const moved = this.#change(pool, (candidate, now) => {
            const next = moveGrant(candidate, held.id, { member: held.member, lease: swapped.value.id, window, movedAt: now }, "reopened", now);
            return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: candidate, result: fail(next.error) };
          });
          if (!moved.ok) {
            if (moved.error.problem === "conflict") continue;
            return moved;
          }
          const fresh = keyLease(this.#deps.connections.load().directory, swapped.value.id);
          if (!fresh) return fail("missing");
          const served = this.#serve(leases, pool, held, fresh.name, fresh.row, caller);
          if (isRetry(served)) continue;
          return served;
        }
        if (swapped.error.problem === "conflict" || swapped.error.problem === "closed" || swapped.error.problem === "held") continue;
        if (swapped.error.exit !== LEASE_REFUSED) return err(swapped.error);
        why = "refused";
      }
      const taken = await this.#reseat(pool, held, null, request, window, why, leases, caller, noteSwap);
      if (isRetry(taken)) continue;
      return taken;
    }
    return fail("conflict");
  }

  grantOf(pool: string, grant: string): { member: string; lease: string } | null {
    const held = this.#deps.store.load(pool).pool?.grants.find(row => row.id === grant);
    return held ? { member: held.member, lease: held.lease } : null;
  }

  attribute(pool: string, grant: string, session?: string | null): Result<string, Failure> {
    const found = this.#attributed(pool, grant, session);
    return found.ok ? ok(found.value.member) : found;
  }

  // The grant is checked before the caller, and the caller before the outcome, so a stranger's refusal is not applied.
  // A holder's report is about the session under the grant; an operator may name that session. A credit refusal that
  // fell back to the hand-off window names the current member to suspect, when that member was not the one credited.
  reportByGrant(pool: string, grant: string, outcome: Outcome, observedAt: number, by: { kind: "operator"; session?: string } | { kind: "holder"; caller: ProcId }): Result<{ suspect: string | null }, Failure> {
    const held = this.#deps.store.load(pool).pool?.grants.find(row => row.id === grant);
    if (!held) return fail("grant_missing");
    if (by.kind === "holder") {
      if (!this.#holds(held.holder, by.caller)) return fail("not_holder");
      if (!MARKS.has(outcome.kind)) return fail("not_allowed");
    }
    const session = by.kind === "holder" ? this.#sessionKey(held.holder, by.caller.pid) : by.session;
    const found = this.#attributed(pool, grant, session);
    if (!found.ok) return found;
    // The member the grant names has left the pool. The report is accepted and changes nothing.
    const there = this.#deps.store.load(pool).pool?.members.some(row => row.credential === found.value.member) ?? false;
    if (!there) return ok({ suspect: null });
    const reported = this.report(pool, found.value.member, outcome, observedAt, { kind: "operator" });
    if (!reported.ok) return reported;
    const suspect = found.value.suspect;
    const named = outcome.kind === "exhausted" && suspect !== null && found.value.member !== suspect ? suspect : null;
    return ok({ suspect: named });
  }

  closeGrant(pool: string, grant: string): void {
    this.#change(pool, (current, now) => ({ pool: dropGrant(current, grant, now), result: ok(undefined) }));
  }

  sweepGrants(): number {
    let dropped = 0;
    for (const name of this.#deps.store.names().live) {
      const result = this.#change(name, (pool, now) => {
        let next = pool;
        for (const grant of pool.grants) {
          const holder = grant.holder;
          if (this.#deps.processes.alive({ pid: holder.pid, startedAt: holder.startedAt, bootId: holder.bootId })) continue;
          next = dropGrant(next, grant.id, now);
        }
        return { pool: next, result: ok(pool.grants.length - next.grants.length) };
      });
      if (result.ok) dropped += result.value;
    }
    return dropped;
  }

  list(): readonly PoolView[] {
    const views: PoolView[] = [];
    for (const name of this.#deps.store.names().live) {
      const { pool } = this.#deps.store.load(name);
      if (pool) views.push(this.#view(pool));
    }
    return views;
  }

  state(pool: string): PoolView | null {
    const loaded = this.#deps.store.load(pool);
    return loaded.pool ? this.#view(loaded.pool) : null;
  }

  poolOf(connection: string): string | null {
    for (const name of this.#deps.store.names().live) {
      const { pool } = this.#deps.store.load(name);
      if (pool?.members.some(member => member.credential === connection)) return name;
    }
    return null;
  }

  reserved(name: string): boolean {
    const loaded = this.#deps.store.load(name);
    return loaded.pool !== null || loaded.version > 0;
  }

  revoked(name: string): void {
    const holder = this.poolOf(name);
    if (holder === null) return;
    const changed = this.#change(holder, (pool, now) => {
      const next = leaveKeyPool(pool, name, now, "revoked");
      return { pool: next.ok ? next.value : pool, result: ok(undefined) };
    });
    if (!changed.ok) return;
    const remaining = this.#deps.store.load(holder).pool?.members.map(row => row.credential) ?? [];
    this.#left(holder, [], remaining);
  }

  rotated(name: string): void {
    const holder = this.poolOf(name);
    if (holder === null) return;
    this.#change(holder, (pool, now) => ({ pool: keyRotated(pool, name, now), result: ok(undefined) }));
  }

  #advance(name: string, skip: readonly string[]): Advance {
    let attempt = 0;
    while (attempt < ATTEMPTS) {
      const loaded = this.#deps.store.load(name);
      if (!loaded.pool) return { kind: "stop", error: { problem: "missing" } };
      const terms = this.#terms(loaded.pool);
      if (!terms.ok) return { kind: "stop", error: terms.error };
      const now = this.#deps.clock.now();
      const directory = this.#deps.connections.load().directory;
      const healed = leaveRevoked(loaded.pool, directory, now);
      if (healed) {
        if (!this.#deps.store.save(healed, loaded.version)) { attempt += 1; continue; }
        this.#alerts(loaded.pool, healed);
        continue;
      }
      const decision = chooseKey(loaded.pool, skip);
      if (!decision.ok) {
        if (decision.error.problem === "none_left") return { kind: "empty" };
        const settled = settleKeyPool(loaded.pool, now);
        if (settled !== loaded.pool) {
          if (!this.#deps.store.save(settled, loaded.version)) { attempt += 1; continue; }
          this.#alerts(loaded.pool, settled);
        }
        if (decision.error.problem === "pool_empty") {
          return { kind: "stop", error: { problem: "pool_empty", exit: LEASE_REFUSED, backAt: decision.error.backAt } };
        }
        return { kind: "stop", error: { problem: "pool_blocked", exit: LEASE_REFUSED, member: decision.error.member } };
      }
      const previous = loaded.pool.lastPick;
      if (decision.value.pool !== loaded.pool) {
        if (!this.#deps.store.save(decision.value.pool, loaded.version)) { attempt += 1; continue; }
        this.#alerts(loaded.pool, decision.value.pool);
      }
      return { kind: "go", member: decision.value.member, previous };
    }
    return { kind: "stop", error: { problem: "conflict" } };
  }

  async #choose<T>(
    pool: string, attempt: (member: string) => Promise<Result<T, Failure>>,
    options?: { skip?: readonly string[]; grant?: (member: string, value: T) => GrantSeed; also?: (pool: KeyPool, member: string, value: T, now: number) => Result<KeyPool, Failure> },
  ): Promise<Result<{ member: string; value: T; grant?: string }, KeyPoolFailure>> {
    const heldBack = options?.skip ?? [];
    const declined: { member: string; word: string }[] = [];
    let first: Failure | null = null;
    for (;;) {
      const step = this.#advance(pool, [...heldBack, ...declined.map(row => row.member)]);
      if (step.kind === "stop") return err(step.error);
      if (step.kind === "empty") return err(first ?? { problem: "none_left", exit: LEASE_REFUSED });
      const result = await attempt(step.member);
      if (result.ok) {
        const seed = options?.grant?.(step.member, result.value);
        const grantId = seed ? `g${seed.lease}` : undefined;
        const extra = seed || options?.also
          ? (current: KeyPool, now: number): Result<KeyPool, Failure> => {
            let next = current;
            if (seed && grantId) {
              const opened = openGrant(next, {
                id: grantId, member: step.member, lease: seed.lease, holder: seed.holder, request: seed.request,
                window: { calls: 0, windowStart: seed.startedAt }, previous: null, seen: [], lent: [], filter: null,
              }, now);
              if (!opened.ok) return fail(opened.error);
              next = opened.value;
            }
            return options?.also ? options.also(next, step.member, result.value, now) : ok(next);
          }
          : undefined;
        const noted = this.#note(pool, step.member, declined, step.previous, extra);
        if (!noted.ok) return noted;
        return ok(grantId ? { member: step.member, value: result.value, grant: grantId } : { member: step.member, value: result.value });
      }
      const restored = this.#rewind(pool, step.member, step.previous);
      if (!restored.ok) return restored;
      if (result.error.exit === LEASE_REFUSED) {
        if (!first) first = result.error;
        declined.push({ member: step.member, word: result.error.problem });
        continue;
      }
      return err(result.error);
    }
  }

  // Pick the next member and move the grant in the pick's save, then serve that lease without counting the call again.
  async #reseat(
    pool: string, held: Grant, from: { name: string; id: string } | null, request: LeaseRequest, window: HelperWindow,
    why: "exhausted" | "refused" | "left", leases: Leases, caller: HandOffCaller, onSwap: () => void,
  ): Promise<Result<{ connection: string; lease: string }, KeyPoolFailure> | { retry: true }> {
    const names = this.#deps.store.load(pool).pool?.members.map(member => member.credential);
    const taken = await this.#choose(pool, async member => {
      const swapped = leases.swap(from, member, request, window, from ? undefined : names);
      if (swapped.ok) onSwap();
      return swapped;
    }, {
      skip: [held.member],
      also: (current, member, value, now) => {
        const moved = moveGrant(current, held.id, { member, lease: value.id, window, movedAt: now }, why, now);
        return moved.ok ? ok(moved.value) : fail(moved.error);
      },
    });
    if (!taken.ok) {
      if (taken.error.problem === "closed" || taken.error.problem === "conflict" || taken.error.problem === "held") return { retry: true };
      return taken;
    }
    const fresh = keyLease(this.#deps.connections.load().directory, taken.value.value.id);
    if (!fresh) return fail("missing");
    return this.#serve(leases, pool, held, fresh.name, fresh.row, caller);
  }

  // The audit line is written before this returns, so the caller prints after it. The window, the session and the member
  // lent are recorded in one save, and only when one of them changed.
  #serve(leases: Pick<LeaseService, "serve">, pool: string, held: Grant, connection: string, row: Lease, caller: HandOffCaller): Result<{ connection: string; lease: string }, KeyPoolFailure> | { retry: true } {
    const window = { calls: row.calls, windowStart: row.windowStart };
    const session = this.#session(held.holder, caller.id.pid);
    const touched = this.#change(pool, current => {
      const noted = touchGrant(current, held.id, window);
      const withSession = session ? noteSeen(noted, held.id, sessionKey(session), connection) : noted;
      return { pool: noteLent(withSession, held.id, connection), result: ok(undefined) };
    });
    if (!touched.ok) return touched.error.problem === "conflict" ? { retry: true } : touched;
    const served = leases.serve(connection, row.id, {
      pid: caller.id.pid, ppid: caller.ppid, lane: held.holder.lane, workspace: held.request.workspacePath,
      isolation: row.isolation, proof: "claimed",
    });
    if (!served.ok) return err(served.error);
    return ok({ connection, lease: row.id });
  }

  #note(
    name: string, member: string, declined: readonly { member: string; word: string }[], previous: string | null,
    extra?: (pool: KeyPool, now: number) => Result<KeyPool, Failure>,
  ): Result<void, Failure> {
    return this.#change(name, (pool, now) => {
      const restored = pool.policy.mode === "drain" && declined.length > 0 ? releaseKey(pool, member, previous) : pool;
      const picked = keyPicked(restored, member, declined, now);
      if (!extra) return { pool: picked, result: ok(undefined) };
      const more = extra(picked, now);
      return more.ok ? { pool: more.value, result: ok(undefined) } : { pool, result: more };
    });
  }

  #holds(holder: Holder, caller: ProcId): boolean {
    const same = (id: ProcId) => id.pid === holder.pid && id.startedAt === holder.startedAt && id.bootId === holder.bootId;
    return same(caller) || this.#deps.processes.ancestors(caller.pid).some(same);
  }

  // Ancestors are child first and include the caller's own pid. The session is the entry just below the holder.
  #session(holder: Holder, pid: number): ProcId | null {
    const chain = this.#deps.processes.ancestors(pid);
    const at = chain.findIndex(row => row.pid === holder.pid && row.startedAt === holder.startedAt && row.bootId === holder.bootId);
    if (at <= 0) return null;
    return chain[at - 1] ?? null;
  }

  #sessionKey(holder: Holder, pid: number): string | null {
    const session = this.#session(holder, pid);
    return session ? sessionKey(session) : null;
  }

  #rewind(name: string, member: string, previous: string | null): Result<void, Failure> {
    return this.#change(name, pool => ({ pool: releaseKey(pool, member, previous), result: ok(undefined) }));
  }

  #mayReport(member: string, outcome: Outcome, by: ReportBy): Result<void, Failure> {
    if (by.kind === "operator") return ok(undefined);
    if (by.kind === "principal") {
      if (!isPrincipal(by)) return fail("principal");
      return MARKS.has(outcome.kind) ? ok(undefined) : fail("not_allowed");
    }
    if (!MARKS.has(outcome.kind)) return fail("not_allowed");
    const open = openKeyLease(this.#deps.connections.load().directory, by.lease);
    if (!open) return fail("lease_missing");
    if (open.name !== member) return fail("lease_other_member");
    const same = (id: { pid: number; startedAt: number; bootId: string }) =>
      id.pid === open.holder.pid && id.startedAt === open.holder.startedAt && id.bootId === open.holder.bootId;
    if (same(by.caller) || this.#deps.processes.ancestors(by.caller.pid).some(same)) return ok(undefined);
    return fail("not_holder");
  }

  #terms(pool: KeyPool): Result<void, KeyPoolFailure> {
    const revision = this.#deps.catalog.keyPool(pool.vendor)?.termsRevision;
    if (!revision || pool.terms?.revision !== revision) return err({ problem: "terms", exit: LEASE_REFUSED });
    return ok(undefined);
  }

  #names(): Names {
    const listed = this.#deps.store.names();
    return {
      connections: this.#deps.connections.load().directory.connections.map(connection => connection.name),
      pools: listed.live,
      deleted: listed.deleted,
    };
  }

  #elsewhere(except?: string): string[] {
    const names: string[] = [];
    for (const poolName of this.#deps.store.names().live) {
      if (poolName === except) continue;
      const { pool } = this.#deps.store.load(poolName);
      if (!pool) continue;
      for (const member of pool.members) names.push(member.credential);
    }
    return names;
  }

  #view(pool: KeyPool): PoolView {
    return {
      name: pool.name,
      runtime: pool.runtime,
      vendor: pool.vendor,
      mode: pool.policy.mode,
      recheckEveryMs: pool.policy.recheckEveryMs,
      standing: pool.standing,
      termsRevision: pool.terms?.revision ?? null,
      lastPick: pool.lastPick,
      members: pool.members.map(member => ({
        credential: member.credential,
        state: member.health.state,
        reason: member.health.state === "active" ? null : member.health.reason,
        since: member.since,
        nextCheck: member.nextCheck,
      })),
      probe: {
        costUsd: KEY_PROBE_COST_USD,
        last24h: pool.events.filter(event => event.type === "ProbeClaimed" && event.at > this.#deps.clock.now() - DAY_MS).length,
      },
    };
  }

  // Empty, and at least one member is due: the pick probes before it chooses. A live claim makes the member not due.
  #dueToProbe(name: string): boolean {
    const loaded = this.#deps.store.load(name);
    if (!loaded.pool || loaded.pool.standing !== "empty") return false;
    return dueMembers(loaded.pool, this.#deps.clock.now()).length > 0;
  }

  async #ask(member: string, id: string, request: { connection: string; model: string; baseUrl: string }): Promise<ProbeAnswer> {
    let reached = false;
    let signal: ProviderSignal | null = null;
    try {
      const answer = await this.#deps.probe.probe(request);
      if ("signal" in answer) { reached = true; signal = answer.signal; }
    } catch {
      reached = false;
    } finally {
      this.#deps.leases.close(member, id, reached ? "done" : "failed", reached ? KEY_PROBE_COST_USD : null);
    }
    return signal === null ? { unreachable: true } : { signal };
  }

  #joined(name: string, members: readonly string[]): Result<void, Failure> {
    if (!this.#routing) return ok(undefined);
    return this.#routing.joined(name, members);
  }

  #left(pool: string, leaving: readonly string[], remaining: readonly string[]): Result<void, Failure> {
    if (!this.#routing) return ok(undefined);
    return this.#routing.left(pool, leaving, remaining);
  }

  #alerts(before: KeyPool, after: KeyPool): void {
    for (const event of newKeyPoolEvents(before, after)) this.#raise(after.name, event);
  }

  #raise(pool: string, event: KeyPoolEvent): void {
    if (event.type === "KeyExhausted") this.#deps.alerts.raise({ kind: "key-exhausted", name: event.member, detail: event.reason });
    else if (event.type === "KeyFailed") this.#deps.alerts.raise({ kind: "key-failing", name: event.member, detail: event.reason });
    else if (event.type === "PoolEmpty") this.#deps.alerts.raise({ kind: "pool-empty", name: pool, detail: "empty" });
    else if (event.type === "PoolBlocked") this.#deps.alerts.raise({ kind: "pool-blocked", name: event.member, detail: event.reason });
  }

  #attributed(pool: string, grant: string, session?: string | null): Result<{ member: string; suspect: string | null }, Failure> {
    const helper = this.#deps.helper;
    return this.#change(pool, (current, now) => {
      const next = attributeToGrant(current, grant, now, helper.ttlMs, session);
      if (!next.ok) return { pool: current, result: fail("grant_missing") };
      return { pool: next.value.pool, result: ok({ member: next.value.member, suspect: next.value.suspect }) };
    });
  }

  #change<T>(name: string, step: (pool: KeyPool, now: number) => { pool: KeyPool; result: Result<T, Failure> }): Result<T, Failure> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const loaded = this.#deps.store.load(name);
      if (!loaded.pool) return fail("missing");
      const out = step(loaded.pool, this.#deps.clock.now());
      if (out.pool === loaded.pool) return out.result;
      if (!this.#deps.store.save(out.pool, loaded.version)) continue;
      this.#alerts(loaded.pool, out.pool);
      return out.result;
    }
    return fail("conflict");
  }
}

function keyLease(directory: Directory, id: string): { name: string; row: Lease } | null {
  for (const connection of directory.connections) {
    if (!isKey(connection)) continue;
    const row = connection.leases.find(lease => lease.id === id);
    if (row) return { name: connection.name, row };
  }
  return null;
}

function sameHolder(a: Holder, b: Holder): boolean {
  return a.node === b.node && a.pid === b.pid && a.startedAt === b.startedAt && a.bootId === b.bootId && a.lane === b.lane;
}

// A live lease of this holder on a pool member the grant does not already name: the swap that landed, whose grant save did not.
function adoptable(directory: Directory, pool: KeyPool, held: Grant): { name: string; row: Lease } | null {
  const members = new Set(pool.members.map(member => member.credential));
  for (const connection of directory.connections) {
    if (!isKey(connection) || !members.has(connection.name)) continue;
    for (const row of connection.leases) {
      if (row.authority !== "live" || row.id === held.lease || !sameHolder(row.holder, held.holder)) continue;
      return { name: connection.name, row };
    }
  }
  return null;
}

function probeBase(catalog: Catalog, pool: KeyPool): string {
  const runtime = findPreset(catalog, pool.vendor)?.runtimes.find(row => row.runtime === pool.runtime);
  return runtime?.baseUrl ?? "";
}

function probed(member: string, outcome: Outcome, active: boolean, why: ProbeWhy): ProbeResult {
  switch (outcome.kind) {
    case "ok":
      if (why === "suspect" && outcome.evidence === "messages" && active) return { member, outcome: "healthy" };
      return { member, outcome: active ? "recovered" : "unknown" };
    case "exhausted": return { member, outcome: "exhausted" };
    case "failing": return { member, outcome: "failing" };
    case "limited": return { member, outcome: "limited" };
    case "unknown": return { member, outcome: "unknown" };
    default: return unreachable(outcome);
  }
}

function blocked(pool: KeyPool): Result<never, KeyPoolFailure> {
  const member = pool.members.find(row => row.health.state === "failing");
  return err({ problem: "pool_blocked", exit: LEASE_REFUSED, ...(member ? { member: member.credential } : {}) });
}

function isRetry(result: { retry: true } | Result<unknown, Failure>): result is { retry: true } {
  return "retry" in result;
}
