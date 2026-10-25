// The pooled helper's hand-off (ADR-0037, slice 2; KP17, KP18, KP19): a run holds a grant in the pool; each helper call checks the grant,
// its lease and its member, and moves the run to the next member when the one it is on cannot serve. Two stores, one database: a crash
// between the lease swap and the grant save, or between the grant save and the audit line, leaves a state the next call mends.
// In-memory ports, a manual clock; the "crash" is an exception thrown out of the call at the named point.
import { describe, expect, it } from "vitest";
import type { KeyPoolTerms, VendorPreset } from "@morndo/protocol";
import type { Actor, ConnEvent, Directory, Grant, Holder, KeyPool, Outcome } from "@morndo/domain";
import { findConnection, isKey } from "@morndo/domain";
import {
  ConnectionsService, KeyPoolService, LeaseService, MemoryKeyPoolStore, memory,
  type Failure, type Memory, type OutcomeClassifier,
} from "../src/application/index.ts";

const who: Actor = { kind: "principal", command: "c1" };
const operator: Actor = { kind: "operator" };
const SEC = 1_000;
const TTL = 60 * SEC;
const holder: Holder = { node: "n1", pid: 10, startedAt: 1, bootId: "boot", lane: "lane-a" };
const caller = { id: { pid: 10, startedAt: 1, bootId: "boot" }, ppid: 9 };
const stranger = { id: { pid: 11, startedAt: 1, bootId: "boot" }, ppid: 9 };
const REF = "ref-planted-vault-0001";
const FP = "feedfacecafe";
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

// A pool store that can fail a save, as a process killed at that point would: the write never happens and the call never returns.
class CrashingStore extends MemoryKeyPoolStore {
  crashWhen: (() => boolean) | null = null;
  // The next `times` saves made while `when` holds lose the version race (another writer got there first).
  lose: { when: () => boolean; times: number } | null = null;
  override save(pool: KeyPool, version: number): boolean {
    if (this.crashWhen?.()) { this.crashWhen = null; throw new Error("crash"); }
    if (this.lose && this.lose.times > 0 && this.lose.when()) { this.lose.times -= 1; return false; }
    return super.save(pool, version);
  }
}
class CrashingLeases extends LeaseService {
  crashServe = false;
  // Runs once, just before the next swap: another process's write landing between this call's read and its swap.
  beforeSwap: (() => void) | null = null;
  override swap(...args: Parameters<LeaseService["swap"]>): ReturnType<LeaseService["swap"]> {
    const hook = this.beforeSwap;
    if (hook) { this.beforeSwap = null; hook(); }
    return super.swap(...args);
  }
  override serve(...args: Parameters<LeaseService["serve"]>): ReturnType<LeaseService["serve"]> {
    if (this.crashServe) { this.crashServe = false; throw new Error("crash"); }
    return super.serve(...args);
  }
}

type World = { mem: Memory; pools: KeyPoolService; store: CrashingStore; connections: ConnectionsService; leases: CrashingLeases };

async function world(n = 3): Promise<World> {
  const mem = memory();
  mem.catalog.rows = [preset()];
  mem.catalog.keyPools = { "vendor-a": poolTerms };
  const store = new CrashingStore();
  const leases = new CrashingLeases(mem.deps);
  const pools = new KeyPoolService({
    clock: mem.clock, store, connections: mem.store, catalog: mem.catalog, alerts: mem.alerts, processes: mem.processes,
    classifiers: { for: d => (d === "dialect-a" ? classifier : null) }, leases, helper: { limit: 4, ttlMs: TTL },
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
  return { mem, pools, store, connections, leases };
}

const runRequest = { role: "run", entry: "m", holder, workspacePath: "/work/repo", limit: 8, reserve: 1, margin: 0, probe: false };
// What `run --pool` does: pick a member, take its run lease, and open the grant in the same save as the pick.
async function start(w: World): Promise<{ grant: string; member: string; lease: string }> {
  const picked = await w.pools.pick("p", async member => w.leases.lease(member, runRequest), {
    grant: (_member: string, value: { id: string }) => ({
      lease: value.id, holder, startedAt: w.mem.clock.now(),
      request: { role: "run", entry: "m", workspacePath: "/work/repo", limit: 8, reserve: 1, margin: 0 },
    }),
  });
  if (!picked.ok || !picked.value.grant) throw new Error(`no grant: ${JSON.stringify(picked)}`);
  return { grant: picked.value.grant, member: picked.value.member, lease: picked.value.value.id };
}
const pool = (w: World): KeyPool => {
  const { pool: loaded } = w.store.load("p");
  if (!loaded) throw new Error("no pool");
  return loaded;
};
const grantOf = (w: World): Grant => {
  const g = pool(w).grants[0];
  if (!g) throw new Error("no grant");
  return g;
};
const dir = (w: World): Directory => w.mem.store.load().directory;
const live = (w: World, name: string) => {
  const c = findConnection(dir(w), name);
  return c && isKey(c) ? c.leases : [];
};
const served = (w: World): ConnEvent[] => dir(w).events.filter(e => e.type === "KeyServed");
const granted = (w: World): number => dir(w).events.filter(e => e.type === "LeaseGranted").length;
const types = (p: KeyPool) => p.events.map(e => e.type);
const word = (r: { ok: boolean; error?: Failure }) => (r.ok ? "ok" : r.error?.problem);
const dryUp = (w: World, member: string) => w.pools.report("p", member, dry, w.mem.clock.now(), operator);

describe("a run's grant opens in the same save as the pick", () => {
  it("names the member and lease the run took, the holder and the request, and a window of no calls yet", async () => {
    const w = await world();
    const run = await start(w);
    expect(run.member).toBe("k1");
    expect(run.grant).toBe(`g${run.lease}`);
    expect(grantOf(w)).toMatchObject({
      id: run.grant, member: "k1", lease: run.lease, holder, previous: null, window: { calls: 0 },
      request: { role: "run", entry: "m", workspacePath: "/work/repo", limit: 8, reserve: 1, margin: 0 },
    });
    expect(types(pool(w)).slice(-2)).toEqual(["MemberPicked", "GrantOpened"]);
  });
  it("a pick without a grant option opens none", async () => {
    const w = await world();
    const picked = await w.pools.pick("p", async member => w.leases.lease(member, runRequest));
    expect(picked.ok && picked.value.grant).toBeFalsy();
    expect(pool(w).grants).toEqual([]);
  });
});

describe("handOff on a healthy member serves it", () => {
  it("counts the call on the lease, writes one KeyServed before it returns, and records the window in the grant", async () => {
    const w = await world();
    const run = await start(w);
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out).toEqual({ ok: true, value: { connection: "k1", lease: run.lease } });
    expect(live(w, "k1")[0]).toMatchObject({ id: run.lease, calls: 1 });
    expect(served(w)).toHaveLength(1);
    expect(served(w)[0]).toMatchObject({ type: "KeyServed", name: "k1", lease: run.lease, caller: { pid: 10, ppid: 9, lane: "lane-a", workspace: "/work/repo", proof: "claimed" } });
    expect(grantOf(w).window.calls).toBe(1);
    expect(granted(w)).toBe(1);
  });
  it("refuses a caller that is not the holder or its child, and a grant that is not there, and serves nothing", async () => {
    const w = await world();
    const run = await start(w);
    expect(word(await w.pools.handOff("p", run.grant, stranger))).toBe("not_holder");
    expect(word(await w.pools.handOff("p", "nope", caller))).toBe("grant_missing");
    expect(served(w)).toHaveLength(0);
  });
  it("a child of the holder is the holder (the process tree check)", async () => {
    const w = await world();
    const run = await start(w);
    w.mem.processes.ancestors = () => [{ pid: 12, startedAt: 1, bootId: "boot" }, caller.id];
    expect((await w.pools.handOff("p", run.grant, { id: { pid: 13, startedAt: 1, bootId: "boot" }, ppid: 12 })).ok).toBe(true);
  });
});

describe("handOff when the member is exhausted: the run moves to the next member", () => {
  it("closes the old lease as a hand-off, takes a freshly gated lease on the next member, names it in the grant and serves it once", async () => {
    const w = await world();
    const run = await start(w);
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    dryUp(w, "k1");
    w.mem.clock.at += 10 * SEC;
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k2");
    const moved = grantOf(w);
    expect(moved).toMatchObject({ member: "k2", previous: { member: "k1", movedAt: w.mem.clock.now() } });
    expect(live(w, "k1")).toHaveLength(0);
    expect(live(w, "k2").map(l => l.id)).toEqual([moved.lease]);
    expect(dir(w).events.some(e => e.type === "LeaseClosed" && e.lease === run.lease && e.outcome === "handoff")).toBe(true);
    expect(types(pool(w)).filter(t => t === "GrantMoved")).toHaveLength(1);
    expect(types(pool(w)).filter(t => t === "MemberPicked")).toHaveLength(2);
    expect(pool(w).lastPick).toBe("k2");
    expect(served(w).map(e => e.type === "KeyServed" && e.lease)).toEqual([run.lease, moved.lease]);
  });
  it("the next member's own gate runs again: a member that is off is declined and the one after it is taken", async () => {
    const w = await world();
    const run = await start(w);
    w.connections.turnOff("k2");
    dryUp(w, "k1");
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k3");
    const picked = pool(w).events.filter(e => e.type === "MemberPicked").at(-1);
    expect(picked).toMatchObject({ member: "k3", declined: [{ member: "k2", word: "off" }] });
    expect(pool(w).members.find(m => m.credential === "k2")?.health.state).toBe("active");
  });
  it("the call count and window start carry over, so handing off does not reset the helper's cap (KP17)", async () => {
    const w = await world();
    const run = await start(w);
    for (let i = 0; i < 3; i++) expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    dryUp(w, "k1");
    const start0 = live(w, "k1")[0]?.windowStart;
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    expect(live(w, "k2")[0]).toMatchObject({ calls: 4, windowStart: start0 });
    const over = await w.pools.handOff("p", run.grant, caller);
    expect(word(over)).toBe("authority");
  });
  it("every member exhausted: nothing is printed and the word is pool_empty", async () => {
    const w = await world(2);
    const run = await start(w);
    dryUp(w, "k1");
    dryUp(w, "k2");
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(word(out)).toBe("pool_empty");
    expect(served(w)).toHaveLength(0);
  });
});

describe("handOff when the member is active but its lease cannot be refreshed", () => {
  it("a refresh refused by the gate swaps to the next member and leaves the first member's health alone", async () => {
    const w = await world();
    const run = await start(w);
    w.connections.turnOff("k1");
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k2");
    expect(pool(w).members.find(m => m.credential === "k1")?.health.state).toBe("active");
    expect(live(w, "k1")).toHaveLength(0);
  });
});

describe("handOff when a member is failing: the pool is stopped", () => {
  it("prints nothing, takes no lease, and says pool_blocked", async () => {
    const w = await world();
    const run = await start(w);
    w.pools.report("p", "k1", { kind: "failing", reason: "rejected" }, w.mem.clock.now(), operator);
    const before = granted(w);
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(word(out)).toBe("pool_blocked");
    expect(granted(w)).toBe(before);
    expect(served(w)).toHaveLength(0);
  });
});

describe("handOff when the helper's authority has ended (CN9, KP17)", () => {
  it("exits authority: no new lease, no swap, even though the member is exhausted; and again on the next call", async () => {
    const w = await world();
    const run = await start(w);
    for (let i = 0; i < 4; i++) expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    dryUp(w, "k1");
    const before = granted(w);
    expect(word(await w.pools.handOff("p", run.grant, caller))).toBe("authority");
    expect(word(await w.pools.handOff("p", run.grant, caller))).toBe("authority");
    expect(granted(w)).toBe(before);
    expect(grantOf(w).member).toBe("k1");
    expect(w.mem.alerts.raised.some(a => a.kind === "authority" && a.name === "k1")).toBe(true);
  });
});

describe("handOff when the grant's lease is gone", () => {
  it("swept while the member is servable: a new gated lease on the same member, the window inherited", async () => {
    const w = await world();
    const run = await start(w);
    for (let i = 0; i < 2; i++) expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    const windowStart = live(w, "k1")[0]?.windowStart;
    w.mem.processes.dead.add(holder.pid);
    expect(w.leases.sweep().ok).toBe(true);
    expect(live(w, "k1")).toHaveLength(0);
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k1");
    const fresh = live(w, "k1");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ calls: 3, windowStart });
    expect(grantOf(w).lease).toBe(fresh[0]?.id);
    expect(grantOf(w).member).toBe("k1");
  });
  it("swept while the member is exhausted: the next member is picked and gated", async () => {
    const w = await world();
    const run = await start(w);
    w.mem.processes.dead.add(holder.pid);
    w.leases.sweep();
    dryUp(w, "k1");
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k2");
    expect(live(w, "k2")).toHaveLength(1);
  });
  it("swept with the cap already used up in its window: exits authority and takes no lease", async () => {
    const w = await world();
    const run = await start(w);
    for (let i = 0; i < 4; i++) expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    w.mem.processes.dead.add(holder.pid);
    w.leases.sweep();
    const before = granted(w);
    expect(word(await w.pools.handOff("p", run.grant, caller))).toBe("authority");
    expect(granted(w)).toBe(before);
  });
});

describe("kp19 two helper calls at once leave exactly one live lease", () => {
  it("the loser finds the old lease closed and a live lease of the holder on the new member, and adopts it", async () => {
    const w = await world();
    const run = await start(w);
    dryUp(w, "k1");
    const [a, b] = await Promise.all([w.pools.handOff("p", run.grant, caller), w.pools.handOff("p", run.grant, caller)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.value.lease === b.value.lease).toBe(true);
    expect(live(w, "k1")).toHaveLength(0);
    expect(live(w, "k2")).toHaveLength(1);
    expect(granted(w)).toBe(2);
    expect(types(pool(w)).filter(t => t === "GrantMoved")).toHaveLength(1);
    expect(served(w)).toHaveLength(2);
    expect(served(w).every(e => e.type === "KeyServed" && e.lease === live(w, "k2")[0]?.id)).toBe(true);
    expect(grantOf(w).lease).toBe(live(w, "k2")[0]?.id);
  });
});

describe("kp19 a crash between the lease swap and the grant save", () => {
  it("leaves the old lease closed, a live lease on the new member and the grant naming the old; the next call adopts it: no second lease, one KeyServed", async () => {
    const w = await world();
    const run = await start(w);
    dryUp(w, "k1");
    const swaps = granted(w);
    w.store.crashWhen = () => granted(w) > swaps;
    await expect(w.pools.handOff("p", run.grant, caller)).rejects.toThrow("crash");
    expect(grantOf(w)).toMatchObject({ member: "k1", lease: run.lease });
    expect(live(w, "k1")).toHaveLength(0);
    expect(live(w, "k2")).toHaveLength(1);
    expect(served(w)).toHaveLength(0);
    const fresh = live(w, "k2")[0]?.id;
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out).toEqual({ ok: true, value: { connection: "k2", lease: fresh } });
    expect(granted(w)).toBe(swaps + 1);
    expect(live(w, "k2")).toHaveLength(1);
    expect(served(w)).toHaveLength(1);
    expect(grantOf(w)).toMatchObject({ member: "k2", lease: fresh, previous: { member: "k1" } });
  });
});

describe("a crash between the grant save and the audit line", () => {
  it("prints nothing; the next call serves the lease the grant names, with no new lease and exactly one KeyServed", async () => {
    const w = await world();
    const run = await start(w);
    dryUp(w, "k1");
    w.leases.crashServe = true;
    await expect(w.pools.handOff("p", run.grant, caller)).rejects.toThrow("crash");
    expect(grantOf(w).member).toBe("k2");
    expect(served(w)).toHaveLength(0);
    const swaps = granted(w);
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k2");
    expect(out.ok && out.value.lease).toBe(grantOf(w).lease);
    expect(granted(w)).toBe(swaps);
    expect(served(w)).toHaveLength(1);
  });
});

describe("kp18 a report right after a hand-off belongs to the member the old key came from", () => {
  async function handedOff(): Promise<{ w: World; run: { grant: string } }> {
    const w = await world();
    const run = await start(w);
    dryUp(w, "k1");
    w.mem.clock.at += 10 * SEC;
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    return { w, run };
  }
  it("inside the window a credit refusal changes nothing about the new member; after it the new member is marked", async () => {
    const { w, run } = await handedOff();
    w.mem.clock.at += 30 * SEC;
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "operator" }).ok).toBe(true);
    expect(pool(w).members.find(m => m.credential === "k2")?.health.state).toBe("active");
    w.mem.clock.at += 31 * SEC;
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "operator" }).ok).toBe(true);
    expect(pool(w).members.find(m => m.credential === "k2")?.health.state).toBe("exhausted");
    expect(grantOf(w).previous).toBeNull();
  });
  it("attribute answers the member to blame, for the run wrapper that reads the grant at the run's end", async () => {
    const { w, run } = await handedOff();
    w.mem.clock.at += 5 * SEC;
    expect(w.pools.attribute("p", run.grant)).toEqual({ ok: true, value: "k1" });
    w.mem.clock.at += TTL;
    expect(w.pools.attribute("p", run.grant)).toEqual({ ok: true, value: "k2" });
    expect(word(w.pools.attribute("p", "nope"))).toBe("grant_missing");
  });
  it("a lane reports through its own grant only: the holder or its child, and only a refusal", async () => {
    const { w, run } = await handedOff();
    w.mem.clock.at += TTL;
    expect(word(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: stranger.id }))).toBe("not_holder");
    expect(word(w.pools.reportByGrant("p", run.grant, { kind: "ok", evidence: "messages" }, w.mem.clock.now(), { kind: "holder", caller: caller.id }))).toBe("not_allowed");
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: caller.id }).ok).toBe(true);
    expect(pool(w).members.find(m => m.credential === "k2")?.health.state).toBe("exhausted");
  });
});

describe("a grant's life", () => {
  it("closeGrant removes it, and a call on a grant that is gone says grant_missing", async () => {
    const w = await world();
    const run = await start(w);
    w.pools.closeGrant("p", run.grant);
    expect(pool(w).grants).toEqual([]);
    expect(types(pool(w)).at(-1)).toBe("GrantClosed");
    expect(word(await w.pools.handOff("p", run.grant, caller))).toBe("grant_missing");
  });
  it("sweepGrants removes the grants whose holder has gone", async () => {
    const w = await world();
    await start(w);
    expect(w.pools.sweepGrants()).toBe(0);
    w.mem.processes.dead.add(holder.pid);
    expect(w.pools.sweepGrants()).toBe(1);
    expect(pool(w).grants).toEqual([]);
  });
  it("grantOf says which member and lease a grant names now, and null when it is gone", async () => {
    const w = await world();
    const run = await start(w);
    expect(w.pools.grantOf("p", run.grant)).toEqual({ member: "k1", lease: run.lease });
    expect(w.pools.grantOf("p", "nope")).toBeNull();
  });
});

// The helper's callers, as the process tree has them: the run (10) holds claude sessions 20 and 30; each helper call is a child of its session.
const sessions: Record<number, number[]> = { 21: [21, 20, 10], 22: [22, 20, 10], 31: [31, 30, 10], 32: [32, 30, 10], 41: [41, 40, 10] };
const proc = (pid: number) => ({ pid, startedAt: 1, bootId: "boot" });
const helperOf = (pid: number, parent: number) => ({ id: proc(pid), ppid: parent });
const inTree = (w: World) => { for (const [pid, chain] of Object.entries(sessions)) w.mem.processes.tree.set(Number(pid), chain); };

describe("kp18 fix round 1: a report is the key its own session was served, not whoever the window names", () => {
  // Session 20 and session 30 are both served k1; k1 runs dry; session 20 asks again and is moved to k2. Session 30 still holds the old key.
  async function twoSessions(): Promise<{ w: World; run: { grant: string } }> {
    const w = await world();
    inTree(w);
    const run = await start(w);
    expect((await w.pools.handOff("p", run.grant, helperOf(21, 20))).ok).toBe(true);
    expect((await w.pools.handOff("p", run.grant, helperOf(31, 30))).ok).toBe(true);
    dryUp(w, "k1");
    w.mem.clock.at += 10 * SEC;
    const moved = await w.pools.handOff("p", run.grant, helperOf(21, 20));
    expect(moved.ok && moved.value.connection).toBe("k2");
    w.mem.clock.at += 5 * SEC;
    return { w, run };
  }
  const state = (w: World, name: string) => pool(w).members.find(m => m.credential === name)?.health.state;
  it("the grant remembers which member each session was last served", async () => {
    const { w } = await twoSessions();
    // A changed entry goes last: session 20 was served k1, then 30 k1, then 20 was moved to k2.
    expect(grantOf(w).seen).toEqual([{ session: "30:1:boot", member: "k1" }, { session: "20:1:boot", member: "k2" }]);
  });
  it("a refusal from the session that was moved to k2 marks k2, inside the window: a dry new key does not stay in service", async () => {
    const { w, run } = await twoSessions();
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: proc(22) }).ok).toBe(true);
    expect(state(w, "k2")).toBe("exhausted");
  });
  it("a refusal from the session that still holds the old key is the old key's: k2 stays active", async () => {
    const { w, run } = await twoSessions();
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: proc(32) }).ok).toBe(true);
    expect(state(w, "k2")).toBe("active");
  });
  it("a process of the run the grant has never served falls back to the window: the old key's", async () => {
    const { w, run } = await twoSessions();
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: proc(41) }).ok).toBe(true);
    expect(state(w, "k2")).toBe("active");
  });
  it("a lane cannot pick which member it blames: a report is about the key its own session holds, whatever it says", async () => {
    const { w, run } = await twoSessions();
    // Session 30 holds k1 (already dry): its failing report is k1's (a refused key beats an exhausted one) and cannot touch k2.
    expect(w.pools.reportByGrant("p", run.grant, { kind: "failing", reason: "rejected" }, w.mem.clock.now(), { kind: "holder", caller: proc(32) }).ok).toBe(true);
    expect(state(w, "k2")).toBe("active");
    expect(pool(w).members.find(m => m.credential === "k1")?.health.state).toBe("failing");
  });
  it("the run wrapper names its child's session: attribute answers that session's member, and without one the window's", async () => {
    const { w, run } = await twoSessions();
    expect(w.pools.attribute("p", run.grant, "20:1:boot")).toEqual({ ok: true, value: "k2" });
    expect(w.pools.attribute("p", run.grant, "30:1:boot")).toEqual({ ok: true, value: "k1" });
    expect(w.pools.attribute("p", run.grant)).toEqual({ ok: true, value: "k1" });
  });
  it("a session served again on the same member keeps one entry", async () => {
    const w = await world();
    inTree(w);
    const run = await start(w);
    for (let i = 0; i < 3; i++) expect((await w.pools.handOff("p", run.grant, helperOf(21, 20))).ok).toBe(true);
    expect(grantOf(w).seen).toEqual([{ session: "20:1:boot", member: "k1" }]);
  });
});

describe("fix round 1: two helper processes re-leasing a swept member do not leave two leases", () => {
  it("a lease that landed between the read and the swap is adopted: the late call takes none and serves that one", async () => {
    const w = await world();
    const run = await start(w);
    w.mem.processes.dead.add(holder.pid);
    expect(w.leases.sweep().ok).toBe(true);
    expect(live(w, "k1")).toHaveLength(0);
    let theirs = "";
    w.leases.beforeSwap = () => {
      const granted = w.leases.lease("k1", runRequest);
      if (granted.ok) theirs = granted.value.id;
    };
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(theirs).not.toBe("");
    expect(out).toEqual({ ok: true, value: { connection: "k1", lease: theirs } });
    expect(live(w, "k1").map(l => l.id)).toEqual([theirs]);
    expect(granted(w)).toBe(2);
    expect(grantOf(w).lease).toBe(theirs);
  });
  it("the same when the member is exhausted and the next one is picked", async () => {
    const w = await world();
    const run = await start(w);
    w.mem.processes.dead.add(holder.pid);
    w.leases.sweep();
    dryUp(w, "k1");
    let theirs = "";
    w.leases.beforeSwap = () => {
      const granted = w.leases.lease("k2", runRequest);
      if (granted.ok) theirs = granted.value.id;
    };
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out).toEqual({ ok: true, value: { connection: "k2", lease: theirs } });
    expect(live(w, "k2").map(l => l.id)).toEqual([theirs]);
  });
});

describe("kp8 fix round 2: a member that leaves or is revoked does not strand the run on it", () => {
  const after = async (how: "leave" | "revoke") => {
    const w = await world();
    const run = await start(w);
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    const old = grantOf(w).lease;
    if (how === "leave") expect(w.pools.leave("p", "k1", who).ok).toBe(true);
    else expect(w.connections.revoke("k1", who).ok).toBe(true);
    const out = await w.pools.handOff("p", run.grant, caller);
    return { w, run, out, old };
  };
  for (const how of ["leave", "revoke"] as const) {
    it(`${how}: the next helper call moves the run to another member, closes the removed member's lease and serves the new key`, async () => {
      const { w, out, old } = await after(how);
      expect(out.ok && out.value.connection).toBe("k2");
      expect(grantOf(w)).toMatchObject({ member: "k2", previous: { member: "k1" } });
      expect(live(w, "k1")).toHaveLength(0);
      expect(live(w, "k2")).toHaveLength(1);
      expect(dir(w).events.some(e => e.type === "LeaseClosed" && e.lease === old && e.outcome === "handoff")).toBe(true);
      expect(types(pool(w)).filter(t => t === "GrantMoved")).toHaveLength(1);
      expect(served(w).at(-1)).toMatchObject({ type: "KeyServed", name: "k2" });
    });
  }
  it("a report credited to the member that left is accepted and changes nothing", async () => {
    const { w, run } = await after("leave");
    expect(w.pools.reportByGrant("p", run.grant, dry, w.mem.clock.now(), { kind: "holder", caller: caller.id }).ok).toBe(true);
    expect(pool(w).members.find(m => m.credential === "k2")?.health.state).toBe("active");
  });
  it("when no member is left the call says pool_empty and the lease of the removed member is still the run's to close", async () => {
    const w = await world(2);
    const run = await start(w);
    expect(w.pools.leave("p", "k2", who).ok).toBe(true);
    expect(w.pools.leave("p", "k1", who).ok).toBe(true);
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok).toBe(false);
    expect(w.pools.grantOf("p", run.grant)).toEqual({ member: "k1", lease: run.lease });
  });
});

describe("fix round 2: one call is counted once when the grant save after a swap is lost", () => {
  it("the retry adopts the new lease and serves it without counting the call a second time", async () => {
    const w = await world();
    const run = await start(w);
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    dryUp(w, "k1");
    const swaps = granted(w);
    w.store.lose = { when: () => granted(w) > swaps, times: 8 };
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k2");
    expect(live(w, "k2")).toHaveLength(1);
    expect(live(w, "k2")[0]?.calls).toBe(2);
    expect(grantOf(w).window.calls).toBe(2);
    expect(granted(w)).toBe(swaps + 1);
  });
});

describe("fix round 3: a call is counted once when the count was not made by a swap either", () => {
  it("a pool save lost after the count (the window is recorded) retries without counting the call again", async () => {
    const w = await world();
    const run = await start(w);
    w.store.lose = { when: () => true, times: 8 };
    const out = await w.pools.handOff("p", run.grant, caller);
    expect(out.ok && out.value.connection).toBe("k1");
    expect(live(w, "k1")[0]?.calls).toBe(1);
    expect(grantOf(w).window.calls).toBe(1);
    expect(served(w)).toHaveLength(1);
  });
  it("every member a call serves goes into the grant's history, with the key served once per print", async () => {
    const w = await world();
    const run = await start(w);
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    dryUp(w, "k1");
    expect((await w.pools.handOff("p", run.grant, caller)).ok).toBe(true);
    expect(grantOf(w).lent).toEqual(["k1", "k2"]);
  });
});

describe("kp12 nothing secret reaches the grant, its events or the alerts", () => {
  it("after a hand-off the pool's JSON, the alerts and the KeyServed lines hold no fingerprint or vault ref", async () => {
    const w = await world();
    const run = await start(w);
    dryUp(w, "k1");
    await w.pools.handOff("p", run.grant, caller);
    const all = JSON.stringify([pool(w), w.mem.alerts.raised, served(w)]);
    expect(all).not.toContain(FP);
    expect(all).not.toContain(REF);
  });
});

describe("the existing pick is unchanged", () => {
  it("still returns the member and value, and a gate refusal still falls through", async () => {
    const w = await world();
    w.connections.turnOff("k1");
    const picked = await w.pools.pick("p", async member => w.leases.lease(member, runRequest));
    expect(picked.ok && picked.value.member).toBe("k2");
  });
});
