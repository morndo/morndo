// Connections (ADR-0018; CN1–CN15). One history per invariant. `now` is the clock; nothing here reads the wall clock.
// Names and fingerprints are synthetic. No secret bytes are stored: a key test keeps the bytes in a local and asserts
// they never appear on the directory.
import { describe, expect, it } from "vitest";
import {
  LEASE_REFUSED,   acknowledge, addKey, addLayer, addSubscription, availability, check, closeLease, effectiveIsolation,
  emptyDirectory, findConnection, gate, isKey, lease, loseLease, noteHelper, recordSpend, refresh, repoAdmits,
  repoWidens, revoke, reviseTerms, rotate, setBudget, setExpiry, setIsolation, setRepo, spentOf, turnOff, turnOn,
  type Actor, type Connection, type Directory, type Holder, type Isolation, type LeaseAsk, type Workspace,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const principal = (command = "c1"): Actor => ({ kind: "principal", command });
const operator: Actor = { kind: "operator" };
const FP = "0123456789ab";
const FP2 = "0123456789ac";

const value = <T>(r: { ok: true; value: T } | { ok: false; error: { problem: string } }): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};
const problem = (r: { ok: boolean; error?: { problem: string } }) => (r.ok ? "ok" : r.error?.problem);

function key(dir: Directory, name = "credit1", fingerprint = FP, extra: { expiry?: number | null; budget?: { kind: "capped"; amount: number } | { kind: "unlimited" }; billing?: "metered" | "prepaid" } = {}): Directory {
  return value(addKey(dir, {
    name, vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
    ref: `ref-${name}`, fingerprint, billing: extra.billing ?? "metered",
    budget: extra.budget ?? { kind: "capped", amount: 10 }, expiry: extra.expiry ?? null,
  }, principal(), T));
}
function sub(dir: Directory, name = "sub-a"): Directory {
  return value(addSubscription(dir, {
    name, vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules", configDir: "/cfg/a",
  }, principal(), T));
}
function ack(dir: Directory, name = "credit1", revision = "r1"): Directory {
  return value(acknowledge(dir, name, revision, "ada", principal(), T));
}
const ws = (path = "/work/repo", remotes: string[] = []): Workspace => ({ path, remotes });
const holder: Holder = { node: "n1", pid: 10, startedAt: 100, bootId: "boot", lane: "lane-a" };
function ask(over: Partial<LeaseAsk> = {}): LeaseAsk {
  return {
    now: T, revision: "r1", workspace: ws(), dialect: "dialect-a",
    runtime: { isolation: "rules", dialects: ["dialect-a"] }, floor: "rules", limit: 2, reserve: 1, margin: 0, probe: false,
    holder, role: "implement", entry: "credit1:m@high", runtimeName: "runtime-a", ...over,
  };
}
const conn = (dir: Directory, name: string): Connection => {
  const c = findConnection(dir, name);
  if (!c) throw new Error(`missing ${name}`);
  return c;
};

describe("CN1: no secret bytes in the model", () => {
  it("a key holds a ref and a fingerprint; the bytes never land on the directory", () => {
    const secret = "sk-ant-synthetic-does-not-belong-in-the-model";
    const dir = key(emptyDirectory());
    const c = conn(dir, "credit1");
    expect(isKey(c) && c.ref).toBe("ref-credit1");
    expect(isKey(c) && c.fingerprint).toBe(FP);
    expect(JSON.stringify(dir)).not.toContain(secret);
    expect(Object.keys(c).some(k => /secret|plaintext|apiKey|token/i.test(k))).toBe(false);
  });
});

describe("CN2: names are unique, revoked included, and a fingerprint is never shared", () => {
  it("refuses a bad name, a reuse after revoke, and a matching fingerprint", () => {
    expect(problem(addKey(emptyDirectory(), {
      name: "Credit", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
      ref: "ref-a", fingerprint: FP, billing: "metered", budget: { kind: "capped", amount: 1 }, expiry: null,
    }, principal(), T))).toBe("bad_name");
    const once = key(emptyDirectory());
    const revoked = value(revoke(once, "credit1", principal(), T));
    expect(problem(addKey(revoked, {
      name: "credit1", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
      ref: "ref-b", fingerprint: FP2, billing: "metered", budget: { kind: "capped", amount: 1 }, expiry: null,
    }, principal(), T))).toBe("taken");
    const other = key(once, "credit2", FP2);
    expect(problem(rotate(other, "credit2", "ref-c", FP, principal(), T))).toBe("fingerprint");
  });
  it("rotation keeps the budget and the spend and changes the fingerprint", () => {
    let dir = key(emptyDirectory());
    dir = value(recordSpend(dir, "credit1", 4, "estimate", operator, T));
    dir = value(rotate(dir, "credit1", "ref-next", FP2, principal(), T + 1));
    const c = conn(dir, "credit1");
    expect(isKey(c) && c.fingerprint).toBe(FP2);
    expect(isKey(c) && c.budget).toEqual({ kind: "capped", amount: 10 });
    expect(isKey(c) && spentOf(c.spend)).toBe(4);
    expect(dir.events.at(-1)).toMatchObject({ type: "ConnectionRotated", fingerprint: FP2 });
  });
});

describe("CN3: kind, vendor and runtime are fixed; each custody holds only its own fields", () => {
  it("a subscription has no key fields, a prepaid key needs an expiry, and engine-layer custody holds neither", () => {
    const s = conn(sub(emptyDirectory()), "sub-a");
    expect(s.kind).toBe("subscription");
    expect("ref" in s || "budget" in s || "expiry" in s).toBe(false);
    expect(problem(addKey(emptyDirectory(), {
      name: "pre", vendor: "vendor-a", runtime: "runtime-a", isolation: "os", floor: "os",
      ref: "ref-pre", fingerprint: FP, billing: "prepaid", budget: { kind: "capped", amount: 1 }, expiry: null,
    }, principal(), T))).toBe("expiry");
    const layer = value(addLayer(emptyDirectory(), {
      name: "layer-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "none", kind: "subscription",
    }, principal(), T));
    const l = conn(layer, "layer-a");
    expect(l.custody).toBe("engine-layer");
    expect("ref" in l || "budget" in l).toBe(false);
    expect(problem(lease(layer, "layer-a", ask()))).toBe("custody");
  });
});

describe("CN4: terms first", () => {
  it("refuses a run until the current revision is acknowledged, and a new revision asks again", () => {
    let dir = key(emptyDirectory());
    const refused = lease(dir, "credit1", ask());
    expect(problem(refused)).toBe("terms");
    expect(refused.ok ? null : refused.error.directory?.events.at(-1)).toMatchObject({ type: "LeaseRefused", reason: "terms" });
    dir = ack(dir, "credit1");
    expect(lease(dir, "credit1", ask()).ok).toBe(true);
    dir = value(reviseTerms(dir, "credit1", "r2", T + 1));
    expect(availability(conn(dir, "credit1"), T + 1, "r2")).toBe("terms");
    expect(problem(lease(dir, "credit1", ask({ revision: "r2", now: T + 1 })))).toBe("terms");
  });
  it("an engine-layer connection stays unarmed until the same acknowledgement", () => {
    let dir = value(addLayer(emptyDirectory(), {
      name: "layer-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "none", kind: "api-key",
    }, principal(), T));
    expect(availability(conn(dir, "layer-a"), T, "r1")).toBe("terms");
    dir = ack(dir, "layer-a");
    expect(availability(conn(dir, "layer-a"), T, "r1")).toBe("ready");
  });
  it("refuses a revision that has no source", () => {
    const dir = key(emptyDirectory());
    expect(problem(acknowledge(dir, "credit1", "unknown", "ada", principal(), T))).toBe("terms");
    expect(conn(dir, "credit1").terms).toBeNull();
  });
});

describe("CN5: the model has no secret field to hand to a provider", () => {
  it("nothing on a connection is named like a secret, a value, a plaintext, an api key or a token", () => {
    const c = conn(key(emptyDirectory()), "credit1");
    expect(Object.keys(c).join(" ")).not.toMatch(/secret|value|plaintext|apiKey|token/i);
  });
});

describe("CN6: isolation never goes below the floor, and a repo list means os", () => {
  it("refuses an isolation under the floor, and the gate refuses a runtime that cannot give what is required", () => {
    expect(problem(addSubscription(emptyDirectory(), {
      name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "none", floor: "rules", configDir: null,
    }, principal(), T))).toBe("floor");
    let dir = ack(key(emptyDirectory()), "credit1");
    expect(problem(setIsolation(dir, "credit1", "none", "rules", principal(), T))).toBe("floor");
    dir = value(setRepo(dir, "credit1", { allow: [], deny: ["host/secret-repo"] }, "rules", operator, T));
    expect(conn(dir, "credit1").isolation).toBe("os");
    expect(effectiveIsolation(conn(dir, "credit1"), "rules")).toBe("os");
    const c = conn(dir, "credit1");
    if (c.custody !== "morndo") throw new Error("custody");
    expect(problem(gate(c, ask({ runtime: { isolation: "rules", dialects: ["dialect-a"] }, floor: "rules" })))).toBe("isolation");
  });
});

describe("CN7: the repo list", () => {
  const rule = { allow: ["host/owner/ok"], deny: ["host/owner/no"] };
  it("allows everything when there is no list, and deny wins over allow", () => {
    expect(repoAdmits(null, ws("/work/x", ["host/owner/no"]))).toBe(true);
    expect(repoAdmits(rule, ws("/work/x", ["host/owner/ok", "host/owner/no"]))).toBe(false);
    expect(repoAdmits(rule, ws("/work/x", ["host/owner/ok"]))).toBe(true);
    expect(repoAdmits(rule, ws("/work/x", ["host/owner/other"]))).toBe(false);
    expect(repoAdmits({ allow: [], deny: ["/work/blocked"] }, ws("/work/blocked/child"))).toBe(false);
    expect(repoAdmits({ allow: ["host/*/ok"], deny: [] }, ws("/work/x", ["host/owner/ok"]))).toBe(true);
  });
  it("removing the list widens; adding a deny narrows", () => {
    expect(repoWidens(rule, null)).toBe(true);
    expect(repoWidens(rule, { allow: ["host/owner/ok"], deny: [] })).toBe(true);
    expect(repoWidens(null, rule)).toBe(false);
  });
});

describe("CN8: the gate refuses with the first failing reason, and the refusal is recorded", () => {
  it("checks status, terms, expiry, repo, isolation, dialect, lease count, then budget", () => {
    let dir = key(emptyDirectory(), "credit1", FP, { expiry: T + DAY });
    dir = value(turnOff(dir, "credit1", T));
    const off = lease(dir, "credit1", ask());
    expect(problem(off)).toBe("off");
    expect(off.ok ? null : off.error.directory?.events.at(-1)).toMatchObject({ type: "LeaseRefused", reason: "off" });
    dir = ack(key(emptyDirectory(), "credit1", FP, { expiry: T + DAY }), "credit1");
    const order: { over: Partial<LeaseAsk>; reason: string; prep?: (d: Directory) => Directory }[] = [
      { over: { revision: "other" }, reason: "terms" },
      { over: { now: T + DAY }, reason: "expired" },
      { over: { workspace: ws("/work/x", ["host/no"]) }, reason: "repo", prep: d => value(setRepo(d, "credit1", { allow: [], deny: ["host/no"] }, "rules", operator, T)) },
      { over: { runtime: { isolation: "none", dialects: ["dialect-a"] } }, reason: "isolation" },
      { over: { dialect: "other", runtime: { isolation: "os", dialects: ["dialect-a"] } }, reason: "dialect" },
    ];
    for (const step of order) {
      const ready = step.prep ? step.prep(dir) : dir;
      expect(problem(lease(ready, "credit1", ask(step.over))), step.reason).toBe(step.reason);
    }
    let capped = dir;
    capped = value(lease(capped, "credit1", ask()));
    capped = value(lease(capped, "credit1", ask({ holder: { ...holder, pid: 11 } })));
    expect(problem(lease(capped, "credit1", ask({ holder: { ...holder, pid: 12 } })))).toBe("leases");
    let ended = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 2 } }), "credit1");
    ended = value(lease(ended, "credit1", ask({ limit: 1, reserve: 2 })));
    ended = value(turnOff(ended, "credit1", T + 1));
    ended = value(refresh(ended, "credit1", "l1", T + 2, "r1", 0));
    ended = value(turnOn(ended, "credit1", principal(), T + 3));
    expect(availability(conn(ended, "credit1"), T + 4, "r1")).toBe("ready");
    expect(lease(ended, "credit1", ask({ limit: 1, reserve: 2, now: T + 4, holder: { ...holder, pid: 11 } })).ok).toBe(true);
    const poor = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 1 } }), "credit1");
    const spent = value(recordSpend(poor, "credit1", 1, "estimate", operator, T));
    expect(problem(lease(spent, "credit1", ask({ reserve: 1, margin: 0 })))).toBe("budget");
    expect(problem(lease(dir, "credit1", ask({ reserve: Number.NaN })))).toBe("budget");
    expect(problem(lease(dir, "credit1", ask({ margin: Number.POSITIVE_INFINITY })))).toBe("budget");
    const live = conn(dir, "credit1");
    if (!isKey(live)) throw new Error("key");
    expect(problem(gate({ ...live, spend: [{ at: T, amount: Number.NaN, source: "estimate" }] }, ask()))).toBe("budget");
    expect(LEASE_REFUSED).toBe(75);
  });
});

describe("CN9: the lease is recorded before use, and the helper serves only its holder", () => {
  it("grants a lease onto the directory before returning, and a call past the limit ends it", () => {
    let dir = ack(key(emptyDirectory()), "credit1");
    dir = value(lease(dir, "credit1", ask()));
    expect(dir.events.some(e => e.type === "LeaseGranted")).toBe(true);
    const id = dir.events.find(e => e.type === "LeaseGranted");
    if (id?.type !== "LeaseGranted") throw new Error("no grant");
    const open = conn(dir, "credit1");
    expect(isKey(open) && open.leases.map(l => l.id)).toEqual([id.lease]);
    dir = value(noteHelper(dir, "credit1", id.lease, holder, [holder], 2, 60_000, T));
    dir = value(noteHelper(dir, "credit1", id.lease, holder, [], 2, 60_000, T + 1));
    const ended = noteHelper(dir, "credit1", id.lease, holder, [], 2, 60_000, T + 2);
    const stopped = value(ended);
    expect(stopped.events.some(e => e.type === "LeaseClosed")).toBe(false);
    expect(stopped.events.at(-1)).toMatchObject({ type: "AuthorityEnded", lease: id.lease, reason: "helper_limit" });
    const stoppedKey = conn(stopped, "credit1");
    expect(isKey(stoppedKey) && stoppedKey.leases[0]?.authority).toBe("ended");
    expect(problem(noteHelper(stopped, "credit1", id.lease, holder, [], 2, 60_000, T + 3))).toBe("closed");
    const closed = value(closeLease(stopped, "credit1", id.lease, "done", 3.2, "estimate", operator, T + 4, 10));
    expect(closed.events.filter(e => e.type === "LeaseClosed")).toHaveLength(1);
    expect(closed.events.at(-1)).toMatchObject({ type: "LeaseClosed", amount: 3.2 });
    const stranger = ack(key(emptyDirectory()), "credit1");
    const granted = value(lease(stranger, "credit1", ask()));
    const leaseId = granted.events.at(-1);
    if (leaseId?.type !== "LeaseGranted") throw new Error("no grant");
    expect(problem(noteHelper(granted, "credit1", leaseId.lease, { pid: 99, startedAt: 1, bootId: "other" }, [], 2, 60_000, T))).toBe("helper");
  });
  it("a refresh leaves the helper-call window where it is", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "unlimited" } }), "credit1");
    dir = value(lease(dir, "credit1", ask()));
    dir = value(noteHelper(dir, "credit1", "l1", holder, [], 5, 60_000, T));
    dir = value(noteHelper(dir, "credit1", "l1", holder, [], 5, 60_000, T + 1));
    dir = value(refresh(dir, "credit1", "l1", T + 2, "r1", 0));
    dir = value(noteHelper(dir, "credit1", "l1", holder, [], 5, 60_000, T + 3));
    const c = conn(dir, "credit1");
    if (!isKey(c)) throw new Error("key");
    expect(c.leases[0]?.calls).toBe(3);
    expect(c.leases[0]?.windowStart).toBe(T);
  });
  it("serves a child of the holder and refuses a stranger who names itself as an ancestor", () => {
    let dir = ack(key(emptyDirectory()), "credit1");
    dir = value(lease(dir, "credit1", ask()));
    const id = dir.events.find(e => e.type === "LeaseGranted");
    if (id?.type !== "LeaseGranted") throw new Error("no grant");
    const child = { pid: 20, startedAt: 200, bootId: "boot" };
    expect(noteHelper(dir, "credit1", id.lease, child, [holder], 2, 60_000, T).ok).toBe(true);
    const stranger = { pid: 99, startedAt: 1, bootId: "other" };
    expect(problem(noteHelper(dir, "credit1", id.lease, stranger, [stranger], 2, 60_000, T))).toBe("helper");
  });
});

describe("a lease whose authority ended is still closed with its spend", () => {
  it("records the run after a refused refresh, the helper limit and revoke", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 5 } }), "credit1");
    dir = value(lease(dir, "credit1", ask({ reserve: 2 })));
    dir = value(turnOff(dir, "credit1", T + 1));
    const refused = value(refresh(dir, "credit1", "l1", T + 2, "r1", 0));
    expect(refused.events.at(-1)).toMatchObject({ type: "LeaseRefreshRefused", reason: "off" });
    const afterRefresh = value(closeLease(refused, "credit1", "l1", "done", 1.5, "estimate", operator, T + 3, 1000));
    const refreshed = conn(afterRefresh, "credit1");
    expect(isKey(refreshed) && spentOf(refreshed.spend)).toBe(1.5);

    let helped = ack(key(emptyDirectory(), "credit2", FP2, { budget: { kind: "unlimited" } }), "credit2");
    helped = value(lease(helped, "credit2", ask()));
    helped = value(noteHelper(helped, "credit2", "l1", holder, [], 1, 60_000, T));
    helped = value(noteHelper(helped, "credit2", "l1", holder, [], 1, 60_000, T + 1));
    expect(problem(noteHelper(helped, "credit2", "l1", holder, [], 1, 60_000, T + 2))).toBe("closed");
    const afterHelper = value(closeLease(helped, "credit2", "l1", "done", 0.4, "estimate", operator, T + 3, 10));
    const helperKey = conn(afterHelper, "credit2");
    expect(isKey(helperKey) && spentOf(helperKey.spend)).toBe(0.4);

    let running = ack(key(emptyDirectory()), "credit1");
    running = value(lease(running, "credit1", ask()));
    running = value(revoke(running, "credit1", principal(), T + 1));
    const afterRevoke = value(closeLease(running, "credit1", "l1", "done", 2, "estimate", operator, T + 2, 10));
    const revoked = conn(afterRevoke, "credit1");
    expect(isKey(revoked) && spentOf(revoked.spend)).toBe(2);
  });
  it("refuses to refresh a lease whose authority has ended", () => {
    let dir = ack(key(emptyDirectory()), "credit1");
    dir = value(lease(dir, "credit1", ask()));
    dir = value(turnOff(dir, "credit1", T + 1));
    dir = value(refresh(dir, "credit1", "l1", T + 2, "r1", 0));
    const again = refresh(dir, "credit1", "l1", T + 3, "r1", 0);
    expect(problem(again)).toBe("closed");
    expect(again.ok ? null : again.error.directory).toBeUndefined();
  });
});

describe("CN10: spend is append-only and an estimate never lowers it", () => {
  it("adds each run's figure, and a balance reading replaces what came before it", () => {
    expect(spentOf([
      { at: 1, amount: 8, source: "estimate" },
      { at: 2, amount: 0.5, source: "provider" },
    ])).toBe(8.5);
    expect(spentOf([{ at: 1, amount: 10, source: "provider" }, { at: 2, amount: 4, source: "manual" }])).toBe(14);
    expect(spentOf([
      { at: 1, amount: 3, source: "estimate" },
      { at: 2, amount: 9, source: "balance" },
      { at: 3, amount: 1, source: "estimate" },
    ])).toBe(10);
    let dir = key(emptyDirectory(), "credit1", FP, { budget: { kind: "unlimited" } });
    expect(problem(recordSpend(dir, "credit1", -1, "estimate", operator, T))).toBe("budget");
    expect(problem(recordSpend(dir, "credit1", Number.NaN, "estimate", operator, T))).toBe("budget");
    expect(problem(recordSpend(dir, "credit1", Number.POSITIVE_INFINITY, "manual", operator, T))).toBe("budget");
    const open = value(lease(ack(key(emptyDirectory(), "credit1", FP2, { budget: { kind: "unlimited" } })), "credit1", ask()));
    expect(problem(closeLease(open, "credit1", "l1", "done", Number.NaN, "estimate", operator, T, 1))).toBe("budget");
    const leased = conn(open, "credit1");
    if (!isKey(leased)) throw new Error("expected a key");
    expect(leased.leases).toHaveLength(1);
    dir = value(recordSpend(dir, "credit1", 10, "provider", operator, T));
    dir = value(recordSpend(dir, "credit1", 2, "estimate", operator, T + 1));
    expect(problem(recordSpend(dir, "credit1", -100, "manual", operator, T + 2))).toBe("principal");
    const lowered = value(recordSpend(dir, "credit1", -100, "manual", principal(), T + 2));
    const low = conn(lowered, "credit1");
    expect(isKey(low) && spentOf(low.spend)).toBe(-88);
    expect(problem(recordSpend(dir, "credit1", 1, "balance", operator, T + 3))).toBe("principal");
    const running = value(lease(ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 100 } })), "credit1", ask()));
    const spent = value(recordSpend(running, "credit1", 90, "estimate", operator, T));
    const blocked = closeLease(spent, "credit1", "l1", "done", 5, "balance", operator, T + 1, 10);
    expect(problem(blocked)).toBe("principal");
    const still = conn(spent, "credit1");
    if (!isKey(still)) throw new Error("expected a key");
    expect(spentOf(still.spend)).toBe(90);
    expect(still.leases).toHaveLength(1);
    const closed = value(closeLease(spent, "credit1", "l1", "done", 5, "balance", principal(), T + 1, 10));
    const closedKey = conn(closed, "credit1");
    expect(isKey(closedKey) && spentOf(closedKey.spend)).toBe(5);
    expect(closed.events.filter(e => e.type === "LeaseClosed")).toHaveLength(1);
    const c = conn(dir, "credit1");
    expect(isKey(c) && spentOf(c.spend)).toBe(12);
    expect(dir.events.map(e => e.type)).toEqual(["ConnectionAdded", "SpendReconciled", "SpendRecorded"]);
  });
});

describe("CN11: a reached budget grants nothing and refuses the next refresh", () => {
  it("stops a new lease and an open lease's refresh", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 5 } }), "credit1");
    dir = value(lease(dir, "credit1", ask({ reserve: 2, margin: 0 })));
    dir = value(recordSpend(dir, "credit1", 3, "estimate", operator, T + 1));
    const id = dir.events.find(e => e.type === "LeaseGranted");
    if (id?.type !== "LeaseGranted") throw new Error("no grant");
    expect(problem(lease(dir, "credit1", ask({ holder: { ...holder, pid: 11 } })))).toBe("budget");
    const kept = value(refresh(dir, "credit1", id.lease, T + 2, "r1", 0));
    expect(kept.events.at(-1)).toMatchObject({ type: "LeaseRefreshed" });
    const tight = value(refresh(dir, "credit1", id.lease, T + 3, "r1", 2));
    expect(tight.events.at(-1)).toMatchObject({ type: "LeaseRefreshRefused", reason: "budget" });
  });
  it("keeps a lease that was granted the whole remaining room", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 5 } }), "credit1");
    dir = value(lease(dir, "credit1", ask({ reserve: 5, margin: 0 })));
    const kept = value(refresh(dir, "credit1", "l1", T + 60_000, "r1", 0));
    expect(kept.events.at(-1)).toMatchObject({ type: "LeaseRefreshed" });
  });
});

describe("CN12: each threshold fires once", () => {
  it("warns at the budget fractions and the expiry leads, and not again", () => {
    let dir = key(emptyDirectory(), "credit1", FP, { expiry: T + 8 * DAY, budget: { kind: "capped", amount: 10 } });
    dir = value(recordSpend(dir, "credit1", 5, "estimate", operator, T));
    expect(dir.events.filter(e => e.type === "ThresholdCrossed").map(e => e.type === "ThresholdCrossed" ? e.threshold : "")).toEqual(["credit1:0.5"]);
    dir = value(recordSpend(dir, "credit1", 1, "estimate", operator, T + 1));
    expect(dir.events.filter(e => e.type === "ThresholdCrossed")).toHaveLength(1);
    dir = value(recordSpend(dir, "credit1", 0, "estimate", operator, T + DAY));
    const leads = dir.events.filter(e => e.type === "ThresholdCrossed" && e.threshold.includes("expiry"));
    expect(leads).toHaveLength(1);
    dir = value(recordSpend(dir, "credit1", 0, "estimate", operator, T + DAY + 1));
    expect(dir.events.filter(e => e.type === "ThresholdCrossed" && e.threshold.includes("expiry"))).toHaveLength(1);
  });
  it("counts spend only, and a check warns an idle key", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 10 } }), "credit1");
    dir = value(lease(dir, "credit1", ask({ reserve: 9.6, margin: 0 })));
    expect(dir.events.filter(e => e.type === "ThresholdCrossed")).toEqual([]);
    dir = value(recordSpend(dir, "credit1", 6.1, "estimate", operator, T + 1));
    expect(dir.events.flatMap(e => e.type === "ThresholdCrossed" ? [e.threshold] : [])).toEqual(["credit1:0.5"]);
    const idle = check(key(emptyDirectory(), "prepaid", FP2, { expiry: T + 6 * DAY, billing: "prepaid" }), T);
    expect(idle.events.flatMap(e => e.type === "ThresholdCrossed" ? [e.threshold] : [])).toEqual([`prepaid:expiry:${7 * DAY}`]);
  });
  it("warns again after the expiry moves later", () => {
    let dir = key(emptyDirectory(), "credit1", FP, { expiry: T + 6 * DAY });
    dir = check(dir, T);
    const lead = `credit1:expiry:${7 * DAY}`;
    dir = value(setExpiry(dir, "credit1", T + 40 * DAY, principal(), T));
    dir = check(dir, T + 34 * DAY);
    expect(dir.events.filter(e => e.type === "ThresholdCrossed" && e.threshold === lead)).toHaveLength(2);
  });
  it("warns again after the budget widens or spend falls below the fraction", () => {
    let dir = key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 100 } });
    dir = value(recordSpend(dir, "credit1", 60, "estimate", operator, T));
    dir = value(setBudget(dir, "credit1", { kind: "capped", amount: 1000 }, principal(), T));
    const widened = conn(dir, "credit1");
    expect(isKey(widened) && widened.warned.includes("credit1:0.5")).toBe(false);
    dir = value(recordSpend(dir, "credit1", 440, "estimate", operator, T + 1));
    expect(dir.events.filter(e => e.type === "ThresholdCrossed" && e.threshold === "credit1:0.5")).toHaveLength(2);
    let again = key(emptyDirectory(), "credit2", FP2, { budget: { kind: "capped", amount: 100 } });
    again = value(recordSpend(again, "credit2", 60, "estimate", operator, T));
    again = value(recordSpend(again, "credit2", 5, "balance", principal(), T + 1));
    const dropped = conn(again, "credit2");
    expect(isKey(dropped) && dropped.warned.includes("credit2:0.5")).toBe(false);
    again = value(recordSpend(again, "credit2", 50, "estimate", operator, T + 2));
    expect(again.events.filter(e => e.type === "ThresholdCrossed" && e.threshold === "credit2:0.5")).toHaveLength(2);
  });
});

describe("CN13: narrowing is anyone's; widening and revocation are the principal's", () => {
  it("judges widening by effect", () => {
    let dir = ack(key(emptyDirectory()), "credit1");
    expect(turnOff(dir, "credit1", T).ok).toBe(true);
    dir = value(turnOff(dir, "credit1", T));
    expect(problem(turnOn(dir, "credit1", operator, T))).toBe("principal");
    expect(turnOn(dir, "credit1", principal(), T).ok).toBe(true);
    expect(problem(setBudget(dir, "credit1", { kind: "unlimited" }, operator, T))).toBe("principal");
    expect(problem(setBudget(dir, "credit1", { kind: "capped", amount: Number.NaN }, principal(), T))).toBe("budget");
    expect(problem(setExpiry(dir, "credit1", Number.POSITIVE_INFINITY, principal(), T))).toBe("expiry");
    expect(setBudget(dir, "credit1", { kind: "capped", amount: 4 }, operator, T).ok).toBe(true);
    dir = value(setRepo(dir, "credit1", { allow: ["host/a"], deny: ["host/b"] }, "rules", principal(), T));
    expect(problem(setRepo(dir, "credit1", { allow: ["host/a", "host/c"], deny: ["host/b"] }, "rules", operator, T))).toBe("principal");
    expect(problem(setRepo(dir, "credit1", { allow: [], deny: ["host/b"] }, "rules", operator, T))).toBe("principal");
    expect(repoAdmits({ allow: ["host/a"], deny: ["host/b"] }, ws("/work/c", ["host/c"]))).toBe(false);
    const opened = value(setRepo(dir, "credit1", { allow: [], deny: ["host/b"] }, "rules", principal(), T));
    const openedConn = conn(opened, "credit1");
    expect(repoAdmits(openedConn.repo, ws("/work/c", ["host/c"]))).toBe(true);
    expect(setRepo(dir, "credit1", { allow: ["host/a"], deny: ["host/b", "host/d"] }, "os", operator, T).ok).toBe(true);
    expect(problem(setIsolation(dir, "credit1", "rules", "rules", operator, T))).toBe("floor");
    const raised = value(setIsolation(ack(key(emptyDirectory())), "credit1", "os", "rules", operator, T));
    expect(problem(setIsolation(raised, "credit1", "rules", "rules", operator, T))).toBe("principal");
    expect(problem(revoke(dir, "credit1", operator, T))).toBe("principal");
  });
});

describe("CN14: off and revoke stop leases; revoke never turns back on", () => {
  it("refuses a new lease at once and an open one at the next refresh", () => {
    let dir = ack(key(emptyDirectory()), "credit1");
    dir = value(lease(dir, "credit1", ask()));
    const id = dir.events.find(e => e.type === "LeaseGranted");
    if (id?.type !== "LeaseGranted") throw new Error("no grant");
    dir = value(turnOff(dir, "credit1", T + 1));
    expect(problem(lease(dir, "credit1", ask({ now: T + 1, holder: { ...holder, pid: 11 } })))).toBe("off");
    expect(value(refresh(dir, "credit1", id.lease, T + 2, "r1", 0)).events.at(-1)).toMatchObject({ type: "LeaseRefreshRefused", reason: "off" });
    dir = value(turnOn(dir, "credit1", principal(), T + 3));
    dir = value(revoke(dir, "credit1", principal("c2"), T + 4));
    expect(problem(turnOn(dir, "credit1", principal("c3"), T + 5))).toBe("revoked");
    expect(availability(conn(dir, "credit1"), T + 5, "r1")).toBe("revoked");
  });
});

describe("CN15: a connection grants nothing", () => {
  it("spend changes the gate and nothing else, and a lease is not a status", () => {
    let dir = ack(key(emptyDirectory(), "credit1", FP, { budget: { kind: "capped", amount: 2 } }), "credit1");
    dir = value(recordSpend(dir, "credit1", 2, "manual", operator, T));
    expect(conn(dir, "credit1").status).toBe("on");
    expect(availability(conn(dir, "credit1"), T, "r1")).toBe("budget");
    dir = value(lease(ack(key(emptyDirectory())), "credit1", ask()));
    const c = conn(dir, "credit1");
    expect(c.status).toBe("on");
    expect("mandate" in c).toBe(false);
    const closed = value(closeLease(dir, "credit1", "l1", "done", 0, "estimate", operator, T + 1, 1000));
    expect(closed.events.at(-1)).toMatchObject({ type: "LeaseClosed", duration: 1000 });
    expect(loseLease(value(lease(ack(key(emptyDirectory())), "credit1", ask())), "credit1", "l1", T).ok).toBe(true);
  });
});

describe("isolation ranks", () => {
  const floors: Isolation[] = ["none", "rules", "os"];
  it("effective isolation is the strongest of the stored value, the floor and a repo list", () => {
    const dir = key(emptyDirectory());
    expect(floors.map(f => effectiveIsolation(conn(dir, "credit1"), f))).toEqual(["rules", "rules", "os"]);
  });
});
