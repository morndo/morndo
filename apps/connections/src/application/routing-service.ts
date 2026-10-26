// The routing policy is saved whole, then written through EngineSettings. A chain changed outside is drift (R7–R15).
import {
  engineText, ensureRole, findConnection, observeDrift, parseEngine, planWrites, prepareWrite, project, sameOrder, switchesAuto,
  setOverride, setPicks, setPriority, setRole, withPools, type AutoAuthority, type Engine, type Listed, type Mode, type Override, type Policy, type Priority,
} from "@morndo/domain";
import { err, ok, type Result } from "@morndo/domain";
import type { Deps, Failure, PoolNames } from "./ports.ts";
import { blockedRemoval, syncRevoked } from "./providers.ts";

export class RoutingService {
  readonly #deps: Deps;
  readonly #pools: () => readonly PoolNames[];
  constructor(deps: Deps, pools: () => readonly PoolNames[] = () => []) {
    this.#deps = deps;
    this.#pools = pools;
  }

  setPriority(mode: Mode, order: readonly string[], command: string): Result<void, Failure> {
    return this.#policy(policy => setPriority(policy, { mode, order }, this.#listed(), command, this.#deps.clock.now()));
  }

  // A page command is one check, then one persist. A refusal or a failed chain write leaves the stored policy as it was.
  // The caller says the authority: only the hub has checked a fresh passkey, and nothing in the body counts.
  commitPriority(mode: Mode, order: readonly string[], command: string, auto?: boolean, authority: AutoAuthority = "session"): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    const sent = withPools(order, policy.priority.order, this.#poolNames(directory));
    const priority = auto === undefined ? { mode, order: sent } : { mode, order: sent, auto };
    const next = setPriority(policy, priority, this.#listed(directory), command, this.#deps.clock.now(), authority);
    if (!next.ok) return problem(next.error);
    // R16: an auto-only switch writes no chain, pending or not; it only saves the policy.
    if (switchesAuto(policy, priority) && sameOrder(policy.priority, mode, sent)) {
      return this.#deps.store.save(directory, next.value, version) ? ok(undefined) : err({ problem: "conflict" });
    }
    return this.#write(directory, next.value, version, this.#deps.engines.chains(), policy);
  }

  commitRole(
    role: string, override: Override, priority: Priority | null, texts: readonly string[], risk: readonly string[] | null | undefined, command: string,
  ): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    const kept = policy.roles.find(item => item.role === role)?.riskPicks?.map(engineText) ?? null;
    const riskTexts = risk === undefined ? kept : risk === null || risk.length === 0 ? null : risk;
    const parsed = parsedPicks(texts, riskTexts, role);
    if (!parsed.ok) return parsed;
    const own = policy.roles.find(item => item.role === role)?.priority?.order ?? [];
    const sent = priority === null ? null : { ...priority, order: withPools(priority.order, own, this.#poolNames(directory)) };
    const next = setRole(policy, role, override, sent, parsed.value.picks, parsed.value.riskPicks, this.#listed(directory), command, this.#deps.clock.now());
    if (!next.ok) {
      const detail = next.error.name?.includes(":") ? ` ${next.error.name}` : "";
      return err({ problem: `${next.error.problem}${detail}`, ...(next.error.role ? { role: next.error.role } : {}) });
    }
    return this.#write(directory, next.value, version, this.#deps.engines.chains(), policy);
  }

  setOverride(role: string, override: Override, priority: Priority | null, command: string): Result<void, Failure> {
    return this.#policy(policy => setOverride(ensureRole(policy, role), role, override, priority, this.#listed(), command, this.#deps.clock.now()));
  }

  followAll(roles: readonly string[], outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[]): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    let next = policy;
    for (const name of roles) {
      const row = next.roles.find(item => item.role === name);
      if (!row || row.picks.length === 0) continue;
      const set = setOverride(ensureRole(next, name), name, "follow", null, this.#listed(), "cli", this.#deps.clock.now());
      if (!set.ok) return err({ problem: set.error.problem, ...(set.error.role ? { role: set.error.role } : {}) });
      next = set.value;
    }
    return this.#write(directory, next, version, outside);
  }

  setPicks(role: string, texts: readonly string[], risk: readonly string[] | null, command: string): Result<void, Failure> {
    const parsed = parsedPicks(texts, risk, role);
    if (!parsed.ok) return parsed;
    const { picks, riskPicks } = parsed.value;
    return this.#policy(policy => setPicks(ensureRole(policy, role), role, picks, riskPicks, this.#listed(), command, this.#deps.clock.now()));
  }

  // Writes every derived chain, or refuses the whole save and names the role. A drifted role is left as it stands.
  save(): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    return this.#write(directory, policy, version, this.#deps.engines.chains());
  }

  // Fold or unfold a pool, then derive chains the same way a priority save does. An unchanged policy still goes through
  // the write; a chain that already matches is left as it stands.
  refold(step: (policy: Policy, listed: readonly Listed[]) => Policy): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    const next = step(policy, this.#listed(directory));
    return this.#write(directory, next, version, this.#deps.engines.chains(), policy);
  }

  #write(
    directory: ReturnType<Deps["store"]["load"]>["directory"], policy: Policy, version: number,
    outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[],
    baseline: Policy = policy,
  ): Result<void, Failure> {
    const known = this.#kinds();
    const decided = planWrites(policy, known, outside);
    if (!decided.ok) {
      const role = decided.error.role;
      return err(role === undefined ? { problem: decided.error.problem } : { problem: decided.error.problem, role });
    }
    const planned = decided.value;
    let next = policy;
    for (const row of planned) {
      const projected = project(next, row.role, known, this.#deps.clock.now());
      if (!projected.ok) return err({ problem: projected.error.problem, role: row.role });
      next = projected.value;
    }
    const blocked = blockedRemoval(directory, next, this.#deps.engines, projectedChains(outside, planned));
    if (blocked) return err({ problem: `${blocked.name} is still in ${blocked.roles.join(", ")}'s chain` });
    if (planned.length === 0) {
      if (!this.#deps.store.save(directory, policy, version)) return err({ problem: "conflict" });
      syncRevoked(directory, policy, this.#deps.engines);
      return ok(undefined);
    }
    if (!this.#deps.store.save(directory, next, version)) return err({ problem: "conflict" });
    const previous = new Map(outside.map(chain => [chain.role, chain]));
    let failed = planned[0]?.role ?? "";
    try {
      for (const row of planned) {
        failed = row.role;
        if (row.keep) this.#deps.alerts.raise({ kind: "kept", name: row.role, detail: "empty" });
        else this.#deps.engines.setChain(row.role, row.chain, row.risk);
      }
    } catch {
      for (const row of planned) {
        if (row.keep) continue;
        const prior = previous.get(row.role);
        if (!prior) continue;
        try { this.#deps.engines.setChain(row.role, prior.chain, prior.risk); } catch { /* the policy rollback is what the caller can see */ }
      }
      if (!this.#deps.store.save(directory, baseline, version + 1)) return err({ problem: "rollback", role: failed });
      return err({ problem: "conflict", role: failed });
    }
    syncRevoked(directory, next, this.#deps.engines);
    return ok(undefined);
  }

  drift(): readonly string[] {
    const { directory, policy, version } = this.#deps.store.load();
    const found: string[] = [];
    let next = policy;
    const outside = this.#deps.engines.chains();
    for (const row of policy.roles) {
      const seen = outside.find(chain => chain.role === row.role);
      if (!seen) continue;
      const observed = observeDrift(next, row.role, seen.chain, seen.risk, this.#deps.clock.now());
      next = observed.policy;
      if (observed.alert) found.push(row.role);
    }
    if (next === policy) return found;
    if (!this.#deps.store.save(directory, next, version)) return [];
    for (const role of found) this.#deps.alerts.raise({ kind: "drift", name: role, detail: "changed outside" });
    return found;
  }

  reapply(role: string): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    const known = this.#kinds();
    const row = policy.roles.find(item => item.role === role);
    if (!row || row.override === "hand") return err({ problem: "same", role });
    const prepared = prepareWrite(policy, row, known, "force");
    if (!prepared.ok) return err({ problem: prepared.error.problem, role });
    if (!prepared.value) return ok(undefined);
    const { chain, risk } = prepared.value;
    const projected = project(policy, role, known, this.#deps.clock.now());
    if (!projected.ok) return err({ problem: projected.error.problem, role });
    if (!this.#deps.store.save(directory, projected.value, version)) return err({ problem: "conflict" });
    try {
      if (chain.length === 0) this.#deps.alerts.raise({ kind: "kept", name: role, detail: "empty" });
      else this.#deps.engines.setChain(role, chain, risk);
    } catch {
      if (!this.#deps.store.save(directory, policy, version + 1)) return err({ problem: "rollback", role });
      return err({ problem: "conflict", role });
    }
    syncRevoked(directory, projected.value, this.#deps.engines);
    return ok(undefined);
  }

  #kinds() {
    const rows = this.#live().map(connection => ({ name: connection.name, kind: connection.kind }));
    const seen = new Set(rows.map(row => row.name));
    for (const pool of this.#pools()) {
      if (seen.has(pool.name)) continue;
      seen.add(pool.name);
      rows.push({ name: pool.name, kind: "api-key" });
    }
    return rows;
  }

  #listed(directory = this.#deps.store.load().directory): Listed[] {
    const rows: Listed[] = directory.connections.filter(connection => connection.status !== "revoked").map(connection => {
      const models = this.#deps.models.models({ name: connection.name, vendor: connection.vendor });
      return { name: connection.name, kind: connection.kind, models: models.map(row => row.id), efforts: models[0]?.efforts ?? null };
    });
    const seen = new Set(rows.map(row => row.name));
    for (const pool of this.#pools()) {
      if (seen.has(pool.name)) continue;
      seen.add(pool.name);
      const listing = this.#poolModels(directory, pool.members);
      rows.push({ name: pool.name, kind: "api-key", models: listing.models, efforts: listing.efforts });
    }
    return rows;
  }

  // A pool never replaces a Connection of the same name, and never appears twice.
  #poolNames(directory: ReturnType<Deps["store"]["load"]>["directory"]): string[] {
    const seen = new Set(directory.connections.filter(connection => connection.status !== "revoked").map(connection => connection.name));
    const names: string[] = [];
    for (const pool of this.#pools()) {
      if (seen.has(pool.name)) continue;
      seen.add(pool.name);
      names.push(pool.name);
    }
    return names;
  }

  #poolModels(directory: ReturnType<Deps["store"]["load"]>["directory"], members: readonly string[]): { models: string[]; efforts: readonly string[] | null } {
    for (const name of members) {
      const connection = findConnection(directory, name);
      if (!connection || connection.status === "revoked") continue;
      const rows = this.#deps.models.models({ name, vendor: connection.vendor });
      if (rows.length === 0) continue;
      return { models: rows.map(row => row.id), efforts: rows[0]?.efforts ?? null };
    }
    return { models: [], efforts: null };
  }

  #live() {
    return this.#deps.store.load().directory.connections.filter(connection => connection.status !== "revoked");
  }

  #policy(step: (policy: Policy) => Result<Policy, { problem: string; role?: string; name?: string }>): Result<void, Failure> {
    const { directory, policy, version } = this.#deps.store.load();
    const next = step(policy);
    if (!next.ok) return err({ problem: next.error.problem, ...(next.error.role ? { role: next.error.role } : {}) });
    if (!this.#deps.store.save(directory, next.value, version)) return err({ problem: "conflict" });
    return ok(undefined);
  }
}

function projectedChains(
  outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[],
  planned: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null; keep: boolean }[],
): { role: string; chain: readonly string[]; risk: readonly string[] | null }[] {
  const writing = new Map(planned.filter(row => !row.keep).map(row => [row.role, row]));
  const merged = outside.map(row => {
    const next = writing.get(row.role);
    return next ? { role: row.role, chain: [...next.chain], risk: next.risk } : row;
  });
  for (const row of writing.values()) {
    if (!merged.some(item => item.role === row.role)) merged.push({ role: row.role, chain: [...row.chain], risk: row.risk });
  }
  return merged;
}

function problem(error: { problem: string; role?: string }): Result<void, Failure> {
  return err({ problem: error.problem, ...(error.role ? { role: error.role } : {}) });
}

function parsedPicks(texts: readonly string[], risk: readonly string[] | null, role: string): Result<{ picks: Engine[]; riskPicks: Engine[] | null }, Failure> {
  const picks = parseAll(texts);
  if (!picks) return err({ problem: "fit", role });
  const riskPicks = risk === null ? null : parseAll(risk);
  if (risk !== null && !riskPicks) return err({ problem: "fit", role });
  return ok({ picks, riskPicks });
}

function parseAll(texts: readonly string[]): Engine[] | null {
  const parsed: Engine[] = [];
  for (const text of texts) {
    const engine = parseEngine(text);
    if (!engine) return null;
    parsed.push(engine);
  }
  return parsed;
}
