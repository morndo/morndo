// A lease is recorded in the store before anything is launched (ADR-0018, CN8, CN9).
import {
  LEASE_REFUSED, closeLease, findConnection, lease, loseLease, noteHelper, refresh, serveKey, swapLease,
  type Directory, type HelperWindow, type KeyCaller,
} from "@morndo/domain";
import { dialectOf, findPreset, floorOf } from "./catalog.ts";
import type { Deps, Failure, LeaseRequest, ProcId } from "./ports.ts";
import { raiseThresholds } from "./thresholds.ts";
import { err, ok, type Result } from "@morndo/domain";

const GATE = new Set(["off", "terms", "expired", "repo", "isolation", "dialect", "leases", "budget"]);

export class LeaseService {
  readonly #deps: Deps;
  constructor(deps: Deps) { this.#deps = deps; }

  lease(name: string, request: LeaseRequest): Result<{ id: string }, Failure> {
    const workspace = this.#deps.repos.inspect(request.workspacePath);
    const runtime = { isolation: this.#deps.runtime.isolation(), dialects: this.#deps.runtime.dialects() };
    for (let attempt = 0; attempt < 8; attempt++) {
      const { directory, policy, version } = this.#deps.store.load();
      const current = findConnection(directory, name);
      if (!current) return err({ problem: "missing" });
      const preset = findPreset(this.#deps.catalog, current.vendor);
      if (!preset) return err({ problem: "missing" });
      const asked = lease(directory, name, {
        now: this.#deps.clock.now(),
        revision: preset.terms.revision,
        workspace,
        dialect: dialectOf(preset, current.runtime),
        runtime,
        floor: floorOf(preset),
        limit: request.limit,
        reserve: request.reserve,
        margin: request.margin,
        probe: request.probe,
        holder: request.holder,
        role: request.role,
        entry: request.entry,
        runtimeName: current.runtime,
      });
      if (!asked.ok) {
        if (asked.error.directory && !this.#deps.store.save(asked.error.directory, policy, version)) continue;
        const exit = GATE.has(asked.error.problem) ? LEASE_REFUSED : undefined;
        return err(exit === undefined ? { problem: asked.error.problem } : { problem: asked.error.problem, exit });
      }
      if (!this.#deps.store.save(asked.value, policy, version)) continue;
      raiseThresholds(directory.events, asked.value.events, this.#deps.alerts);
      const granted = asked.value.events.slice(directory.events.length).find(event => event.type === "LeaseGranted" && event.name === name);
      if (granted?.type !== "LeaseGranted") return err({ problem: "missing" });
      return ok({ id: granted.lease });
    }
    return err({ problem: "conflict" });
  }

  // The same compare-and-save as `lease`, with the old lease closed in that one directory write. A `closed` refusal has
  // no directory: the lease was already swapped, and nothing here is saved.
  swap(from: { name: string; id: string } | null, to: string, request: LeaseRequest, window: HelperWindow): Result<{ id: string }, Failure> {
    const workspace = this.#deps.repos.inspect(request.workspacePath);
    const runtime = { isolation: this.#deps.runtime.isolation(), dialects: this.#deps.runtime.dialects() };
    const close = from ? { connection: from.name, lease: from.id } : null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { directory, policy, version } = this.#deps.store.load();
      const current = findConnection(directory, to);
      if (!current) return err({ problem: "missing" });
      const preset = findPreset(this.#deps.catalog, current.vendor);
      if (!preset) return err({ problem: "missing" });
      const asked = swapLease(directory, to, {
        now: this.#deps.clock.now(),
        revision: preset.terms.revision,
        workspace,
        dialect: dialectOf(preset, current.runtime),
        runtime,
        floor: floorOf(preset),
        limit: request.limit,
        reserve: request.reserve,
        margin: request.margin,
        probe: request.probe,
        holder: request.holder,
        role: request.role,
        entry: request.entry,
        runtimeName: current.runtime,
      }, close, window);
      if (!asked.ok) {
        if (asked.error.problem === "closed") return err({ problem: "closed" });
        if (asked.error.directory && !this.#deps.store.save(asked.error.directory, policy, version)) continue;
        const exit = GATE.has(asked.error.problem) ? LEASE_REFUSED : undefined;
        return err(exit === undefined ? { problem: asked.error.problem } : { problem: asked.error.problem, exit });
      }
      if (!this.#deps.store.save(asked.value, policy, version)) continue;
      raiseThresholds(directory.events, asked.value.events, this.#deps.alerts);
      const granted = asked.value.events.slice(directory.events.length).find(event => event.type === "LeaseGranted" && event.name === to);
      if (granted?.type !== "LeaseGranted") return err({ problem: "missing" });
      return ok({ id: granted.lease });
    }
    return err({ problem: "conflict" });
  }

  refresh(name: string, id: string, margin = 0): Result<void, Failure> {
    return this.#step(name, (directory, revision, now) => refresh(directory, name, id, now, revision, margin));
  }

  close(name: string, id: string, outcome: string, cost: number | null): Result<void, Failure> {
    const metered = this.#deps.spend.fromRun({ cost });
    if (metered !== null && !Number.isFinite(metered)) return err({ problem: "budget" });
    return this.#step(name, (directory, _revision, now) => {
      const current = findConnection(directory, name);
      const row = current && current.custody === "morndo" ? current.leases.find(leaseRow => leaseRow.id === id) : undefined;
      const duration = row ? now - row.start : null;
      const amount = metered ?? row?.reservation ?? 0; // no reported cost: charge the reservation only
      return closeLease(directory, name, id, outcome, amount, "estimate", { kind: "operator" }, now, duration);
    });
  }

  helper(name: string, id: string, caller: ProcId, limit: number, intervalMs: number): Result<void, Failure> {
    const ancestors = this.#deps.processes.ancestors(caller.pid);
    for (let attempt = 0; attempt < 8; attempt++) {
      const { directory, policy, version } = this.#deps.store.load();
      const noted = noteHelper(directory, name, id, caller, ancestors, limit, intervalMs, this.#deps.clock.now());
      if (!noted.ok) return err({ problem: noted.error.problem });
      if (!this.#deps.store.save(noted.value, policy, version)) continue;
      const ended = noted.value.events.slice(directory.events.length).find(event => event.type === "AuthorityEnded");
      if (ended?.type === "AuthorityEnded") this.#deps.alerts.raise({ kind: "authority", name, detail: ended.reason });
      return ok(undefined);
    }
    return err({ problem: "conflict" });
  }

  // The audit line lands before the key is printed, so a served key is always one that was recorded.
  serve(name: string, id: string, caller: KeyCaller): Result<void, Failure> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { directory, policy, version } = this.#deps.store.load();
      const served = serveKey(directory, name, id, caller, this.#deps.clock.now());
      if (!served.ok) return err({ problem: served.error.problem });
      if (!this.#deps.store.save(served.value, policy, version)) continue;
      return ok(undefined);
    }
    return err({ problem: "conflict" });
  }

  sweep(): Result<number, Failure> {
    const seen = this.#deps.store.load();
    const gone = new Set<string>();
    for (const connection of seen.directory.connections) {
      if (connection.custody !== "morndo") continue;
      for (const row of connection.leases) {
        if (this.#deps.processes.alive(row.holder)) continue;
        gone.add(holderKey(row.holder));
      }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      let { directory, policy, version } = this.#deps.store.load();
      let closed = 0;
      for (const connection of directory.connections) {
        if (connection.custody !== "morndo") continue;
        for (const row of connection.leases) {
          if (!gone.has(holderKey(row.holder))) continue;
          const lost = loseLease(directory, connection.name, row.id, this.#deps.clock.now());
          if (!lost.ok) continue;
          directory = lost.value;
          closed += 1;
        }
      }
      if (closed === 0) return ok(0);
      if (this.#deps.store.save(directory, policy, version)) return ok(closed);
    }
    return err({ problem: "conflict" });
  }

  #step(name: string, step: (directory: Directory, revision: string, now: number) => Result<Directory, { problem: string }>): Result<void, Failure> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { directory, policy, version } = this.#deps.store.load();
      const current = findConnection(directory, name);
      const preset = current ? findPreset(this.#deps.catalog, current.vendor) : null;
      if (!preset) return err({ problem: "missing" });
      const next = step(directory, preset.terms.revision, this.#deps.clock.now());
      if (!next.ok) return err({ problem: next.error.problem });
      if (!this.#deps.store.save(next.value, policy, version)) continue;
      const refused = next.value.events.slice(directory.events.length).find(event => event.type === "LeaseRefreshRefused");
      raiseThresholds(directory.events, next.value.events, this.#deps.alerts);
      if (refused?.type === "LeaseRefreshRefused") return err({ problem: refused.reason });
      return ok(undefined);
    }
    return err({ problem: "conflict" });
  }
}

function holderKey(holder: { pid: number; startedAt: number; bootId: string }): string {
  return `${holder.pid}:${holder.startedAt}:${holder.bootId}`;
}
