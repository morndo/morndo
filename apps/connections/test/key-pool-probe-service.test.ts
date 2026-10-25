// Probing a key pool from the service (ADR-0037, slice 3; KP6, KP7, KP11, KP16): the claim comes before the request, the member's own gate runs
// (a member that is off or over budget is declined and not probed), the answer is classified by the pool's dialect and reported as a probe's,
// the cost of one probe lands on the member's Connection, and N callers on an empty pool cause one probe. In-memory ports, a manual clock and a
// fake probe that answers as the test says. Keys are synthetic; the planted secrets must reach nothing.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, ConnEvent, Holder, KeyPool, Outcome } from "@morndo/domain";
import { findConnection, isKey, recordSpend, KEY_POOL_RECHECK_MAX_MS, KEY_PROBE_CLAIM_MS, KEY_PROBE_COST_USD } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, memory,
  type Failure, type Memory, type OutcomeClassifier, type ProbeAnswer, type ProbeRequest, type ProviderProbe, type ProviderSignal,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const SEC = 1_000;
const DAY = 86_400_000;
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: "probe" };
const PLANTED = "planted-secret-from-the-provider-body";
const REF = "ref-planted-vault-0001";
const FP = "feedfacecafe";

function preset(): VendorPreset {
  return {
    id: "vendor-a", label: "Vendor A", custody: "morndo", kinds: ["api-key"],
    runtimes: [{ runtime: "runtime-a", dialect: "dialect-a", baseUrl: "https://api.example.test" }],
    models: { source: "static", ids: ["m"] }, family: "family-a", keyShapes: [], spend: ["manual"], prices: [],
    balance: null, defaultPicks: { "*": "m@high" }, isolation: "rules",
    terms: { revision: "r1", summary: "Read before use.", sources: ["https://example.com/terms"] },
  };
}
const poolTerms: KeyPoolTerms = { errorDialect: "dialect-a", termsRevision: "kr1", termsLine: "Rotates only on exhausted credit; only keys of accounts you hold." };
// 200 is a Messages ok, 400 is a credit refusal, 401 a refused key, 429 a rate limit; anything else says nothing.
const classifier: OutcomeClassifier = {
  classify: (signal: ProviderSignal): Outcome => {
    if (signal.status === 200) return { kind: "ok", evidence: "messages" };
    if (signal.status === 400) return { kind: "exhausted", reason: "credit", resumeAt: null };
    if (signal.status === 402) return { kind: "exhausted", reason: "spend-limit", resumeAt: signal.resumeDate === null ? null : Date.parse(`${signal.resumeDate}T00:00:00Z`) };
    if (signal.status === 401) return { kind: "failing", reason: "rejected" };
    if (signal.status === 429) return { kind: "limited", retryAfterMs: null };
    return { kind: "unknown" };
  },
};

class FakeProbe implements ProviderProbe {
  calls: ProbeRequest[] = [];
  answer: () => Promise<ProbeAnswer> | ProbeAnswer = () => ({ signal: signalOf(200) });
  during: (() => void) | null = null;
  async probe(request: ProbeRequest): Promise<ProbeAnswer> {
    this.calls.push(request);
    this.during?.();
    return this.answer();
  }
}
const signalOf = (status: number, over: Partial<ProviderSignal> = {}): ProviderSignal =>
  ({ status, kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null, ...over });

type World = { mem: Memory; pools: KeyPoolService; probe: FakeProbe; connections: ConnectionsService; store: MemoryKeyPoolStore };
async function world(n = 3, budget: number | null = 10): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms };
  mem.catalog.keyPoolProbes = { "vendor-a": { model: "m-small" } };
  const store = new MemoryKeyPoolStore();
  // The meter the bin uses reports a run's own cost; the in-memory one ignores it.
  const leases = new LeaseService({ ...mem.deps, spend: { fromRun: (result: { cost: number | null }) => result.cost, reported: () => null } });
  const probe = new FakeProbe();
  const pools = new KeyPoolService({
    clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes,
    classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases, helper: { limit: 4, ttlMs: 60 * SEC }, probe,
  });
  const connections = new ConnectionsService(mem.deps, pools);
  for (let i = 1; i <= n; i++) {
    mem.vault.put(i === 1 ? REF : `ref-k${i}`, i === 1 ? FP : `0123456789a${i}`);
    const added = await connections.addKey({ name: `k${i}`, vendor: "vendor-a", runtime: "runtime-a", ref: i === 1 ? REF : `ref-k${i}`, billing: "metered", budget: budget === null ? { kind: "unlimited" } : { kind: "capped", amount: budget }, expiry: null }, who);
    expect(added.ok).toBe(true);
    expect(connections.acknowledge(`k${i}`, "ada", who).ok).toBe(true);
  }
  const made = pools.create({ name: "p", vendor: "vendor-a", runtime: "runtime-a", members: Array.from({ length: n }, (_, i) => `k${i + 1}`), by: "ada", confirmOwn: true }, who);
  expect(made.ok).toBe(true);
  return { mem, pools, probe, connections, store };
}
const dry = (w: World, member: string, at = w.mem.clock.now()) => w.pools.report("p", member, { kind: "exhausted", reason: "credit", resumeAt: null }, at, { kind: "operator" });
const pool = (w: World): KeyPool => {
  const { pool: loaded } = w.store.load("p");
  if (!loaded) throw new Error("no pool");
  return loaded;
};
const member = (w: World, name: string) => pool(w).members.find(m => m.credential === name)!;
const types = (w: World) => pool(w).events.map(e => e.type);
const dirEvents = (w: World): readonly ConnEvent[] => w.mem.store.load().directory.events;
const word = (r: { ok: boolean; error?: Failure }) => (r.ok ? "ok" : r.error?.problem);

describe("probeMember: claim, gate, request, classify, report", () => {
  it("a due dry member that answers 200 comes back: KeyRecovered by probe, the claim cleared, one ProbeClaimed", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    const out = await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(out).toEqual({ member: "k1", outcome: "recovered" });
    expect(member(w, "k1")).toMatchObject({ health: { state: "active" }, probingUntil: null, failedProbes: 0 });
    expect(pool(w).events.filter(e => e.type === "KeyRecovered")).toEqual([expect.objectContaining({ member: "k1", how: "probe" })]);
    expect(types(w).filter(t => t === "ProbeClaimed")).toHaveLength(1);
    expect(w.probe.calls).toEqual([{ connection: "k1", model: "m-small", baseUrl: "https://api.example.test" }]);
  });
  it("is made under a gated probe lease that is closed, with the cost of one probe on the lease and on the member's Connection, and no KeyServed", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    const events = dirEvents(w);
    expect(events.filter(e => e.type === "LeaseGranted" && e.name === "k1")).toHaveLength(1);
    expect(events.filter(e => e.type === "LeaseClosed" && e.name === "k1")).toHaveLength(1);
    expect(events.filter(e => e.type === "KeyServed")).toHaveLength(0);
    expect(events.filter(e => e.type === "LeaseClosed" && e.name === "k1").map(e => e.type === "LeaseClosed" && [e.outcome, e.amount])).toEqual([["done", KEY_PROBE_COST_USD]]);
    const c = findConnection(w.mem.store.load().directory, "k1");
    expect(c && isKey(c) && c.leases).toEqual([]);
    expect(c && isKey(c) && c.spend.map(row => [row.amount, row.source])).toEqual([[KEY_PROBE_COST_USD, "estimate"]]);
  });
  it("dry again: still exhausted, failedProbes 1, the interval doubled, and no second alert (KP11)", async () => {
    const w = await world();
    dry(w, "k1");
    const start = w.mem.clock.now();
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ signal: signalOf(400) });
    const out = await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(out).toEqual({ member: "k1", outcome: "exhausted" });
    expect(member(w, "k1")).toMatchObject({ health: { state: "exhausted" }, failedProbes: 1, nextCheck: start + DAY + 2 * DAY, probingUntil: start + DAY + KEY_PROBE_CLAIM_MS });
    expect(w.mem.alerts.recent().filter(a => a.kind === "key-exhausted")).toHaveLength(1);
  });
  it("a probe that finds the key refused blocks the pool: pool-blocked alert once", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ signal: signalOf(401) });
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "failing" });
    expect(pool(w).standing).toBe("blocked");
    expect(w.mem.alerts.recent().filter(a => a.kind === "key-failing")).toHaveLength(1);
  });
  it("an unmatched 4xx raises one unclassified alert with the status and kind only, and changes nothing", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ signal: signalOf(418, { kind: "teapot_error", text: PLANTED }) });
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "unknown" });
    const alerts = w.mem.alerts.recent().filter(a => a.kind === "unclassified");
    expect(alerts).toEqual([expect.objectContaining({ name: "k1", detail: "418 teapot_error" })]);
    expect(JSON.stringify(w.mem.alerts.recent())).not.toContain(PLANTED);
    expect(member(w, "k1").health).toMatchObject({ state: "exhausted" });
  });
  it("a provider that cannot be reached changes nothing, records no cost, and the claim lapses with the next check already set", async () => {
    const w = await world();
    dry(w, "k1");
    const start = w.mem.clock.now();
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ unreachable: true });
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "unreachable" });
    expect(member(w, "k1")).toMatchObject({ health: { state: "exhausted" }, failedProbes: 0, nextCheck: start + 2 * DAY });
    const c = findConnection(w.mem.store.load().directory, "k1");
    expect(c && isKey(c) && c.spend).toEqual([]);
    expect(dirEvents(w).filter(e => e.type === "LeaseClosed" && e.name === "k1").map(e => e.type === "LeaseClosed" && [e.outcome, e.amount])).toEqual([["failed", 0]]);
    expect(types(w)).not.toContain("KeyRecovered");
  });
  it("a spend-limit refusal that names a date waits for the date", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    // A date ten days out from the manual clock (a date more than a year out is capped, KP: resumeAt).
    const date = new Date(w.mem.clock.now() + 10 * DAY).toISOString().slice(0, 10);
    w.probe.answer = () => ({ signal: signalOf(402, { resumeDate: date }) });
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(member(w, "k1").nextCheck).toBe(Date.parse(`${date}T00:00:00Z`));
  });
});

describe("a probe is made only when it may be", () => {
  it("a member that is not due is skipped as not_due and nothing is sent; a manual probe goes", async () => {
    const w = await world();
    dry(w, "k1");
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "skipped", word: "not_due" });
    expect(w.probe.calls).toHaveLength(0);
    expect((await w.pools.probeMember("p", "k1", { why: "manual", holder })).outcome).toBe("recovered");
    expect(w.probe.calls).toHaveLength(1);
  });
  it("a member that is not exhausted is skipped as state; a member that is not there as missing", async () => {
    const w = await world();
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "skipped", word: "state" });
    expect(await w.pools.probeMember("p", "zz", { why: "due", holder })).toEqual({ member: "zz", outcome: "skipped", word: "missing" });
    expect(w.probe.calls).toHaveLength(0);
  });
  it("a member that is switched off is declined with its gate word and not probed", async () => {
    const w = await world();
    dry(w, "k1");
    w.connections.turnOff("k1");
    w.mem.clock.at += DAY;
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "declined", word: "off" });
    expect(w.probe.calls).toHaveLength(0);
  });
  it("a member whose own budget is spent is declined with budget and not probed", async () => {
    const w = await world(3, 1);
    dry(w, "k1");
    const loaded = w.mem.store.load();
    const spent = recordSpend(loaded.directory, "k1", 1, "estimate", { kind: "operator" }, w.mem.clock.now());
    if (!spent.ok) throw new Error("spend");
    expect(w.mem.store.save(spent.value, loaded.policy, loaded.version)).toBe(true);
    w.mem.clock.at += DAY;
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "declined", word: "budget" });
    expect(w.probe.calls).toHaveLength(0);
  });
  it("a pool whose vendor has no probe model says no_probe_model and sends nothing", async () => {
    const w = await world();
    w.mem.catalog.keyPoolProbes = {};
    dry(w, "k1");
    w.mem.clock.at += DAY;
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "skipped", word: "no_probe_model" });
    expect(w.probe.calls).toHaveLength(0);
  });
  it("kp16 two probers at once: one probes, the other finds the claim", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    w.probe.answer = async () => { await new Promise(resolve => { setTimeout(resolve, 30); }); return { signal: signalOf(200) }; };
    const both = await Promise.all([w.pools.probeMember("p", "k1", { why: "due", holder }), w.pools.probeMember("p", "k1", { why: "due", holder })]);
    expect(w.probe.calls).toHaveLength(1);
    expect(both.map(r => r.outcome).sort()).toEqual(["recovered", "skipped"]);
    expect(both.find(r => r.outcome === "skipped")).toMatchObject({ word: expect.stringMatching(/^(claimed|state)$/) });
  });
  it("kp6 an answer from a probe that began before a newer change is ignored: the owner revived the member while the probe was out", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    w.probe.during = () => {
      w.mem.clock.at += 5 * SEC;
      expect(word(w.pools.revive("p", "k1", who))).toBe("ok");
      dry(w, "k1");
    };
    w.probe.answer = () => ({ signal: signalOf(200) });
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(member(w, "k1").health).toMatchObject({ state: "exhausted" });
    expect(pool(w).events.filter(e => e.type === "KeyRecovered").map(e => e.type === "KeyRecovered" && e.how)).toEqual(["revive"]);
  });
});

describe("recheck", () => {
  it("probes only the members that are due, in ring order, one probe each", async () => {
    const w = await world(4);
    dry(w, "k1");
    w.mem.clock.at += 3_600_000;
    dry(w, "k2");
    w.mem.clock.at += 3_600_000;
    dry(w, "k3");
    w.mem.clock.at += DAY - 3_600_000;
    const results = await w.pools.recheck({ holder });
    expect(results.map(r => [r.member, r.outcome])).toEqual([["k1", "recovered"], ["k2", "recovered"]]);
    expect(w.probe.calls.map(c => c.connection)).toEqual(["k1", "k2"]);
  });
  it("does nothing when nothing is due, and names no pool it was not asked about", async () => {
    const w = await world();
    dry(w, "k1");
    expect(await w.pools.recheck({ holder })).toEqual([]);
    expect(await w.pools.recheck({ holder, pool: "p" })).toEqual([]);
    expect(w.probe.calls).toHaveLength(0);
  });
  it("--member probes that member now, still through the claim: a second one within thirty seconds is skipped", async () => {
    const w = await world();
    dry(w, "k1");
    w.probe.answer = () => ({ signal: signalOf(400) });
    expect((await w.pools.recheck({ holder, pool: "p", member: "k1" }))[0]).toEqual({ member: "k1", outcome: "exhausted" });
    expect((await w.pools.recheck({ holder, pool: "p", member: "k1" }))[0]).toEqual({ member: "k1", outcome: "skipped", word: "claimed" });
    w.mem.clock.at += KEY_PROBE_CLAIM_MS;
    expect((await w.pools.recheck({ holder, pool: "p", member: "k1" }))[0]?.outcome).toBe("exhausted");
  });
  it("uses resumeAt, doubles after a failed probe up to a week, and recovers on a Messages ok", async () => {
    const w = await world();
    dry(w, "k1");
    w.probe.answer = () => ({ signal: signalOf(400) });
    const gaps: number[] = [];
    for (let i = 0; i < 4; i++) {
      w.mem.clock.at = member(w, "k1").nextCheck as number;
      await w.pools.recheck({ holder });
      gaps.push((member(w, "k1").nextCheck as number) - w.mem.clock.now());
    }
    expect(gaps).toEqual([2 * DAY, 4 * DAY, KEY_POOL_RECHECK_MAX_MS, KEY_POOL_RECHECK_MAX_MS]);
    w.probe.answer = () => ({ signal: signalOf(200) });
    w.mem.clock.at = member(w, "k1").nextCheck as number;
    expect((await w.pools.recheck({ holder }))[0]?.outcome).toBe("recovered");
    expect(member(w, "k1").health).toEqual({ state: "active" });
  });
});

describe("an empty pool probes inline, once", () => {
  const pick = (w: World, probe: boolean) => w.pools.pick("p", async name => ({ ok: true as const, value: name }), probe ? { probe: holder } : undefined);
  const allDry = (w: World) => { for (const name of ["k1", "k2", "k3"]) dry(w, name); };
  it("N concurrent picks on an empty pool with one due member cause exactly one probe, and the one that probed gets the key", async () => {
    const w = await world();
    dry(w, "k1");
    // Only k1 is due: k2 and k3 ran dry a day and a half later, and a dry report of a member that is dry already changes nothing.
    w.mem.clock.at += 3_600_000 * 36;
    dry(w, "k2");
    dry(w, "k3");
    w.mem.clock.at += 3_600_000 * 12;
    expect(pool(w).members.map(m => (m.nextCheck as number) <= w.mem.clock.now())).toEqual([true, false, false]);
    w.probe.answer = async () => { await new Promise(resolve => { setTimeout(resolve, 40); }); return { signal: signalOf(200) }; };
    const results = await Promise.all(Array.from({ length: 5 }, () => pick(w, true)));
    expect(w.probe.calls).toHaveLength(1);
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (!r.ok) expect(r.error.problem).toBe("pool_empty");
  });
  it("a pick without a probe holder never probes, and a pool with nothing due does not probe", async () => {
    const w = await world();
    allDry(w);
    w.mem.clock.at += DAY;
    expect(word(await pick(w, false))).toBe("pool_empty");
    expect(w.probe.calls).toHaveLength(0);
    const fresh = await world();
    allDry(fresh);
    expect(word(await pick(fresh, true))).toBe("pool_empty");
    expect(fresh.probe.calls).toHaveLength(0);
  });
  it("a pool that still has a servable member never probes on a pick", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    const out = await pick(w, true);
    expect(out.ok).toBe(true);
    expect(w.probe.calls).toHaveLength(0);
  });
});

describe("state shows what probing costs", () => {
  it("the cost of one probe, and the probes claimed in the last day", async () => {
    const w = await world();
    dry(w, "k1");
    expect(w.pools.state("p")).toMatchObject({ probe: { costUsd: KEY_PROBE_COST_USD, last24h: 0 } });
    w.mem.clock.at += DAY;
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(w.pools.state("p")).toMatchObject({ probe: { costUsd: KEY_PROBE_COST_USD, last24h: 1 } });
    w.mem.clock.at += DAY + SEC;
    expect(w.pools.state("p")).toMatchObject({ probe: { last24h: 0 } });
  });
});

describe("kp12 nothing the provider said, and no key, reaches the pool, its events or the alerts", () => {
  it("planted secrets in the answer's text, kind and code are in none of them after every kind of answer", async () => {
    const w = await world();
    for (const status of [400, 401, 418, 429, 200]) {
      dry(w, "k1");
      w.mem.clock.at += 8 * DAY;
      w.probe.answer = () => ({ signal: signalOf(status, { kind: "k_error", text: `${PLANTED} credit balance is too low`, code: PLANTED }) });
      await w.pools.probeMember("p", "k1", { why: "manual", holder });
      w.pools.revive("p", "k1", who);
    }
    const said = JSON.stringify([pool(w), w.mem.alerts.recent(), dirEvents(w)]);
    expect(said).not.toContain(PLANTED);
    expect(said).not.toContain(FP);
    expect(said).not.toContain(REF);
  });
});

describe("rev-158: recheck is the principal's, like the other operator commands", () => {
  it("recheckBy refuses an operator and probes nothing; a principal gets the results", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    const refused = await w.pools.recheckBy({ kind: "operator" }, { holder });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.problem).toBe("principal");
    expect(w.probe.calls).toHaveLength(0);
    const allowed = await w.pools.recheckBy(who, { holder });
    expect(allowed).toEqual({ ok: true, value: [{ member: "k1", outcome: "recovered" }] });
  });
});

describe("rev-158: a manual probe does not move the schedule", () => {
  it("eight manual probes of a dry key, thirty-one seconds apart, leave nextCheck and failedProbes where they were", async () => {
    const w = await world();
    dry(w, "k1");
    const before = member(w, "k1").nextCheck;
    w.probe.answer = () => ({ signal: signalOf(400) });
    for (let i = 0; i < 8; i++) {
      w.mem.clock.at += 31 * SEC;
      expect((await w.pools.probeMember("p", "k1", { why: "manual", holder })).outcome).toBe("exhausted");
    }
    expect(member(w, "k1")).toMatchObject({ failedProbes: 0, nextCheck: before });
    expect(w.probe.calls).toHaveLength(8);
  });
});

describe("rev-158: a resume date that is not in the future is no date", () => {
  it("a probe answered with a date in the past waits the doubled interval, and recheck does not probe again at once", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    const past = new Date(w.mem.clock.now() - 2 * DAY).toISOString().slice(0, 10);
    w.probe.answer = () => ({ signal: signalOf(402, { resumeDate: past }) });
    const now = w.mem.clock.now();
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(member(w, "k1").nextCheck).toBe(now + 2 * DAY);
    w.mem.clock.at += 31 * SEC;
    expect(await w.pools.recheck({ holder })).toEqual([]);
    expect(w.probe.calls).toHaveLength(1);
  });
});

describe("rev-158: an unknown 4xx alerts once per change", () => {
  it("the same unmatched answer twice raises one alert; a different one raises another", async () => {
    const w = await world();
    dry(w, "k1");
    w.probe.answer = () => ({ signal: signalOf(418, { kind: "teapot_error" }) });
    for (let i = 0; i < 3; i++) {
      w.mem.clock.at += 31 * SEC;
      await w.pools.probeMember("p", "k1", { why: "manual", holder });
    }
    expect(w.mem.alerts.recent().filter(a => a.kind === "unclassified")).toHaveLength(1);
    w.probe.answer = () => ({ signal: signalOf(418, { kind: "kettle_error" }) });
    w.mem.clock.at += 31 * SEC;
    await w.pools.probeMember("p", "k1", { why: "manual", holder });
    expect(w.mem.alerts.recent().filter(a => a.kind === "unclassified").map(a => a.detail)).toEqual(["418 teapot_error", "418 kettle_error"]);
  });
});

describe("rev-158: a model or version the provider does not know is a configuration error, not a verdict on the key", () => {
  it("raises one probe-config alert (once, however often), leaves the member as it is, and says misconfigured with the word", async () => {
    const w = await world();
    dry(w, "k1");
    w.probe.answer = () => ({ misconfigured: "model" });
    const first = await w.pools.probeMember("p", "k1", { why: "manual", holder });
    expect(first).toEqual({ member: "k1", outcome: "misconfigured", word: "model" });
    w.mem.clock.at += 31 * SEC;
    await w.pools.probeMember("p", "k1", { why: "manual", holder });
    expect(w.mem.alerts.recent().filter(a => a.kind === "probe-config")).toEqual([expect.objectContaining({ name: "k1", detail: "model" })]);
    expect(member(w, "k1")).toMatchObject({ health: { state: "exhausted" }, failedProbes: 0 });
    expect(w.mem.alerts.recent().filter(a => a.kind === "unclassified")).toEqual([]);
  });
  it("a due probe that is misconfigured does not double the interval", async () => {
    const w = await world();
    dry(w, "k1");
    const start = w.mem.clock.now();
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ misconfigured: "version" });
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(member(w, "k1")).toMatchObject({ failedProbes: 0, nextCheck: start + 2 * DAY });
  });
});

describe("rev-158: a claim whose probe never started is released at once", () => {
  it("a member that is off is declined, and the claim, the next check and the last probe are as they were: the next try is not skipped for an interval", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    const before = { ...member(w, "k1") };
    w.connections.turnOff("k1");
    expect(await w.pools.probeMember("p", "k1", { why: "due", holder })).toEqual({ member: "k1", outcome: "declined", word: "off" });
    expect(member(w, "k1")).toMatchObject({ probingUntil: null, nextCheck: before.nextCheck, lastProbe: before.lastProbe });
    expect(types(w)).toContain("ProbeReleased");
    w.connections.turnOn("k1");
    expect((await w.pools.recheck({ holder }))[0]).toEqual({ member: "k1", outcome: "recovered" });
  });
  it("a probe that went out is not released: an unreachable provider keeps the claim and the moved next check", async () => {
    const w = await world();
    dry(w, "k1");
    w.mem.clock.at += DAY;
    w.probe.answer = () => ({ unreachable: true });
    await w.pools.probeMember("p", "k1", { why: "due", holder });
    expect(types(w)).not.toContain("ProbeReleased");
    expect(member(w, "k1").nextCheck).toBe(w.mem.clock.now() + DAY);
  });
});
