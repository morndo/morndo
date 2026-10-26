// Sinks of a key pool from the service (ADR-0037, slice 4; KP20): the principal registers the files `write-env` writes a key to; a path belongs to one
// pool only; every live pool's sinks are known to the lane deny list; a deleted pool releases its sinks; the pool's views name none. In-memory ports.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, KeyPool } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, NoProbe, memory,
  type Failure, type Memory, type OutcomeClassifier,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const operator: Actor = { kind: "operator" };
const PATH = "/srv/app/.env";
const OTHER = "/srv/other/.env";

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

type World = { mem: Memory; pools: KeyPoolService; store: MemoryKeyPoolStore };
async function world(): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms };
  const store = new MemoryKeyPoolStore();
  const pools = new KeyPoolService({
    clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes,
    classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases: new LeaseService(mem.deps), helper: { limit: 4, ttlMs: 60_000 }, probe: new NoProbe(),
  });
  const connections = new ConnectionsService(mem.deps, pools);
  for (let i = 1; i <= 4; i++) {
    mem.vault.put(`ref-k${i}`, `0123456789a${i}`);
    expect((await connections.addKey({ name: `k${i}`, vendor: "vendor-a", runtime: "runtime-a", ref: `ref-k${i}`, billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who)).ok).toBe(true);
    expect(connections.acknowledge(`k${i}`, "ada", who).ok).toBe(true);
  }
  for (const [name, members] of [["p", ["k1", "k2"]], ["q", ["k3", "k4"]]] as const) {
    expect(pools.create({ name, vendor: "vendor-a", runtime: "runtime-a", members, by: "ada", confirmOwn: true }, who).ok).toBe(true);
  }
  return { mem, pools, store };
}
const word = (r: { ok: boolean; error?: Failure }) => (r.ok ? "ok" : r.error?.problem);
const body = (w: World, name: string): KeyPool => {
  const { pool } = w.store.load(name);
  if (!pool) throw new Error("no pool");
  return pool;
};

describe("addSink and removeSink", () => {
  it("the principal registers a path; it is in the pool and in sinksOf", async () => {
    const w = await world();
    expect(w.pools.addSink("p", PATH, who).ok).toBe(true);
    expect(w.pools.sinksOf("p")).toEqual([PATH]);
    expect(body(w, "p").sinks).toEqual([PATH]);
    expect(w.pools.sinksOf("q")).toEqual([]);
  });
  it("an operator may not add or remove one", async () => {
    const w = await world();
    expect(word(w.pools.addSink("p", PATH, operator))).toBe("principal");
    expect(w.pools.addSink("p", PATH, who).ok).toBe(true);
    expect(word(w.pools.removeSink("p", PATH, operator))).toBe("principal");
    expect(w.pools.sinksOf("p")).toEqual([PATH]);
    // The principal check comes first: an operator learns nothing about what another pool holds.
    expect(word(w.pools.addSink("q", PATH, operator))).toBe("principal");
  });
  it("a path another pool holds is refused with sink_taken, and the same pool's twice with exists", async () => {
    const w = await world();
    expect(w.pools.addSink("p", PATH, who).ok).toBe(true);
    expect(word(w.pools.addSink("q", PATH, who))).toBe("sink_taken");
    expect(word(w.pools.addSink("p", PATH, who))).toBe("exists");
    expect(w.pools.sinksOf("q")).toEqual([]);
  });
  it("a registered sink's sidecar is never a sink of another pool", async () => {
    const w = await world();
    expect(w.pools.addSink("p", PATH, who).ok).toBe(true);
    expect(word(w.pools.addSink("q", `${PATH}.member`, who))).toBe("bad_path");
  });
  it("a bad path says bad_path; a missing pool says missing; remove of one not there says missing", async () => {
    const w = await world();
    expect(word(w.pools.addSink("p", "relative/.env", who))).toBe("bad_path");
    expect(word(w.pools.addSink("nope", PATH, who))).toBe("missing");
    expect(word(w.pools.removeSink("p", PATH, who))).toBe("missing");
  });
  it("remove releases the path to any pool", async () => {
    const w = await world();
    w.pools.addSink("p", PATH, who);
    expect(w.pools.removeSink("p", PATH, who).ok).toBe(true);
    expect(w.pools.addSink("q", PATH, who).ok).toBe(true);
  });
});

describe("allSinks and the views", () => {
  it("allSinks lists every live pool's sinks, with the sidecar of each, for the lane deny list", async () => {
    const w = await world();
    w.pools.addSink("p", PATH, who);
    w.pools.addSink("q", OTHER, who);
    expect([...w.pools.allSinks()].sort()).toEqual([OTHER, `${OTHER}.member`, PATH, `${PATH}.member`].sort());
  });
  it("a deleted pool's sinks are released (its name stays taken)", async () => {
    const w = await world();
    w.pools.addSink("p", PATH, who);
    expect(w.pools.delete("p", who).ok).toBe(true);
    expect(w.pools.allSinks()).toEqual([]);
    expect(w.pools.addSink("q", PATH, who).ok).toBe(true);
  });
  it("list and state name no sink path", async () => {
    const w = await world();
    w.pools.addSink("p", PATH, who);
    expect(JSON.stringify(w.pools.list())).not.toContain("/srv/");
    expect(JSON.stringify(w.pools.state("p"))).not.toContain("/srv/");
  });
  it("the pool's events name no sink path", async () => {
    const w = await world();
    w.pools.addSink("p", PATH, who);
    expect(JSON.stringify(body(w, "p").events)).not.toContain("/srv/");
    expect(body(w, "p").events.at(-1)).toMatchObject({ type: "SinkAdded", sinks: 1 });
  });
});
