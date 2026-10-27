// A refusal read from a consumer's own hook (ADR-0037, slice 4): `reportRefusal` classifies a signal with the pool's dialect and applies it only when
// it is a credit refusal (exhausted). A refused key (failing) is not marked on the hook's word: the member is named to be probed. A rate limit or an unknown answer changes nothing and writes nothing; an unmatched 4xx raises the one
// `unclassified` alert of status and type only. By grant, the caller must hold the grant before anything is applied (no alert, no write for a stranger).
// In-memory ports, a manual clock. Keys are synthetic; the planted secrets must reach nothing.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, Holder, KeyPool } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, NoProbe, memory,
  type Failure, type Memory, type OutcomeClassifier, type ProviderSignal,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const SEC = 1_000;
const TTL = 60 * SEC;
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: "lane-a" };
const SOCK = "/run/user/1000/mf-4242-abcdef/f.sock";
const caller = { id: { pid: 10, startedAt: 1, bootId: "boot" }, ppid: 9, filter: SOCK };
const stranger = { pid: 11, startedAt: 1, bootId: "boot" };
const PLANTED = "planted-secret-in-the-hook-text";
const REF = "ref-planted-vault-0001";
const FP = "feedfacecafe";

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
// 400 is a credit refusal, 401 a refused key, 429 a rate limit, 200 a Messages ok; anything else says nothing.
const classifier: OutcomeClassifier = {
  classify: signal => {
    if (signal.status === 200) return { kind: "ok", evidence: "messages" };
    if (signal.status === 400) return { kind: "exhausted", reason: "credit", resumeAt: null };
    if (signal.status === 401) return { kind: "failing", reason: "rejected" };
    if (signal.status === 429) return { kind: "limited", retryAfterMs: null };
    return { kind: "unknown" };
  },
};
const signalOf = (status: number | null, over: Partial<ProviderSignal> = {}): ProviderSignal =>
  ({ status, kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null, ...over });

type World = { mem: Memory; pools: KeyPoolService; store: MemoryKeyPoolStore; leases: LeaseService };
async function world(n = 3): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms };
  mem.catalog.keyPoolProbes = { "vendor-a": { model: "m-small" } };
  mem.alerts.recent = () => mem.alerts.raised.slice(-20);
  const store = new MemoryKeyPoolStore();
  const leases = new LeaseService(mem.deps);
  const pools = new KeyPoolService({
    clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes,
    classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases, helper: { limit: 4, ttlMs: TTL }, probe: new NoProbe(),
  });
  const connections = new ConnectionsService(mem.deps, pools);
  for (let i = 1; i <= n; i++) {
    mem.vault.put(i === 1 ? REF : `ref-k${i}`, i === 1 ? FP : `0123456789a${i}`);
    const added = await connections.addKey({ name: `k${i}`, vendor: "vendor-a", runtime: "runtime-a", ref: i === 1 ? REF : `ref-k${i}`, billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: null }, who);
    expect(added.ok).toBe(true);
    expect(connections.acknowledge(`k${i}`, "ada", who).ok).toBe(true);
  }
  const made = pools.create({ name: "p", vendor: "vendor-a", runtime: "runtime-a", members: Array.from({ length: n }, (_, i) => `k${i + 1}`), by: "ada", confirmOwn: true }, who);
  expect(made.ok).toBe(true);
  return { mem, pools, store, leases };
}
const pool = (w: World): KeyPool => {
  const { pool: loaded } = w.store.load("p");
  if (!loaded) throw new Error("no pool");
  return loaded;
};
const state = (w: World, name: string) => pool(w).members.find(m => m.credential === name)?.health.state;
const word = (r: { ok: boolean; error?: Failure }) => (r.ok ? "ok" : r.error?.problem);
const runRequest = { role: "run", entry: "m", holder, workspacePath: "/work/repo", limit: 8, reserve: 1, margin: 0, probe: false };
async function start(w: World): Promise<{ grant: string; member: string }> {
  const picked = await w.pools.pick("p", async member => w.leases.lease(member, runRequest), {
    grant: (_member: string, value: { id: string }) => ({
      lease: value.id, holder, startedAt: w.mem.clock.now(),
      request: { role: "run", entry: "m", workspacePath: "/work/repo", limit: 8, reserve: 1, margin: 0 },
    }),
  });
  if (!picked.ok || !picked.value.grant) throw new Error(`no grant: ${JSON.stringify(picked)}`);
  expect(w.pools.bindFilter("p", picked.value.grant, SOCK).ok).toBe(true);
  return { grant: picked.value.grant, member: picked.value.member };
}
const byHolder = (id: { pid: number; startedAt: number; bootId: string }) => ({ kind: "holder", caller: id }) as const;

describe("reportRefusal by grant", () => {
  it("a credit refusal marks the grant's member exhausted, once (KP11): the second says the same and raises no second event", async () => {
    const w = await world();
    const run = await start(w);
    const first = w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(caller.id) }, signalOf(400, { text: "Credit balance is too low" }), w.mem.clock.now());
    expect(first).toEqual({ ok: true, value: { outcome: "exhausted", suspect: null } });
    expect(state(w, run.member)).toBe("exhausted");
    w.mem.clock.at += SEC;
    const again = w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(caller.id) }, signalOf(400), w.mem.clock.now());
    expect(again.ok).toBe(true);
    expect(pool(w).events.filter(e => e.type === "KeyExhausted")).toHaveLength(1);
  });
  it("a refused key (401) is not marked on the hook's word: the member is named to be probed, and nothing changes", async () => {
    const w = await world();
    const run = await start(w);
    const before = JSON.stringify(pool(w));
    expect(w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(caller.id) }, signalOf(401), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "failing", suspect: run.member } });
    expect(state(w, run.member)).toBe("active");
    expect(pool(w).standing).toBe("ok");
    expect(JSON.stringify(pool(w))).toBe(before);
  });
  it("a caller that does not hold the grant is refused before anything is applied: no mark, no event, no alert", async () => {
    const w = await world();
    const run = await start(w);
    const before = pool(w);
    const alerts = w.mem.alerts.raised.length;
    expect(word(w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(stranger) }, signalOf(400), w.mem.clock.now()))).toBe("not_holder");
    expect(word(w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(stranger) }, signalOf(418, { kind: "teapot" }), w.mem.clock.now()))).toBe("not_holder");
    expect(pool(w)).toEqual(before);
    expect(w.mem.alerts.raised).toHaveLength(alerts);
  });
  it("a missing pool or grant says its word", async () => {
    const w = await world();
    expect(word(w.pools.reportRefusal("nope", { kind: "grant", grant: "g1", by: byHolder(caller.id) }, signalOf(400), 0))).toBe("missing");
    expect(word(w.pools.reportRefusal("p", { kind: "grant", grant: "gnope", by: byHolder(caller.id) }, signalOf(400), 0))).toBe("grant_missing");
  });
  it("inside the hand-off window a credit refusal is the old member's and names the current member to suspect (KP18)", async () => {
    const w = await world();
    const run = await start(w);
    expect(run.member).toBe("k1");
    expect(w.pools.report("p", "k1", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), { kind: "operator" }).ok).toBe(true);
    const moved = await w.pools.handOff("p", run.grant, caller);
    expect(moved.ok && moved.value.connection).toBe("k2");
    w.mem.clock.at += 5 * SEC;
    expect(w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: { kind: "operator" } }, signalOf(400), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "exhausted", suspect: "k2" } });
    expect(state(w, "k2")).toBe("active");
  });
});

describe("reportRefusal by member", () => {
  it("a refused key (401) or a per-resource refusal named by member is not marked either: it is named to be probed", async () => {
    const w = await world();
    const before = JSON.stringify(pool(w));
    expect(w.pools.reportRefusal("p", { kind: "member", member: "k2" }, signalOf(401), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "failing", suspect: "k2" } });
    expect(JSON.stringify(pool(w))).toBe(before);
  });
  it("marks that member, and says exhausted", async () => {
    const w = await world();
    expect(w.pools.reportRefusal("p", { kind: "member", member: "k2" }, signalOf(400), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "exhausted", suspect: null } });
    expect(state(w, "k2")).toBe("exhausted");
    expect(state(w, "k1")).toBe("active");
  });
  it("a member that is not in the pool says missing and changes nothing, an unmatched answer for it raises no alert", async () => {
    const w = await world();
    const before = pool(w);
    expect(word(w.pools.reportRefusal("p", { kind: "member", member: "k9" }, signalOf(400), w.mem.clock.now()))).toBe("missing");
    expect(word(w.pools.reportRefusal("p", { kind: "member", member: "k9" }, signalOf(418, { kind: "teapot_error" }), w.mem.clock.now()))).toBe("missing");
    expect(pool(w)).toEqual(before);
    expect(w.mem.alerts.raised).toEqual([]);
  });
});

describe("reportRefusal by the session that was served", () => {
  // `lease --pool` is one lease per call and exec'd by the agent CLI, so its parent is the CLI; a hook the CLI runs has that CLI as an ancestor.
  const HOUR_MS = 3_600_000;
  const serve = (w: World, member: string, ppid: number, parentStartedAt: number | null = 1): void => {
    const leased = w.leases.lease(member, { ...runRequest, reserve: 0, probe: true });
    if (!leased.ok) throw new Error(`no lease: ${JSON.stringify(leased)}`);
    const served = w.leases.serve(member, leased.value.id, { pid: 7000 + ppid, ppid, parentStartedAt, lane: null, workspace: "/work/repo", isolation: "rules", proof: "claimed" });
    expect(served.ok).toBe(true);
    w.leases.close(member, leased.value.id, "done", null);
  };
  const hook = { pid: 900, startedAt: 1, bootId: "boot" };
  const inSession = (w: World, ppid: number): void => { w.mem.processes.tree.set(900, [900, 899, ppid, 1]); };
  it("marks the member this session was last served, and no other", async () => {
    const w = await world();
    serve(w, "k1", 500);
    serve(w, "k2", 600);
    inSession(w, 500);
    expect(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "exhausted", suspect: null } });
    expect([state(w, "k1"), state(w, "k2"), state(w, "k3")]).toEqual(["exhausted", "active", "active"]);
  });
  it("the latest key served to the session wins: a session that was moved on is blamed for the key it holds now", async () => {
    const w = await world();
    serve(w, "k1", 500);
    w.mem.clock.at += 10_000;
    serve(w, "k3", 500);
    inSession(w, 500);
    expect(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()).ok).toBe(true);
    expect([state(w, "k1"), state(w, "k3")]).toEqual(["active", "exhausted"]);
  });
  it("a process that is not under a session that was served says unserved and changes nothing: no mark, no alert", async () => {
    const w = await world();
    serve(w, "k1", 500);
    inSession(w, 501);
    const before = JSON.stringify(pool(w));
    expect(word(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()))).toBe("unserved");
    expect(word(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(418, { kind: "teapot_error" }), w.mem.clock.now()))).toBe("unserved");
    expect(JSON.stringify(pool(w))).toBe(before);
    expect(w.mem.alerts.raised).toEqual([]);
  });
  it("a key served more than an hour ago is not the session's: a hook is no way to blame an old key", async () => {
    const w = await world();
    serve(w, "k1", 500);
    w.mem.clock.at += HOUR_MS + 1_000;
    inSession(w, 500);
    expect(word(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()))).toBe("unserved");
    expect(state(w, "k1")).toBe("active");
  });
  it("the nearest ancestor wins: a key leased by hand from a shell further out is not taken for the agent CLI's", async () => {
    const w = await world();
    serve(w, "k1", 400);
    w.mem.clock.at += 1_000;
    serve(w, "k2", 500);
    w.mem.processes.tree.set(900, [900, 899, 500, 450, 400, 1]);
    expect(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()).ok).toBe(true);
    expect([state(w, "k1"), state(w, "k2")]).toEqual(["active", "exhausted"]);
    const far = await world();
    serve(far, "k1", 400);
    far.mem.processes.tree.set(900, [900, 899, 500, 450, 440, 430, 420, 400, 1]);
    expect(word(far.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), far.mem.clock.now()))).toBe("unserved");
  });
  it("a parent pid that was reused is not the session: the start time of the parent must match, and an event without one is not matched", async () => {
    const w = await world();
    serve(w, "k1", 500, 2);
    serve(w, "k2", 500, null);
    inSession(w, 500);
    const before = JSON.stringify(pool(w));
    expect(word(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()))).toBe("unserved");
    expect(JSON.stringify(pool(w))).toBe(before);
    serve(w, "k3", 500, 1);
    expect(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(400), w.mem.clock.now()).ok).toBe(true);
    expect([state(w, "k1"), state(w, "k2"), state(w, "k3")]).toEqual(["active", "active", "exhausted"]);
  });
  it("a caller with no parent known is unserved", async () => {
    const w = await world();
    serve(w, "k1", 500);
    expect(word(w.pools.reportRefusal("p", { kind: "served", caller: { pid: 12345, startedAt: 1, bootId: "boot" } }, signalOf(400), w.mem.clock.now()))).toBe("unserved");
  });
  it("a rate limit for a served session changes nothing", async () => {
    const w = await world();
    serve(w, "k1", 500);
    inSession(w, 500);
    const before = JSON.stringify(pool(w));
    expect(w.pools.reportRefusal("p", { kind: "served", caller: hook }, signalOf(429), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "limited", suspect: null } });
    expect(JSON.stringify(pool(w))).toBe(before);
  });
});

describe("what is not a mark changes nothing", () => {
  it("a rate limit says limited and leaves the pool byte for byte as it was (no KeyLimited event)", async () => {
    const w = await world();
    const run = await start(w);
    const before = JSON.stringify(pool(w));
    expect(w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(caller.id) }, signalOf(429), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "limited", suspect: null } });
    expect(w.pools.reportRefusal("p", { kind: "member", member: "k2" }, signalOf(429), w.mem.clock.now()).ok).toBe(true);
    expect(JSON.stringify(pool(w))).toBe(before);
  });
  it("an answer that says nothing (a 500, no status) changes nothing and raises no alert", async () => {
    const w = await world();
    const before = JSON.stringify(pool(w));
    expect(w.pools.reportRefusal("p", { kind: "member", member: "k1" }, signalOf(500), w.mem.clock.now())).toEqual({ ok: true, value: { outcome: "unknown", suspect: null } });
    expect(w.pools.reportRefusal("p", { kind: "member", member: "k1" }, signalOf(null), w.mem.clock.now()).ok).toBe(true);
    expect(JSON.stringify(pool(w))).toBe(before);
    expect(w.mem.alerts.raised).toEqual([]);
  });
  it("an unmatched 4xx raises the one unclassified alert of status and type, and not again for the same detail", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect(w.pools.reportRefusal("p", { kind: "member", member: "k1" }, signalOf(418, { kind: "teapot_error", text: PLANTED }), w.mem.clock.now()).ok).toBe(true);
    const raised = w.mem.alerts.raised.filter(a => a.kind === "unclassified");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ name: "k1", detail: "418 teapot_error" });
  });
});

describe("a planted secret in the signal", () => {
  it("is in no event, alert, pool body or return value after every kind of refusal", async () => {
    const w = await world();
    const run = await start(w);
    const text = `Credit balance is too low ${PLANTED}`;
    const returns = [
      w.pools.reportRefusal("p", { kind: "grant", grant: run.grant, by: byHolder(caller.id) }, signalOf(400, { text, kind: PLANTED, code: PLANTED }), w.mem.clock.now()),
      w.pools.reportRefusal("p", { kind: "member", member: "k2" }, signalOf(401, { text, kind: PLANTED }), w.mem.clock.now()),
      w.pools.reportRefusal("p", { kind: "member", member: "k3" }, signalOf(429, { text }), w.mem.clock.now()),
      w.pools.reportRefusal("p", { kind: "member", member: "k3" }, signalOf(418, { text, kind: "teapot_error" }), w.mem.clock.now()),
    ];
    const everything = JSON.stringify([returns, pool(w), w.mem.alerts.raised, w.mem.store.load().directory.events]);
    expect(everything).not.toContain(PLANTED);
  });
});
