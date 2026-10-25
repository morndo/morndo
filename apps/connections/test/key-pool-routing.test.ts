// A key pool in the Priority and the engine layer (ADR-0037, slice 2; plan section 6): the pool is a provider named after it, its members'
// own providers go off, the order and the picks name the pool in their place, and leaving or deleting gives them back. `check --pool`
// asks whether some member could serve and moves nothing. In-memory ports.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, Holder, Outcome } from "@morndo/domain";
import { engineText } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, PoolRoutingSync, RoutingService, bindCommands, memory,
  type Failure, type Memory, type OutcomeClassifier,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const operator: Actor = { kind: "operator" };
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: null };
const dry: Outcome = { kind: "exhausted", reason: "credit", resumeAt: null };

function preset(): VendorPreset {
  return {
    id: "vendor-a", label: "Vendor A", custody: "morndo", kinds: ["api-key"],
    runtimes: [{ runtime: "runtime-a", dialect: "dialect-a", baseUrl: null }],
    models: { source: "static", ids: ["m"] }, family: "family-a", keyShapes: [], spend: ["manual"], prices: [],
    balance: null, defaultPicks: { "*": "m@high" }, isolation: "rules",
    terms: { revision: "r1", summary: "Read before use.", sources: ["https://example.com/terms"] },
  };
}
const poolTerms: KeyPoolTerms = { errorDialect: "dialect-a", termsRevision: "kr1", termsLine: "Rotates only on exhausted credit; only keys of accounts you hold." };
const classifier: OutcomeClassifier = { classify: () => ({ kind: "unknown" }) };

type World = { mem: Memory; pools: KeyPoolService; store: MemoryKeyPoolStore; connections: ConnectionsService; routing: RoutingService; leases: LeaseService };

async function world(n = 3): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms };
  const store = new MemoryKeyPoolStore();
  const leases = new LeaseService(mem.deps);
  const pools = new KeyPoolService({
    clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes,
    classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases, helper: { limit: 4, ttlMs: 60_000 },
  });
  const routing = new RoutingService(mem.deps, () => pools.routingPools());
  pools.attachRouting(new PoolRoutingSync({
    routing, engines: mem.engines, catalog: mem.catalog, models: mem.models, store: mem.store, clock: mem.clock, pools: () => pools.routingPools(),
  }));
  const connections = new ConnectionsService(mem.deps, pools);
  for (let i = 1; i <= n; i++) {
    mem.vault.put(`ref-k${i}`, `0123456789a${i}`);
    expect((await connections.addKey({ name: `k${i}`, vendor: "vendor-a", runtime: "runtime-a", ref: `ref-k${i}`, billing: "metered", budget: { kind: "unlimited" }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge(`k${i}`, "ada", who).ok).toBe(true);
  }
  // A role that follows the global order and picks the first two keys.
  expect(routing.commitRole("implement", "follow", null, ["k1:m@high", "k2:m@high"], undefined, "cli").ok).toBe(true);
  expect(routing.save().ok).toBe(true);
  return { mem, pools, store, connections, routing, leases };
}
const create = (w: World, members = ["k1", "k2", "k3"]) =>
  w.pools.create({ name: "p", vendor: "vendor-a", runtime: "runtime-a", members, by: "ada", confirmOwn: true }, who);
const policy = (w: World) => w.mem.store.load().policy;
const order = (w: World) => policy(w).priority.order;
const picks = (w: World) => policy(w).roles.find(r => r.role === "implement")?.picks.map(engineText) ?? [];
const chain = (w: World) => w.mem.engines.chains().find(c => c.role === "implement")?.chain ?? [];
const provider = (w: World, name: string) => w.mem.engines.providers.find(p => p.name === name);
const word = (r: { ok: boolean; error?: Failure }) => (r.ok ? "ok" : r.error?.problem);

describe("a pool joins the Priority and the engine layer", () => {
  it("registers the pool as a provider that runs and checks through the pool, and turns its members' providers off", async () => {
    const w = await world();
    expect(provider(w, "k1")?.enabled).toBe(true);
    expect(create(w).ok).toBe(true);
    expect(provider(w, "p")?.enabled).toBe(true);
    expect(w.mem.engines.commands.get("p")).toEqual({ bin: ["morndo-keys", "run", "--pool", "p", "--"], probe: ["morndo-keys", "check", "--pool", "p"] });
    for (const name of ["k1", "k2", "k3"]) expect(provider(w, name)?.enabled).toBe(false);
  });
  it("the pool takes its members' place in the order and the picks, and the chain is derived again", async () => {
    const w = await world();
    expect(order(w)).toEqual(["k1", "k2", "k3"]);
    expect(create(w).ok).toBe(true);
    expect(order(w)).toEqual(["p"]);
    expect(picks(w)).toEqual(["p:m@high"]);
    expect(chain(w)).toEqual(["p:m@high"]);
  });
  it("a member added later is folded into the pool that is there", async () => {
    const w = await world();
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    expect(order(w)).toEqual(["p", "k3"]);
    expect(w.pools.join("p", "k3", { confirmOwn: true }, who).ok).toBe(true);
    expect(order(w)).toEqual(["p"]);
    expect(provider(w, "k3")?.enabled).toBe(false);
  });
  it("the pool is a routing name like a Connection: a page priority save that left it out keeps it", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    const saved = w.routing.commitPriority("keys-first", [], "cli");
    expect(saved.ok).toBe(true);
    expect(order(w)).toEqual(["p"]);
    expect(chain(w)).toEqual(["p:m@high"]);
  });
  it("is reported by routingPools: the live pools with their members", async () => {
    const w = await world();
    expect(w.pools.routingPools()).toEqual([]);
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    expect(w.pools.routingPools()).toEqual([{ name: "p", members: ["k1", "k2"] }]);
  });
});

describe("leaving gives the member back", () => {
  it("a member that leaves a pool of three is a provider again, in the order after the pool, and keeps the pool's model in the picks", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    expect(w.pools.leave("p", "k2", who).ok).toBe(true);
    expect(provider(w, "k2")?.enabled).toBe(true);
    expect(provider(w, "k1")?.enabled).toBe(false);
    expect(order(w)).toEqual(["p", "k2"]);
    expect(picks(w)).toEqual(["p:m@high", "k2:m@high"]);
    expect(chain(w)).toEqual(["p:m@high", "k2:m@high"]);
  });
  it("deleting the pool puts its members back in its place and takes its provider out of the engine layer", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    expect(w.pools.delete("p", who).ok).toBe(true);
    expect(order(w)).toEqual(["k1", "k2", "k3"]);
    expect(picks(w)).toEqual(["k1:m@high", "k2:m@high", "k3:m@high"]);
    expect(chain(w)).toEqual(["k1:m@high", "k2:m@high", "k3:m@high"]);
    expect(provider(w, "p")).toBeUndefined();
    for (const name of ["k1", "k2", "k3"]) expect(provider(w, name)?.enabled).toBe(true);
  });
  it("revoking a member re-derives the pool; revoking the last one drops the pool from the order and the picks", async () => {
    const w = await world();
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    expect(w.connections.revoke("k1", who).ok).toBe(true);
    expect(w.pools.routingPools()).toEqual([{ name: "p", members: ["k2"] }]);
    expect(order(w)).toEqual(["p", "k3"]);
    expect(w.connections.revoke("k2", who).ok).toBe(true);
    expect(w.pools.routingPools()).toEqual([]);
    expect(order(w)).toEqual(["k3"]);
    expect(picks(w)).toEqual([]);
  });
});

describe("a revoke from the page reaches the pool as a revoke at the machine does", () => {
  it("the member leaves the pool and the order and picks follow", async () => {
    const w = await world();
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    const commands = bindCommands(w.mem.deps, () => ({}), () => w.pools.routingPools(), w.pools);
    expect(commands.revoke({ version: w.mem.store.load().version, name: "k1" }, "page")).toEqual({ ok: true });
    expect(w.pools.routingPools()).toEqual([{ name: "p", members: ["k2"] }]);
    expect(order(w)).toEqual(["p", "k3"]);
  });
});

describe("a failed engine write after the pool is saved names the retry, and sync mends it", () => {
  it("keeps the pool, says the engine layer was not updated, and keypool sync is the retry", async () => {
    const w = await world();
    w.mem.engines.failOn = w.mem.engines.writes.length + 1;
    const made = create(w);
    expect(made.ok).toBe(false);
    expect(word(made)).toMatch(/engine layer not updated \(retry: morndo-keys keypool sync\)/);
    expect(w.store.load("p").pool).not.toBeNull();
    expect(order(w)).toEqual(["k1", "k2", "k3"]);
    w.mem.engines.failOn = null;
    expect(w.pools.sync().ok).toBe(true);
    expect(order(w)).toEqual(["p"]);
    expect(chain(w)).toEqual(["p:m@high"]);
  });
  it("sync with nothing to change changes nothing", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    const before = JSON.stringify([w.mem.store.load().policy, w.mem.engines.providers]);
    expect(w.pools.sync().ok).toBe(true);
    expect(JSON.stringify([w.mem.store.load().policy, w.mem.engines.providers])).toBe(before);
  });
});

describe("check --pool: could some member serve now", () => {
  const probeRequest = { role: "run", entry: "m", holder, workspacePath: "/work/repo", limit: 8, reserve: 0, margin: 0, probe: true };
  const attempt = (w: World) => async (member: string) => {
    const granted = w.leases.lease(member, probeRequest);
    if (!granted.ok) return granted;
    w.leases.close(member, granted.value.id, "done", null);
    return granted;
  };
  it("answers the first member whose gate says yes, moves no ring position and writes no MemberPicked", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    const before = w.store.load("p");
    const out = await w.pools.canServe("p", attempt(w));
    expect(out).toEqual({ ok: true, value: { member: "k1" } });
    expect(w.store.load("p")).toEqual(before);
  });
  it("passes over an exhausted member and one the gate declines", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    w.pools.report("p", "k1", dry, w.mem.clock.now(), operator);
    w.connections.turnOff("k2");
    const out = await w.pools.canServe("p", attempt(w));
    expect(out).toEqual({ ok: true, value: { member: "k3" } });
  });
  it("says pool_empty when every member is exhausted, pool_blocked when one is failing, and the gate's word when all are declined", async () => {
    const w = await world(2);
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    w.connections.turnOff("k1");
    w.connections.turnOff("k2");
    expect(word(await w.pools.canServe("p", attempt(w)))).toBe("off");
    w.connections.turnOn("k1", who);
    w.connections.turnOn("k2", who);
    w.pools.report("p", "k1", dry, w.mem.clock.now(), operator);
    w.pools.report("p", "k2", dry, w.mem.clock.now(), operator);
    expect(word(await w.pools.canServe("p", attempt(w)))).toBe("pool_empty");
    w.pools.revive("p", "k2", who);
    w.pools.report("p", "k2", { kind: "failing", reason: "rejected" }, w.mem.clock.now(), operator);
    expect(word(await w.pools.canServe("p", attempt(w)))).toBe("pool_blocked");
  });
  it("a pool whose terms were not acknowledged for the current revision says terms", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    w.mem.catalog.keyPools = { "vendor-a": { ...poolTerms, termsRevision: "kr2" } };
    expect(word(await w.pools.canServe("p", attempt(w)))).toBe("terms");
  });
});
