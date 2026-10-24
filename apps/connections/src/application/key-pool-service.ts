// The key pool's service (ADR-0037): load the pool, apply one domain function, save on the version read, and retry a lost
// save up to 8 times. Creating a pool is one save. A pick saves the ring position before the attempt, and writes the pick
// after it returns. Alerts name a member or the pool and a reason word; a provider's text never lands here.
import {
  LEASE_REFUSED, acknowledgeKeyPoolTerms, chooseKey, createKeyPool, err, findConnection, joinKeyPool, keyPicked, keyRotated,
  leaveKeyPool, moveKeyMember, newKeyPoolEvents, ok, reportKeyOutcome, reviveKey, setKeyPoolPolicy, settleKeyPool,
  KEY_POOL_RECHECK_DEFAULT_MS,
  type Actor, type Directory, type KeyPool, type KeyPoolEvent, type Names, type Outcome, type Result, type RotationMode,
  type RotationPolicy, type Standing,
} from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { AlertSink, Catalog, Classifiers, Clock, ConnectionLifecycle, ConnectionStore, Failure, KeyPoolStore, ProviderSignal } from "./ports.ts";

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
  classifiers: Classifiers;
};
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
  | { kind: "go"; member: string }
  | { kind: "empty" }
  | { kind: "stop"; error: KeyPoolFailure };

const ATTEMPTS = 8;
const fail = (problem: string): Result<never, Failure> => err({ problem });

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
    const preset = findPreset(this.#deps.catalog, input.vendor);
    if (!preset?.keyPool) return fail("no_classifier");
    if (input.by === "") return fail("ack_needed");
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
    const acked = acknowledgeKeyPoolTerms(pool, preset.keyPool.termsRevision, input.by, actor, now);
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

  leave(pool: string, member: string): Result<void, Failure> {
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

  setPolicy(pool: string, change: Partial<RotationPolicy>, by: string | null): Result<void, Failure> {
    return this.#change(pool, (current, now) => {
      const next = setKeyPoolPolicy(current, change, by, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  revive(pool: string, member: string, actor: Actor): Result<void, Failure> {
    return this.#change(pool, (current, now) => {
      const next = reviveKey(current, member, actor, now);
      return next.ok ? { pool: next.value, result: ok(undefined) } : { pool: current, result: fail(next.error) };
    });
  }

  delete(pool: string): Result<void, Failure> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const loaded = this.#deps.store.load(pool);
      if (!loaded.pool) return fail("missing");
      if (this.#deps.store.tombstone(pool, loaded.version, this.#deps.clock.now())) return ok(undefined);
    }
    return fail("conflict");
  }

  report(pool: string, member: string, outcome: Outcome, observedAt: number, via?: "probe" | "report"): Result<void, Failure> {
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
    const preset = findPreset(this.#deps.catalog, loaded.pool.vendor);
    const dialect = preset?.keyPool?.errorDialect;
    if (!dialect) return fail("no_classifier");
    const classifier = this.#deps.classifiers.for(dialect);
    if (!classifier) return fail("no_classifier");
    const outcome = classifier.classify(signal);
    if (outcome.kind === "unknown" && signal.status !== null && signal.status >= 400 && signal.status <= 499) {
      this.#deps.alerts.raise({ kind: "unclassified", name: member, detail: `${signal.status} ${signal.kind ?? "-"}` });
    }
    const reported = this.report(pool, member, outcome, observedAt);
    return reported.ok ? ok(outcome) : reported;
  }

  // Everything before the first `await` is synchronous, so two picks started together each see the ring position the
  // other already saved. A gate refusal (exit 75) tries the next member; any other failure stops.
  async pick<T>(pool: string, attempt: (member: string) => Promise<Result<T, Failure>>): Promise<Result<{ member: string; value: T }, KeyPoolFailure>> {
    const declined: { member: string; word: string }[] = [];
    let first: Failure | null = null;
    for (;;) {
      const step = this.#advance(pool, declined.map(row => row.member));
      if (step.kind === "stop") return err(step.error);
      if (step.kind === "empty") return err(first ?? { problem: "none_left", exit: LEASE_REFUSED });
      const result = await attempt(step.member);
      if (result.ok) {
        const noted = this.#note(pool, step.member, declined);
        if (!noted.ok) return noted;
        return ok({ member: step.member, value: result.value });
      }
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
      if (decision.value.pool !== loaded.pool) {
        if (!this.#deps.store.save(decision.value.pool, loaded.version)) { attempt += 1; continue; }
        this.#alerts(loaded.pool, decision.value.pool);
      }
      return { kind: "go", member: decision.value.member };
    }
    return { kind: "stop", error: { problem: "conflict" } };
  }

  #note(name: string, member: string, declined: readonly { member: string; word: string }[]): Result<void, Failure> {
    return this.#change(name, (pool, now) => ({ pool: keyPicked(pool, member, declined, now), result: ok(undefined) }));
  }

  #terms(pool: KeyPool): Result<void, KeyPoolFailure> {
    const revision = findPreset(this.#deps.catalog, pool.vendor)?.keyPool?.termsRevision;
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
