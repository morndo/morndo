// The key pool's application service (ADR-0037): creating a pool in one save, picking a member (the lastPick is saved before the
// gate runs, the pick is written after it, KP9 and KP15), reports and their alerts, the names a pool shares with Connections
// (KP1), a revoked Connection leaving (KP8), and a state that holds no secret. In-memory ports, a manual clock, fixed ids.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, Holder, KeyPool, Outcome } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, SpendService, memory,
  type Failure, type Memory, type OutcomeClassifier, type ProviderSignal,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: null };
const DAY = 86_400_000;
const MIN = 60_000;
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
// What the key-pool catalog file says about the vendor: its own file, so an older build's strict preset schema never sees it (review F7).
function poolTerms(revision = "kr1", errorDialect = "dialect-a"): KeyPoolTerms {
  return { errorDialect, termsRevision: revision, termsLine: "Rotates only on exhausted credit or a spend limit you set; only keys of accounts you hold." };
}
const classifier: OutcomeClassifier = {
  classify(signal: ProviderSignal): Outcome {
    if (signal.text === "dry") return { kind: "exhausted", reason: "credit", resumeAt: null };
    if (signal.status === 401) return { kind: "failing", reason: "rejected" };
    if (signal.status === 429) return { kind: "limited", retryAfterMs: null };
    return { kind: "unknown" };
  },
};

type World = { mem: Memory; pools: KeyPoolService; store: MemoryKeyPoolStore; connections: ConnectionsService; leases: LeaseService };

async function world(n = 3, opts: { budgetOf?: Record<string, number> } = {}): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms() };
  const store = new MemoryKeyPoolStore();
  const pools = new KeyPoolService({ clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes, classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases: new LeaseService(mem.deps), helper: { limit: 4, ttlMs: 60_000 } });
  const connections = new ConnectionsService(mem.deps, pools);
  for (let i = 1; i <= n; i++) {
    mem.vault.put(i === 1 ? REF : `ref-k${i}`, i === 1 ? FP : `0123456789a${i}`);
    const added = await connections.addKey({ name: `k${i}`, vendor: "vendor-a", runtime: "runtime-a", ref: i === 1 ? REF : `ref-k${i}`, billing: "metered", budget: { kind: "capped", amount: opts.budgetOf?.[`k${i}`] ?? 10 }, expiry: null }, who);
    expect(added.ok).toBe(true);
    expect(connections.acknowledge(`k${i}`, "ada", who).ok).toBe(true);
  }
  return { mem, pools, store, connections, leases: new LeaseService(mem.deps) };
}

const create = (w: World, members = ["k1", "k2", "k3"], over: Partial<Parameters<KeyPoolService["create"]>[0]> = {}) =>
  w.pools.create({ name: "p", vendor: "vendor-a", runtime: "runtime-a", members, by: "ada", confirmOwn: true, ...over }, who);
const loaded = (w: World): KeyPool => {
  const { pool } = w.store.load("p");
  if (!pool) throw new Error("no pool p");
  return pool;
};
const request = { role: "implement", entry: "m", holder, workspacePath: "/work/repo", limit: 2, reserve: 1, margin: 0, probe: true };
// The gate attempt the CLI makes for a member: take the lease and close it, as one `lease` call does.
const leasing = (w: World) => async (member: string) => {
  const granted = w.leases.lease(member, request);
  if (!granted.ok) return granted;
  w.leases.close(member, granted.value.id, "done", null);
  return granted;
};
const types = (pool: KeyPool) => pool.events.map(e => e.type);

describe("create", () => {
  it("makes the pool, joins every member and records the terms in one save", async () => {
    const w = await world();
    expect(create(w).ok).toBe(true);
    expect(w.store.saves).toBe(1);
    const pool = loaded(w);
    expect(pool.members.map(m => m.credential)).toEqual(["k1", "k2", "k3"]);
    expect(pool.terms).toMatchObject({ by: "ada", revision: "kr1" });
    expect(types(pool)).toEqual(["KeyPoolCreated", "OwnerConfirmed", "MemberJoined", "OwnerConfirmed", "MemberJoined", "OwnerConfirmed", "MemberJoined", "TermsAcknowledged"]);
    expect(pool.policy).toEqual({ mode: "round-robin", recheckEveryMs: DAY });
  });

  it("takes a mode and a recheck interval", async () => {
    const w = await world(2);
    expect(create(w, ["k1", "k2"], { mode: "drain", recheckEveryMs: 6 * 3_600_000 }).ok).toBe(true);
    expect(loaded(w).policy).toEqual({ mode: "drain", recheckEveryMs: 6 * 3_600_000 });
  });

  it("refuses without who acknowledged the terms, and saves nothing", async () => {
    const w = await world();
    const r = create(w, undefined, { by: "" });
    expect(r.ok ? "" : r.error.problem).toBe("ack_needed");
    expect(w.store.saves).toBe(0);
  });

  it("refuses a vendor whose preset names no key-pool data, a member that is not there, and a member in another pool", async () => {
    const w = await world();
    w.mem.catalog.keyPools = {};
    expect((create(w) as { error: Failure }).error.problem).toBe("no_classifier");
    w.mem.catalog.keyPools = { "vendor-a": poolTerms() };
    expect((create(w, ["k1", "nope"]) as { error: Failure }).error.problem).toBe("missing");
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    expect((create(w, ["k3"], { name: "q" }) as { ok: boolean }).ok).toBe(true);
    const again = w.pools.create({ name: "r", vendor: "vendor-a", runtime: "runtime-a", members: ["k2"], by: "ada", confirmOwn: true }, who);
    expect(again.ok ? "" : again.error.problem).toBe("in_pool");
    expect(w.store.names().live).toEqual(["p", "q"]);
  });

  it("refuses a member whose organization is not confirmed, until --confirm-own-account, and a member of a confirmed organization needs no flag", async () => {
    const w = await world(2);
    const refused = create(w, ["k1"], { confirmOwn: false, organizations: { k1: "org-a" } });
    expect(refused.ok ? "" : refused.error.problem).toBe("foreign_organization");
    expect(w.store.saves).toBe(0);
    expect(create(w, ["k1"], { confirmOwn: true, organizations: { k1: "org-a" } }).ok).toBe(true);
    expect(loaded(w).ownedOrgs).toEqual(["org-a"]);
    expect(w.pools.join("p", "k2", { confirmOwn: false, organization: "org-a" }, who).ok).toBe(true);
    const unreadable = await world(1);
    const none = unreadable.pools.create({ name: "p", vendor: "vendor-a", runtime: "runtime-a", members: ["k1"], by: "ada", confirmOwn: false }, who);
    expect(none.ok ? "" : none.error.problem).toBe("foreign_organization");
  });
});

describe("kp1 names are shared with Connections", () => {
  it("a Connection cannot take a pool's name or a deleted pool's name, and a pool cannot take a Connection's", async () => {
    const w = await world();
    expect(create(w, ["k1", "k2"]).ok).toBe(true);
    w.mem.vault.put("ref-p", "0123456789ff");
    const add = (name: string) => w.connections.addKey({ name, vendor: "vendor-a", runtime: "runtime-a", ref: "ref-p", billing: "metered", budget: { kind: "unlimited" }, expiry: null }, who);
    expect((await add("p")).ok).toBe(false);
    expect(w.pools.delete("p", who).ok).toBe(true);
    const afterDelete = await add("p");
    expect(afterDelete.ok ? "" : afterDelete.error.problem).toBe("taken");
    const made = w.pools.create({ name: "k3", vendor: "vendor-a", runtime: "runtime-a", members: ["k1"], by: "ada", confirmOwn: true }, who);
    expect(made.ok ? "" : made.error.problem).toBe("taken");
    expect((await add("fresh")).ok).toBe(true);
  });
});

describe("pick", () => {
  it("serves k1, k2, k3, k1 and writes one MemberPicked per pick", async () => {
    const w = await world();
    create(w);
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await w.pools.pick("p", leasing(w));
      expect(r.ok).toBe(true);
      if (r.ok) got.push(r.value.member);
    }
    expect(got).toEqual(["k1", "k2", "k3", "k1"]);
    expect(loaded(w).events.filter(e => e.type === "MemberPicked")).toHaveLength(4);
    expect(loaded(w).lastPick).toBe("k1");
  });

  it("saves the lastPick before the gate attempt runs", async () => {
    const w = await world();
    create(w);
    let seen: string | null = "unset";
    const r = await w.pools.pick("p", async member => { seen = loaded(w).lastPick; return leasing(w)(member); });
    expect(r.ok).toBe(true);
    expect(seen).toBe("k1");
  });

  it("falls through a member the gate refuses, records its word, and leaves its health alone (kp9)", async () => {
    const w = await world(3, { budgetOf: { k1: 1 } });
    create(w);
    expect(new SpendService(w.mem.deps).record("k1", 1, "estimate", { kind: "operator" }).ok).toBe(true);
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok && r.value.member).toBe("k2");
    const pool = loaded(w);
    expect(pool.lastPick).toBe("k2");
    expect(pool.members.map(m => m.health.state)).toEqual(["active", "active", "active"]);
    expect(pool.events.filter(e => e.type === "MemberPicked")).toEqual([{ type: "MemberPicked", member: "k2", declined: [{ member: "k1", word: "budget" }], at: w.mem.clock.now() }]);
  });

  it("when every member is declined the refusal is the first member's gate word, exit 75", async () => {
    const w = await world(2, { budgetOf: { k1: 1, k2: 1 } });
    create(w, ["k1", "k2"]);
    for (const k of ["k1", "k2"]) new SpendService(w.mem.deps).record(k, 1, "estimate", { kind: "operator" });
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok ? null : r.error).toMatchObject({ problem: "budget", exit: 75 });
    expect(loaded(w).events.filter(e => e.type === "MemberPicked")).toHaveLength(0);
  });

  it("a failure that is not a gate word stops at once: the next member is not tried", async () => {
    const w = await world();
    create(w);
    const tried: string[] = [];
    const r = await w.pools.pick("p", async member => { tried.push(member); return { ok: false as const, error: { problem: "missing" } }; });
    expect(r.ok ? null : r.error.problem).toBe("missing");
    expect(r.ok ? null : r.error.exit).toBeUndefined();
    expect(tried).toEqual(["k1"]);
  });

  it("refuses with pool_empty and exit 75 when nothing is servable, without calling the gate, and says when it may be back", async () => {
    const w = await world(2);
    create(w, ["k1", "k2"]);
    w.pools.report("p", "k1", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), who);
    w.mem.clock.at += MIN;
    w.pools.report("p", "k2", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), who);
    let called = 0;
    const r = await w.pools.pick("p", async () => { called += 1; return { ok: true as const, value: null }; });
    expect(called).toBe(0);
    expect(r.ok ? null : r.error).toMatchObject({ problem: "pool_empty", exit: 75, backAt: w.mem.clock.now() - MIN + DAY });
  });

  it("refuses with pool_blocked and exit 75 while a member is failing, however many others serve", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k2", { kind: "failing", reason: "denied" }, w.mem.clock.now(), who);
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok ? null : r.error).toMatchObject({ problem: "pool_blocked", exit: 75, member: "k2" });
  });

  it("refuses when the pool does not exist, and when its terms are not the catalog's current revision (exit 75, no gate call)", async () => {
    const w = await world();
    const none = await w.pools.pick("nope", leasing(w));
    expect(none.ok ? "" : none.error.problem).toBe("missing");
    create(w);
    w.mem.catalog.keyPools = { "vendor-a": poolTerms("kr2") };
    let called = 0;
    const r = await w.pools.pick("p", async () => { called += 1; return { ok: true as const, value: null }; });
    expect(called).toBe(0);
    expect(r.ok ? null : r.error).toMatchObject({ problem: "terms", exit: 75 });
  });

  it("kp15: two picks started together get different members in round-robin and the same member in drain", async () => {
    const rr = await world(2);
    create(rr, ["k1", "k2"]);
    const slow = (w: World) => async (member: string) => { await Promise.resolve(); await Promise.resolve(); return leasing(w)(member); };
    const two = await Promise.all([rr.pools.pick("p", slow(rr)), rr.pools.pick("p", slow(rr))]);
    expect(two.map(r => (r.ok ? r.value.member : "refused")).sort()).toEqual(["k1", "k2"]);
    const dr = await world(2);
    create(dr, ["k1", "k2"], { mode: "drain" });
    const same = await Promise.all([dr.pools.pick("p", slow(dr)), dr.pools.pick("p", slow(dr))]);
    expect(same.map(r => (r.ok ? r.value.member : "refused"))).toEqual(["k1", "k1"]);
  });

  it("a lost save is retried on fresh state and the lastPick is not advanced twice", async () => {
    const w = await world();
    create(w);
    w.store.beforeSave = () => {
      // another writer lands first: a limited note on k3, which bumps the pool's version
      const { pool, version } = w.store.load("p");
      if (!pool) throw new Error("pool");
      w.store.save({ ...pool, seq: pool.seq }, version);
    };
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok && r.value.member).toBe("k1");
    expect(loaded(w).lastPick).toBe("k1");
    expect(loaded(w).events.filter(e => e.type === "MemberPicked")).toHaveLength(1);
  });

  it("skips and removes a member whose Connection was revoked behind the pool's back", async () => {
    const w = await world();
    create(w);
    const revoked = new ConnectionsService(w.mem.deps).revoke("k1", who);          // no lifecycle listener: the pool is not told
    expect(revoked.ok).toBe(true);
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok && r.value.member).toBe("k2");
    expect(loaded(w).members.map(m => m.credential)).toEqual(["k2", "k3"]);
    expect(loaded(w).events.some(e => e.type === "MemberLeft" && e.why === "revoked")).toBe(true);
  });
});

describe("report", () => {
  it("applies an exhausted outcome and raises one alert; the same refusal again raises none", async () => {
    const w = await world();
    create(w);
    const out: Outcome = { kind: "exhausted", reason: "credit", resumeAt: null };
    expect(w.pools.report("p", "k2", out, w.mem.clock.now(), who).ok).toBe(true);
    expect(w.mem.alerts.raised.filter(a => a.kind === "key-exhausted")).toEqual([{ kind: "key-exhausted", name: "k2", detail: "credit" }]);
    expect(w.pools.report("p", "k2", out, w.mem.clock.now() + MIN, who).ok).toBe(true);
    expect(w.mem.alerts.raised.filter(a => a.kind === "key-exhausted")).toHaveLength(1);
    expect(loaded(w).members[1]?.health.state).toBe("exhausted");
  });

  it("a rate limit is recorded and raises nothing; the member still serves", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k1", { kind: "limited", retryAfterMs: 30_000 }, w.mem.clock.now(), who);
    expect(w.mem.alerts.raised).toEqual([]);
    expect(loaded(w).members[0]?.health.state).toBe("active");
  });

  it("a failing member raises key-failing and pool-blocked, the last exhausted one pool-empty", async () => {
    const w = await world(2);
    create(w, ["k1", "k2"]);
    w.pools.report("p", "k1", { kind: "failing", reason: "held" }, w.mem.clock.now(), who);
    expect(w.mem.alerts.raised).toEqual([{ kind: "key-failing", name: "k1", detail: "held" }, { kind: "pool-blocked", name: "k1", detail: "held" }]);
    const e = await world(2);
    create(e, ["k1", "k2"]);
    e.pools.report("p", "k1", { kind: "exhausted", reason: "credit", resumeAt: null }, e.mem.clock.now(), who);
    e.pools.report("p", "k2", { kind: "exhausted", reason: "spend-limit", resumeAt: null }, e.mem.clock.now(), who);
    expect(e.mem.alerts.raised.map(a => a.kind)).toEqual(["key-exhausted", "key-exhausted", "pool-empty"]);
    expect(e.mem.alerts.raised.at(-1)).toEqual({ kind: "pool-empty", name: "p", detail: "empty" });
  });

  it("refuses a pool or a member that is not there", async () => {
    const w = await world();
    create(w);
    expect(w.pools.report("nope", "k1", { kind: "unknown" }, 0, who).ok).toBe(false);
    expect(w.pools.report("p", "nope", { kind: "unknown" }, 0, who).ok).toBe(false);
  });

  it("reportSignal classifies with the preset's error dialect, drops the text, and raises unclassified for an unmatched 4xx with the status only", async () => {
    const w = await world();
    create(w);
    const dry = w.pools.reportSignal("p", "k1", { status: 400, kind: "invalid_request_error", text: "dry", retryAfterSeconds: null, code: null, resumeDate: null }, w.mem.clock.now());
    expect(dry.ok && dry.value.kind).toBe("exhausted");
    const odd = w.pools.reportSignal("p", "k2", { status: 418, kind: "teapot", text: "planted-secret-text-sk-123", retryAfterSeconds: null, code: null, resumeDate: null }, w.mem.clock.now());
    expect(odd.ok && odd.value.kind).toBe("unknown");
    expect(w.mem.alerts.raised.at(-1)).toEqual({ kind: "unclassified", name: "k2", detail: "418 teapot" });
    const ok5 = w.pools.reportSignal("p", "k3", { status: 529, kind: "overloaded_error", text: null, retryAfterSeconds: null, code: null, resumeDate: null }, w.mem.clock.now());
    expect(ok5.ok).toBe(true);
    expect(w.mem.alerts.raised.filter(a => a.kind === "unclassified")).toHaveLength(1);        // a 5xx is not unmatched 4xx
    expect(JSON.stringify([w.store.load("p"), w.mem.alerts.raised])).not.toContain("planted-secret-text");
  });

  it("reportSignal refuses a pool whose preset has no classifier for its dialect", async () => {
    const w = await world();
    create(w);
    w.mem.catalog.keyPools = { "vendor-a": poolTerms("kr1", "other") };
    const r = w.pools.reportSignal("p", "k1", { status: 401, kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null }, 0);
    expect(r.ok ? "" : r.error.problem).toBe("no_classifier");
  });
});

describe("commands: revive, leave, move, policy, delete", () => {
  it("revive is the principal's and ends a failing member's block", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k2", { kind: "failing", reason: "rejected" }, w.mem.clock.now(), who);
    expect(w.pools.revive("p", "k2", { kind: "operator" }).ok).toBe(false);
    expect(w.pools.revive("p", "k2", who).ok).toBe(true);
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok).toBe(true);
  });

  it("leave, move and policy change the pool; a member can join back; delete leaves a tombstone and the Connections stay", async () => {
    const w = await world();
    create(w);
    expect(w.pools.move("p", "k3", 0, who).ok).toBe(true);
    expect(loaded(w).members.map(m => m.credential)).toEqual(["k3", "k1", "k2"]);
    expect(w.pools.setPolicy("p", { mode: "drain" }, who).ok).toBe(true);
    expect(loaded(w).policy.mode).toBe("drain");
    expect(w.pools.leave("p", "k1", who).ok).toBe(true);
    expect(w.pools.join("p", "k1", { confirmOwn: true }, who).ok).toBe(true);
    expect(loaded(w).members.map(m => m.credential)).toEqual(["k3", "k2", "k1"]);
    expect(w.pools.delete("p", who).ok).toBe(true);
    expect(w.store.load("p").pool).toBeNull();
    expect(w.store.names()).toEqual({ live: [], deleted: ["p"] });
    expect(w.mem.store.directory.connections.map(c => c.name)).toEqual(["k1", "k2", "k3"]);
    expect(create(w).ok).toBe(false);
  });
});

describe("a Connection's life reaches the pool", () => {
  it("revoking a member removes it in the same command (kp8), and a pool of one member can be emptied", async () => {
    const w = await world(2);
    create(w, ["k1", "k2"]);
    expect(w.connections.revoke("k1", who).ok).toBe(true);
    expect(loaded(w).members.map(m => m.credential)).toEqual(["k2"]);
    expect(w.pools.poolOf("k2")).toBe("p");
    expect(w.pools.poolOf("k1")).toBeNull();
  });

  it("rotating a failing member's key makes it servable again", async () => {
    const w = await world(2);
    create(w, ["k1", "k2"]);
    w.pools.report("p", "k1", { kind: "failing", reason: "rejected" }, w.mem.clock.now(), who);
    w.mem.vault.put("ref-new", "0123456789cc");
    expect((await w.connections.rotate("k1", "ref-new", who)).ok).toBe(true);
    expect(loaded(w).members[0]?.health.state).toBe("active");
  });
});

describe("review F2: who may do what", () => {
  const operator: Actor = { kind: "operator" };
  const dry: Outcome = { kind: "exhausted", reason: "credit", resumeAt: null };
  const lane = (lease: string, pid = 10) => ({ kind: "lane" as const, lease, caller: { pid, startedAt: 1, bootId: "boot" } });
  async function leased(w: World, member = "k1"): Promise<string> {
    const granted = w.leases.lease(member, request);
    if (!granted.ok) throw new Error("no lease");
    return granted.value.id;
  }

  it("remove, policy and delete are the principal's: an operator changes nothing, and nothing is saved", async () => {
    const w = await world();
    create(w);
    const saves = w.store.saves;
    for (const result of [w.pools.leave("p", "k1", operator), w.pools.setPolicy("p", { mode: "drain" }, operator), w.pools.delete("p", operator),
      w.pools.leave("p", "k1", { kind: "principal", command: "" })]) {
      expect(result.ok ? "" : result.error.problem).toBe("principal");
    }
    expect(w.store.saves).toBe(saves);
    expect(loaded(w).members).toHaveLength(3);
    expect(loaded(w).policy.mode).toBe("round-robin");
  });

  it("removing the failing member does not lift the block behind the principal's back", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k2", { kind: "failing", reason: "denied" }, w.mem.clock.now(), who);
    expect(w.pools.leave("p", "k2", operator).ok).toBe(false);
    const r = await w.pools.pick("p", leasing(w));
    expect(r.ok ? null : r.error.problem).toBe("pool_blocked");
  });

  it("a principal's report marks exhausted, failing or limited; ok is refused, revive is the way back", async () => {
    const w = await world();
    create(w);
    expect(w.pools.report("p", "k1", dry, w.mem.clock.now(), who).ok).toBe(true);
    const ok = w.pools.report("p", "k1", { kind: "ok", evidence: "messages" }, w.mem.clock.now() + MIN, who);
    expect(ok.ok ? "" : ok.error.problem).toBe("not_allowed");
    expect(loaded(w).members[0]?.health.state).toBe("exhausted");
    expect(w.pools.revive("p", "k1", who).ok).toBe(true);
  });

  it("an operator's own report (the run wrapper, later a probe) may carry ok from a real Messages answer, and that recovers", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k1", dry, w.mem.clock.now(), who);
    w.mem.clock.at += MIN;
    expect(w.pools.report("p", "k1", { kind: "ok", evidence: "messages" }, w.mem.clock.now(), operator, "probe").ok).toBe(true);
    expect(loaded(w).members[0]?.health.state).toBe("active");
  });

  it("a lane reports only for the member of its own live lease, with the lease id", async () => {
    const w = await world();
    create(w);
    const id = await leased(w, "k1");
    expect(w.pools.report("p", "k1", dry, w.mem.clock.now(), lane(id)).ok).toBe(true);
    expect(loaded(w).members[0]?.health.state).toBe("exhausted");
  });

  it("a lane's report is refused for another member, an unknown or closed lease, a caller that is not the holder, and ok", async () => {
    const w = await world();
    create(w);
    const id = await leased(w, "k1");
    const word = (r: { ok: boolean; error?: { problem: string } }) => (r.ok ? "ok" : r.error?.problem);
    expect(word(w.pools.report("p", "k2", dry, w.mem.clock.now(), lane(id)))).toBe("lease_other_member");
    expect(word(w.pools.report("p", "k1", dry, w.mem.clock.now(), lane("l999")))).toBe("lease_missing");
    expect(word(w.pools.report("p", "k1", dry, w.mem.clock.now(), lane(id, 11)))).toBe("not_holder");
    expect(word(w.pools.report("p", "k1", { kind: "ok", evidence: "messages" }, w.mem.clock.now(), lane(id)))).toBe("not_allowed");
    expect(loaded(w).members.map(m => m.health.state)).toEqual(["active", "active", "active"]);
    w.leases.close("k1", id, "done", null);
    expect(word(w.pools.report("p", "k1", dry, w.mem.clock.now(), lane(id)))).toBe("lease_missing");
  });

  it("a lane holding the lease of a member that is not in the pool reports nothing", async () => {
    const w = await world(4);
    create(w, ["k1", "k2", "k3"]);
    const id = await leased(w, "k4");
    const r = w.pools.report("p", "k4", dry, w.mem.clock.now(), lane(id));
    expect(r.ok ? "" : r.error.problem).toBe("missing");
  });
});

describe("re-check NEW 3: join, move and revive need a named principal in the service too", () => {
  const blank: Actor = { kind: "principal", command: "  " };
  it("a whitespace-only command name changes nothing", async () => {
    const w = await world(3);
    create(w, ["k1", "k2"]);
    w.pools.report("p", "k1", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), who);
    const saves = w.store.saves;
    const word = (r: { ok: boolean; error?: { problem: string } }) => (r.ok ? "ok" : r.error?.problem);
    expect(word(w.pools.join("p", "k3", { confirmOwn: true }, blank))).toBe("principal");
    expect(word(w.pools.move("p", "k2", 0, blank))).toBe("principal");
    expect(word(w.pools.revive("p", "k1", blank))).toBe("principal");
    const made = w.pools.create({ name: "q", vendor: "vendor-a", runtime: "runtime-a", members: ["k3"], by: "ada", confirmOwn: true }, blank);
    expect(word(made)).toBe("principal");
    expect(w.store.saves).toBe(saves);
  });
});

describe("review F3: leaving a member out of a pick", () => {
  it("a caller can skip the member whose key just failed: it is not picked though it is active", async () => {
    const w = await world();
    create(w);
    const r = await w.pools.pick("p", leasing(w), { skip: ["k1"] });
    expect(r.ok && r.value.member).toBe("k2");
  });

  it("when nothing else can serve, the refusal is none_left with exit 75, and the gate is not called", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k2", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), who);
    w.pools.report("p", "k3", { kind: "exhausted", reason: "credit", resumeAt: null }, w.mem.clock.now(), who);
    let called = 0;
    const r = await w.pools.pick("p", async () => { called += 1; return { ok: true as const, value: null }; }, { skip: ["k1"] });
    expect(called).toBe(0);
    expect(r.ok ? null : r.error).toMatchObject({ problem: "none_left", exit: 75 });
  });
});

describe("review F4: the terms need a name", () => {
  it("create refuses a blank or whitespace-only --by in the service, and saves nothing", async () => {
    const w = await world();
    for (const by of ["", " ", "\t \n"]) {
      const r = create(w, undefined, { by });
      expect(r.ok ? "" : r.error.problem).toBe("ack_needed");
    }
    expect(w.store.saves).toBe(0);
  });
  it("a name is kept trimmed", async () => {
    const w = await world();
    expect(create(w, undefined, { by: "  ada " }).ok).toBe(true);
    expect(loaded(w).terms?.by).toBe("ada");
  });
});

describe("review F5: the alert's kind is bounded", () => {
  it("an unclassified refusal writes at most 64 characters of its error type", async () => {
    const w = await world();
    create(w);
    w.pools.reportSignal("p", "k1", { status: 418, kind: "x".repeat(200), text: null, retryAfterSeconds: null, code: null, resumeDate: null }, w.mem.clock.now());
    expect(w.mem.alerts.raised.at(-1)).toEqual({ kind: "unclassified", name: "k1", detail: `418 ${"x".repeat(64)}` });
  });
});

describe("review F6: a refusal that is only this caller's does not move the shared pointer", () => {
  const refuses = (words: Record<string, string>, w: World) => async (member: string) => {
    const word = words[member];
    return word ? { ok: false as const, error: { problem: word, exit: 75 } } : leasing(w)(member);
  };

  it("drain: the caller refused k1 is given k2, and the next caller still gets k1", async () => {
    const w = await world();
    create(w, undefined, { mode: "drain" });
    const first = await w.pools.pick("p", refuses({ k1: "repo" }, w));
    expect(first.ok && first.value.member).toBe("k2");
    expect(loaded(w).lastPick).toBeNull();
    const second = await w.pools.pick("p", leasing(w));
    expect(second.ok && second.value.member).toBe("k1");
    expect(loaded(w).lastPick).toBe("k1");
  });

  it("round-robin: the member finally leased is the last pick, so the next caller goes on from it", async () => {
    const w = await world();
    create(w);
    const first = await w.pools.pick("p", refuses({ k1: "repo" }, w));
    expect(first.ok && first.value.member).toBe("k2");
    expect(loaded(w).lastPick).toBe("k2");
    expect((await w.pools.pick("p", leasing(w))).ok && loaded(w).lastPick).toBe("k3");
  });

  it("when every member is refused the pointer is back where it was", async () => {
    const w = await world();
    create(w);
    await w.pools.pick("p", leasing(w));
    expect(loaded(w).lastPick).toBe("k1");
    const refused = await w.pools.pick("p", refuses({ k1: "repo", k2: "repo", k3: "isolation" }, w));
    expect(refused.ok ? null : refused.error).toMatchObject({ problem: "repo", exit: 75 });
    expect(loaded(w).lastPick).toBe("k1");
    expect(loaded(w).events.filter(e => e.type === "MemberPicked")).toHaveLength(1);
  });

  it("a failure that is not a gate word puts the pointer back too", async () => {
    const w = await world();
    create(w);
    await w.pools.pick("p", leasing(w));
    const r = await w.pools.pick("p", async () => ({ ok: false as const, error: { problem: "holder" } }));
    expect(r.ok ? null : r.error.problem).toBe("holder");
    expect(loaded(w).lastPick).toBe("k1");
  });
});

describe("state", () => {
  it("lists pools in ring order with health words, times and the lastPick, and no ref, fingerprint or secret", async () => {
    const w = await world();
    create(w);
    w.pools.report("p", "k2", { kind: "exhausted", reason: "spend-limit", resumeAt: w.mem.clock.now() + 2 * DAY }, w.mem.clock.now(), who);
    const view = w.pools.list();
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ name: "p", runtime: "runtime-a", vendor: "vendor-a", mode: "round-robin", standing: "ok", lastPick: null });
    expect(view[0]?.members).toEqual([
      { credential: "k1", state: "active", reason: null, since: w.mem.clock.now(), nextCheck: null },
      { credential: "k2", state: "exhausted", reason: "spend-limit", since: w.mem.clock.now(), nextCheck: w.mem.clock.now() + 2 * DAY },
      { credential: "k3", state: "active", reason: null, since: w.mem.clock.now(), nextCheck: null },
    ]);
    const text = JSON.stringify([view, w.mem.alerts.raised, loaded(w)]);
    expect(text).not.toContain(REF);
    expect(text).not.toContain(FP);
    expect(w.pools.state("nope")).toBeNull();
  });
});
