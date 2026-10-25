// The key pool's service (ADR-0037): load the pool, apply one domain function, save on the version read, and retry a lost
// save up to 8 times. Creating a pool is one save. A pick saves the ring position before the attempt, and writes the pick
// after it returns. Alerts name a member or the pool and a reason word; a provider's text never lands here.
import {
  LEASE_REFUSED, acknowledgeKeyPoolTerms, chooseKey, createKeyPool, err, findConnection, isKey, joinKeyPool, keyPicked, keyRotated,
  leaveKeyPool, moveKeyMember, newKeyPoolEvents, ok, releaseKey, reportKeyOutcome, reviveKey, setKeyPoolPolicy, settleKeyPool,
  KEY_POOL_RECHECK_DEFAULT_MS,
  type Actor, type Directory, type KeyPool, type KeyPoolEvent, type Names, type Outcome, type Result, type RotationMode,
  type RotationPolicy, type Standing,
} from "@morndo/domain";
import type { AlertSink, Catalog, Classifiers, Clock, ConnectionLifecycle, ConnectionStore, Failure, KeyPoolStore, Processes, ProviderSignal } from "./ports.ts";

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
};

type Deps = {
  clock: Clock;
  store: KeyPoolStore;
  connections: ConnectionStore;
  catalog: Catalog;
  alerts: AlertSink;
  processes: Processes;
  classifiers: Classifiers;
};
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
const fail = (problem: string): Result<never, Failure> => err({ problem });

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
  constructor(deps: Deps) { this.#deps = deps; }

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
    return ok(undefined);
  }

  join(pool: string, member: string, own: { confirmOwn: boolean; organization?: string | null }, actor: Actor): Result<void, Failure> {
    return this.#change(pool, (current, now) => {
      const connection = findConnection(this.#deps.connections.load().directory, member);
      if (!connection) return { pool: current, result: fail("missing") };
      const next = joinKeyPool(
        current, connection, { elsewhere: this.#elsewhere(current.name) }, own.organization ?? null, own.confirmOwn, actor, now,
      );
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  leave(pool: string, member: string, actor: Actor): Result<void, Failure> {
    if (!isPrincipal(actor)) return fail("principal");
    return this.#change(pool, (current, now) => {
      const next = leaveKeyPool(current, member, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
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
      if (this.#deps.store.tombstone(pool, loaded.version, this.#deps.clock.now())) return ok(undefined);
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

  reportSignal(pool: string, member: string, signal: ProviderSignal, observedAt: number): Result<Outcome, Failure> {
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
    const reported = this.report(pool, member, outcome, observedAt, { kind: "operator" });
    return reported.ok ? ok(outcome) : reported;
  }

  // Everything before the first `await` is synchronous, so two picks started together each see the ring position the
  // other already saved. A refusal puts that reservation back before the next member is tried, or before the call returns.
  async pick<T>(pool: string, attempt: (member: string) => Promise<Result<T, Failure>>, options?: { skip?: readonly string[] }): Promise<Result<{ member: string; value: T }, KeyPoolFailure>> {
    const heldBack = options?.skip ?? [];
    const declined: { member: string; word: string }[] = [];
    let first: Failure | null = null;
    for (;;) {
      const step = this.#advance(pool, [...heldBack, ...declined.map(row => row.member)]);
      if (step.kind === "stop") return err(step.error);
      if (step.kind === "empty") return err(first ?? { problem: "none_left", exit: LEASE_REFUSED });
      const result = await attempt(step.member);
      if (result.ok) {
        const noted = this.#note(pool, step.member, declined, step.previous);
        if (!noted.ok) return noted;
        return ok({ member: step.member, value: result.value });
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
    this.#change(holder, (pool, now) => {
      const next = leaveKeyPool(pool, name, now, "revoked");
      return { pool: next.ok ? next.value : pool, result: ok(undefined) };
    });
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

  #note(name: string, member: string, declined: readonly { member: string; word: string }[], previous: string | null): Result<void, Failure> {
    return this.#change(name, (pool, now) => {
      const restored = pool.policy.mode === "drain" && declined.length > 0 ? releaseKey(pool, member, previous) : pool;
      return { pool: keyPicked(restored, member, declined, now), result: ok(undefined) };
    });
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
    };
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
