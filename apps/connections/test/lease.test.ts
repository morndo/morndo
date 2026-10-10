// The gate's order, then a lease that is stored before any launch, a refresh, a close, a reconciliation and one alert
// per threshold (ADR-0018 §13 row 2).
import { describe, expect, it } from "vitest";
import type { VendorPreset } from "@morndo/protocol";
import { spentOf, type Actor, type Holder } from "@morndo/domain";
import { AvailabilityService, ConnectionsService, LeaseService, SpendService, memory, type Memory } from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: null };

function preset(): VendorPreset {
  return {
    id: "vendor-a", label: "Vendor A", custody: "morndo", kinds: ["api-key", "subscription"],
    runtimes: [{ runtime: "runtime-a", dialect: "dialect-a", baseUrl: null }],
    models: { source: "static", ids: ["m"] }, family: "family-a", keyShapes: [], spend: ["manual"], prices: [],
    balance: null, defaultPicks: { "*": "m@high" }, isolation: "rules",
    terms: { revision: "r1", summary: "Read before use.", sources: ["https://example.com/terms"] },
  };
}

function world(): Memory {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.vault.put("ref-a", "0123456789ab");
  return mem;
}

function ask(over: Partial<{ limit: number; reserve: number; margin: number; probe: boolean; holder: Holder }> = {}) {
  return { role: "implement", entry: "key-a:m@high", holder, workspacePath: "/work/repo", limit: 2, reserve: 1, margin: 0, probe: false, ...over };
}

describe("the lease gate, one refusal per step", () => {
  it("refuses off before terms, and records the refusal", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.turnOff("key-a").ok).toBe(true);
    const refused = new LeaseService(mem.deps).lease("key-a", ask());
    expect(refused.ok ? "" : refused.error).toEqual({ problem: "off", exit: 75 });
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseRefused", reason: "off" });
    expect(mem.runtime.launches).toEqual([]);
  });

  it.each([
    ["terms", (mem: Memory) => mem],
    ["expired", (mem: Memory) => { mem.clock.at += 10; return mem; }],
    ["repo", (mem: Memory) => { mem.repos.remotes = ["host/no"]; mem.runtime.level = "os"; return mem; }],
    ["isolation", (mem: Memory) => { mem.runtime.level = "none"; return mem; }],
    ["dialect", (mem: Memory) => { mem.runtime.spoken = ["other"]; return mem; }],
  ])("refuses %s and no earlier reason", async (reason, prep) => {
    const mem = prep(world());
    const connections = new ConnectionsService(mem.deps);
    const expiry = reason === "expired" ? mem.clock.at - 1 : null;
    expect((await connections.addKey({
      name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered",
      budget: { kind: "capped", amount: 10 }, expiry,
    }, who)).ok).toBe(true);
    if (reason !== "terms") expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    if (reason === "repo") expect(connections.setRepo("key-a", { allow: [], deny: ["host/no"] }, who).ok).toBe(true);
    const refused = new LeaseService(mem.deps).lease("key-a", ask());
    expect(refused.ok ? "" : refused.error.problem, reason).toBe(reason);
    expect(refused.ok ? 0 : refused.error.exit).toBe(75);
  });

  it("refuses a second lease at the limit, then a lease that no longer fits the budget", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    expect(leases.lease("key-a", ask({ limit: 1 })).ok).toBe(true);
    const limited = leases.lease("key-a", ask({ limit: 1, holder: { ...holder, pid: 11 } }));
    expect(limited.ok ? "" : limited.error.problem).toBe("leases");
    const poor = world();
    const again = new ConnectionsService(poor.deps);
    expect((await again.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 1 }, expiry: null }, who)).ok).toBe(true);
    expect(again.acknowledge("key-a", "ada", who).ok).toBe(true);
    expect(new SpendService(poor.deps).record("key-a", 1, "estimate", { kind: "operator" }).ok).toBe(true);
    const broke = new LeaseService(poor.deps).lease("key-a", ask());
    expect(broke.ok ? "" : broke.error.problem).toBe("budget");
  });
});

describe("lease, refresh, close, reconcile, thresholds", () => {
  it("stores the grant before any launch, then refreshes and closes", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    const granted = leases.lease("key-a", ask());
    expect(granted.ok ? granted.value.id : "").toBe("l1");
    expect(mem.store.directory.events.some(event => event.type === "LeaseGranted")).toBe(true);
    expect(mem.runtime.launches).toEqual([]);
    mem.clock.at += 5;
    expect(leases.refresh("key-a", "l1").ok).toBe(true);
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseRefreshed" });
    mem.spend.cost = 2;
    expect(leases.close("key-a", "l1", "done", 2).ok).toBe(true);
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseClosed", amount: 2, source: "estimate" });
  });

  it("returns the id of the lease it just granted", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    const first = leases.lease("key-a", ask({ limit: 5 }));
    const second = leases.lease("key-a", ask({ limit: 5, holder: { ...holder, pid: 11 } }));
    expect(first.ok ? first.value.id : "").toBe("l1");
    expect(second.ok ? second.value.id : "").toBe("l2");
    const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
    expect(key && key.custody === "morndo" ? key.leases.map(row => row.id) : []).toEqual(["l1", "l2"]);
  });

  it("a refused refresh is a refusal, and the helper stops serving", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    const granted = leases.lease("key-a", ask());
    expect(connections.turnOff("key-a").ok).toBe(true);
    const refreshed = leases.refresh("key-a", granted.ok ? granted.value.id : "l1");
    expect(refreshed.ok ? "" : refreshed.error.problem).toBe("off");
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseRefreshRefused", reason: "off" });
    const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
    expect(key && key.custody === "morndo" ? key.leases[0]?.authority : "").toBe("ended");
  });

  it("records and alerts when the helper limit ends the lease", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    const granted = leases.lease("key-a", ask());
    const id = granted.ok ? granted.value.id : "l1";
    const caller = { pid: holder.pid, startedAt: holder.startedAt, bootId: holder.bootId };
    expect(leases.helper("key-a", id, caller, 1, 60_000).ok).toBe(true);
    expect(mem.alerts.raised.filter(alert => alert.detail === "helper_limit")).toEqual([]);
    expect(leases.helper("key-a", id, caller, 1, 60_000).ok).toBe(true);
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "AuthorityEnded", lease: id, reason: "helper_limit" });
    expect(mem.alerts.raised.filter(alert => alert.kind === "authority" && alert.detail === "helper_limit")).toEqual([{ kind: "authority", name: "key-a", detail: "helper_limit" }]);
    const again = leases.helper("key-a", id, caller, 1, 60_000);
    expect(again.ok ? "" : again.error.problem).toBe("closed");
    expect(mem.alerts.raised.filter(alert => alert.detail === "helper_limit")).toHaveLength(1);
    expect(mem.store.directory.events.some(event => event.type === "LeaseClosed")).toBe(false);
  });

  it("two leases that read the same snapshot cannot both pass or share an id", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 2 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    let loads = 0;
    let frozen: ReturnType<Memory["store"]["load"]> | null = null;
    const inner = mem.store;
    const store = {
      load() {
        const current = inner.load();
        loads += 1;
        if (loads === 1) frozen = current;
        if (loads === 2 && frozen) return frozen;
        return inner.load();
      },
      save: inner.save.bind(inner),
    };
    const leases = new LeaseService({ ...mem.deps, store });
    const first = leases.lease("key-a", ask({ limit: 1, reserve: 2 }));
    const second = leases.lease("key-a", ask({ limit: 1, reserve: 2, holder: { ...holder, pid: 11 } }));
    expect(first.ok ? first.value.id : "").toBe("l1");
    expect(second.ok ? "" : second.error.problem).toBe("leases");
    const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
    expect(key && key.custody === "morndo" ? key.leases.map(row => row.id) : []).toEqual(["l1"]);
  });

  it("charges the whole reservation when a run reports no cost", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    const granted = leases.lease("key-a", ask({ reserve: 3 }));
    mem.spend.cost = null;
    expect(leases.close("key-a", granted.ok ? granted.value.id : "l1", "done", null).ok).toBe(true);
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseClosed", amount: 3, source: "estimate" });
    const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
    expect(key && key.custody === "morndo" && key.kind === "api-key" ? spentOf(key.spend) : 0).toBe(3);
  });

  it("refuses a non-finite amount, and only a principal may lower spend", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const spend = new SpendService(mem.deps);
    const leases = new LeaseService(mem.deps);
    const operator = { kind: "operator" as const };
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 1 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    expect(spend.record("key-a", 5, "estimate", operator).ok).toBe(true);
    expect(spend.record("key-a", Number.NaN, "manual", operator).ok ? "" : "budget").toBe("budget");
    mem.spend.figure = Number.NaN;
    expect(spend.reconcile("key-a", operator).ok ? "" : "budget").toBe("budget");
    const broke = leases.lease("key-a", ask());
    expect(broke.ok ? "" : broke.error.problem).toBe("budget");
    const blocked = spend.record("key-a", -1, "manual", operator);
    expect(blocked.ok ? "" : blocked.error.problem).toBe("principal");
    const spent = () => {
      const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
      return key && key.custody === "morndo" && key.kind === "api-key" ? spentOf(key.spend) : 0;
    };
    expect(spent()).toBe(5);
    expect(spend.record("key-a", -5, "provider", who).ok).toBe(true);
    expect(spent()).toBe(0);
    const granted = leases.lease("key-a", ask({ reserve: 1 }));
    mem.spend.cost = Number.POSITIVE_INFINITY;
    const closed = leases.close("key-a", granted.ok ? granted.value.id : "l1", "done", Number.POSITIVE_INFINITY);
    expect(closed.ok ? "" : closed.error.problem).toBe("budget");
    expect(mem.store.directory.events.some(event => event.type === "LeaseClosed")).toBe(false);
  });

  it("reconciles a provider figure and warns once at a threshold", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const spend = new SpendService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(spend.record("key-a", 2, "estimate", { kind: "operator" }).ok).toBe(true);
    mem.spend.figure = 4;
    expect(spend.reconcile("key-a", { kind: "operator" }).ok).toBe(true);
    const key = mem.store.directory.connections.find(connection => connection.name === "key-a");
    expect(key && key.custody === "morndo" && key.kind === "api-key" ? spentOf(key.spend) : 0).toBe(4);
    expect(mem.store.directory.events.some(event => event.type === "SpendReconciled")).toBe(true);
    expect(spend.record("key-a", 1, "estimate", { kind: "operator" }).ok).toBe(true);
    expect(mem.alerts.raised.filter(alert => alert.detail === "key-a:0.5")).toHaveLength(1);
    expect(spend.record("key-a", 0, "estimate", { kind: "operator" }).ok).toBe(true);
    expect(mem.alerts.raised.filter(alert => alert.detail === "key-a:0.5")).toHaveLength(1);
  });

  it("ends a lease whose holder is gone", () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect(connections.acknowledge("sub-a", "ada", who).ok).toBe(true);
    expect(leases.lease("sub-a", ask()).ok).toBe(true);
    mem.processes.dead.add(holder.pid);
    const swept = leases.sweep();
    expect(swept.ok ? swept.value : 0).toBe(1);
    expect(mem.store.directory.events.at(-1)).toMatchObject({ type: "LeaseLost" });
  });

  it("reads the workspace once when the save is retried", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    let left = 2;
    const inner = mem.store;
    const store = {
      load: () => inner.load(),
      save: (directory: typeof inner.directory, policy: typeof inner.policy, version: number) => {
        if (left > 0) { left -= 1; return false; }
        return inner.save(directory, policy, version);
      },
    };
    const granted = new LeaseService({ ...mem.deps, store }).lease("key-a", ask());
    expect(granted.ok).toBe(true);
    expect(mem.repos.reads).toBe(1);
    expect(mem.runtime.reads).toBe(2);
  });

  it("reports a sweep that keeps losing the save", () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const leases = new LeaseService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect(connections.acknowledge("sub-a", "ada", who).ok).toBe(true);
    expect(leases.lease("sub-a", ask()).ok).toBe(true);
    mem.processes.dead.add(holder.pid);
    const inner = mem.store;
    const store = { load: () => inner.load(), save: () => false };
    const swept = new LeaseService({ ...mem.deps, store }).sweep();
    expect(swept.ok ? "" : swept.error.problem).toBe("conflict");
    expect(mem.processes.checks).toBe(1);
  });

  it("a subscription with no sign-in is marked unavailable", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    expect(connections.addSubscription({ name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", configDir: "/cfg" }, who).ok).toBe(true);
    expect(connections.acknowledge("sub-a", "ada", who).ok).toBe(true);
    mem.runtime.login = "missing";
    expect((await new AvailabilityService(mem.deps).report("sub-a"))?.state).toBe("signed_out");
    expect(mem.engines.markLog.at(-1)?.reason).toBe("morndo:signed_out");
    expect((mem.engines.markLog.at(-1)?.until ?? 0) > mem.clock.at + 60_000).toBe(true);
  });

  it("marks an unavailable connection until later, and a ready report clears only its own mark", async () => {
    const mem = world();
    const connections = new ConnectionsService(mem.deps);
    const expiry = mem.clock.at + 1_000;
    expect((await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry }, who)).ok).toBe(true);
    expect(connections.acknowledge("key-a", "ada", who).ok).toBe(true);
    mem.engines.mark("key-a", "expired", mem.clock.at - 1);
    const availability = new AvailabilityService(mem.deps);
    expect((await availability.report("key-a"))?.state).toBe("ready");
    expect(mem.engines.unmarked).toEqual([]);
    mem.clock.at = expiry + 1;
    expect((await availability.report("key-a"))?.state).toBe("expired");
    expect(mem.engines.markLog.at(-1)?.reason).toBe("morndo:expired");
    expect((mem.engines.markLog.at(-1)?.until ?? 0) > mem.clock.at + 60_000).toBe(true);
    expect(connections.setExpiry("key-a", mem.clock.at + 1_000, who).ok).toBe(true);
    expect((await new AvailabilityService(mem.deps).report("key-a"))?.state).toBe("ready");
    expect(mem.engines.unmarked).toEqual(["key-a"]);
  });

  it("refuses a connection the preset does not offer", async () => {
    const mem = world();
    mem.catalog.rows = [{ ...preset(), kinds: ["subscription"], custody: "engine-layer" }];
    const connections = new ConnectionsService(mem.deps);
    const key = (await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "nope", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who));
    expect(key.ok ? "" : key.error.problem).toBe("kind");
    mem.catalog.rows = [{ ...preset(), kinds: ["api-key"] }];
    const runtime = (await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "nope", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who));
    expect(runtime.ok ? "" : runtime.error.problem).toBe("runtime");
    mem.catalog.rows = [{ ...preset(), custody: "engine-layer", kinds: ["api-key"] }];
    const custody = (await connections.addKey({ name: "key-a", vendor: "vendor-a", runtime: "runtime-a", ref: "ref-a", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who));
    expect(custody.ok ? "" : custody.error.problem).toBe("custody");
    expect(mem.store.directory.connections).toEqual([]);
  });
});
