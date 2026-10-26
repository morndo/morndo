// A pooled helper's hand-off at the Connections level (ADR-0037; KP17, KP19): the old lease closes and the new one is granted in one
// directory, the new lease takes over the helper window, and a refusal leaves the old lease as it was. `now` is the clock.
import { describe, expect, it } from "vitest";
import {
  acknowledge, addKey, closeLease, emptyDirectory, findConnection, isKey, lease, nextHelperWindow, noteHelper, swapLease, turnOff,
  type Actor, type Directory, type Holder, type LeaseAsk,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const SEC = 1_000;
const principal: Actor = { kind: "principal", command: "c1" };
const holder: Holder = { node: "n1", pid: 10, startedAt: 100, bootId: "boot", lane: "lane-a" };

const value = <V>(r: { ok: true; value: V } | { ok: false; error: { problem: string } }): V => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

function keys(budgets: Record<string, number | null> = { k1: 10, k2: 10 }): Directory {
  let dir = emptyDirectory();
  let n = 0;
  for (const [name, amount] of Object.entries(budgets)) {
    n += 1;
    dir = value(addKey(dir, {
      name, vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules", ref: `ref-${name}`,
      fingerprint: `0123456789a${n}`, billing: "metered", budget: amount === null ? { kind: "unlimited" } : { kind: "capped", amount }, expiry: null,
    }, principal, T));
    dir = value(acknowledge(dir, name, "r1", "ada", principal, T));
  }
  return dir;
}
function ask(over: Partial<LeaseAsk> = {}): LeaseAsk {
  return {
    now: T, revision: "r1", workspace: { path: "/work/repo", remotes: [] }, dialect: "dialect-a",
    runtime: { isolation: "rules", dialects: ["dialect-a"] }, floor: "rules", limit: 8, reserve: 2, margin: 0, probe: false,
    holder, role: "run", entry: "m", runtimeName: "runtime-a", ...over,
  };
}
const leases = (dir: Directory, name: string) => {
  const c = findConnection(dir, name);
  if (!c || !isKey(c)) throw new Error(`no key ${name}`);
  return c.leases;
};
// k1 holds a live lease l1 whose helper has been called 3 times, the window starting at T.
function running(): { dir: Directory; id: string } {
  let dir = value(lease(keys(), "k1", ask()));
  const id = leases(dir, "k1")[0]?.id ?? "";
  const ancestors = [{ pid: holder.pid, startedAt: holder.startedAt, bootId: holder.bootId }];
  for (let i = 0; i < 3; i++) dir = value(noteHelper(dir, "k1", id, ancestors[0]!, ancestors, 4, 60 * SEC, T + i * SEC));
  return { dir, id };
}

describe("nextHelperWindow counts a call the way noteHelper does", () => {
  it("counts inside the window, starts a new one after it, and says when the cap is passed", () => {
    expect(nextHelperWindow({ calls: 3, windowStart: T }, 4, 60 * SEC, T + 5 * SEC)).toEqual({ calls: 4, windowStart: T, over: false });
    expect(nextHelperWindow({ calls: 4, windowStart: T }, 4, 60 * SEC, T + 5 * SEC)).toEqual({ calls: 5, windowStart: T, over: true });
    expect(nextHelperWindow({ calls: 4, windowStart: T }, 4, 60 * SEC, T + 60 * SEC)).toEqual({ calls: 1, windowStart: T + 60 * SEC, over: false });
  });
});

describe("kp19 swapLease: the old lease closed and the new one granted in one directory, or neither", () => {
  it("closes the old lease as a hand-off, charges its reservation, grants the new one and keeps one live lease", () => {
    const { dir, id } = running();
    const next = value(swapLease(dir, "k2", ask({ now: T + 10 * SEC }), { connection: "k1", lease: id }, { calls: 4, windowStart: T }));
    expect(leases(next, "k1")).toHaveLength(0);
    const fresh = leases(next, "k2");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.authority).toBe("live");
    const closed = next.events.find(e => e.type === "LeaseClosed" && e.lease === id);
    expect(closed).toMatchObject({ type: "LeaseClosed", name: "k1", outcome: "handoff", amount: 2, source: "estimate", duration: 10 * SEC });
    expect(next.events.filter(e => e.type === "LeaseGranted")).toHaveLength(2);
    const k1 = findConnection(next, "k1");
    expect(k1 && isKey(k1) ? k1.spend.at(-1) : null).toMatchObject({ amount: 2, source: "estimate" });
  });

  it("a gate refusal of the new member leaves the old lease live and records the refusal", () => {
    const { dir, id } = running();
    const off = value(turnOff(dir, "k2", T));
    const refused = swapLease(off, "k2", ask(), { connection: "k1", lease: id }, { calls: 4, windowStart: T });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.problem).toBe("off");
    const kept = refused.error.directory;
    expect(kept && leases(kept, "k1").map(l => l.id)).toEqual([id]);
    expect(kept && leases(kept, "k2")).toHaveLength(0);
    expect(kept?.events.at(-1)).toMatchObject({ type: "LeaseRefused", name: "k2", reason: "off" });
  });

  it("an old lease that is not there refuses with nothing to save", () => {
    const { dir } = running();
    const refused = swapLease(dir, "k2", ask(), { connection: "k1", lease: "l99" }, { calls: 1, windowStart: T });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.problem).toBe("closed");
    expect(refused.error.directory).toBeUndefined();
  });

  it("with no old lease it grants the new one alone (the grant's lease was swept)", () => {
    const next = value(swapLease(keys(), "k2", ask(), null, { calls: 2, windowStart: T - 5 * SEC }));
    expect(leases(next, "k2")).toHaveLength(1);
    expect(next.events.filter(e => e.type === "LeaseClosed")).toHaveLength(0);
  });
});

describe("fix round 1: a lease with no old one to close is granted only when the holder has none already on the pool", () => {
  const alone = { holder, members: ["k1", "k2"] };
  it("refuses with held, and nothing to save, when the holder already has a live lease on a member", () => {
    const { dir } = running();
    const refused = swapLease(dir, "k2", ask(), null, { calls: 1, windowStart: T }, alone);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.problem).toBe("held");
    expect(refused.error.directory).toBeUndefined();
  });
  it("grants when the holder has none, when the lease it has is another holder's, or when its authority has ended", () => {
    expect(swapLease(keys(), "k2", ask(), null, { calls: 1, windowStart: T }, alone).ok).toBe(true);
    const { dir } = running();
    const other = { ...alone, holder: { ...holder, pid: 99 } };
    expect(swapLease(dir, "k2", ask(), null, { calls: 1, windowStart: T }, other).ok).toBe(true);
    const ancestors = [{ pid: holder.pid, startedAt: holder.startedAt, bootId: holder.bootId }];
    const id = leases(dir, "k1")[0]?.id ?? "";
    const ended = value(noteHelper(dir, "k1", id, ancestors[0]!, ancestors, 3, 60 * SEC, T + 5 * SEC));
    expect(leases(ended, "k1")[0]?.authority).toBe("ended");
    expect(swapLease(ended, "k2", ask(), null, { calls: 1, windowStart: T }, alone).ok).toBe(true);
  });
  it("is not asked of a swap that closes an old lease: that one is serialised by the old lease", () => {
    const { dir, id } = running();
    expect(swapLease(dir, "k2", ask(), { connection: "k1", lease: id }, { calls: 4, windowStart: T }, alone).ok).toBe(true);
  });
});

describe("kp17 the new lease keeps the call count and the window start", () => {
  it("a swap does not reset the cap: the next call in the window is over it", () => {
    const { dir, id } = running();
    const next = value(swapLease(dir, "k2", ask({ now: T + 10 * SEC }), { connection: "k1", lease: id }, { calls: 4, windowStart: T }));
    const fresh = leases(next, "k2")[0];
    expect(fresh).toMatchObject({ calls: 4, windowStart: T, authority: "live" });
    const ancestors = [{ pid: holder.pid, startedAt: holder.startedAt, bootId: holder.bootId }];
    const noted = value(noteHelper(next, "k2", fresh?.id ?? "", ancestors[0]!, ancestors, 4, 60 * SEC, T + 11 * SEC));
    expect(leases(noted, "k2")[0]?.authority).toBe("ended");
    expect(noted.events.at(-1)).toMatchObject({ type: "AuthorityEnded", name: "k2", reason: "helper_limit" });
  });

  it("a window that has lapsed starts again", () => {
    const { dir, id } = running();
    const next = value(swapLease(dir, "k2", ask({ now: T + 90 * SEC }), { connection: "k1", lease: id }, nextHelperWindow({ calls: 3, windowStart: T }, 4, 60 * SEC, T + 90 * SEC)));
    expect(leases(next, "k2")[0]).toMatchObject({ calls: 1, windowStart: T + 90 * SEC });
  });
});

describe("closing a lease after a swap is still the ordinary close", () => {
  it("the new lease closes with the run's cost like any lease", () => {
    const { dir, id } = running();
    const next = value(swapLease(dir, "k2", ask(), { connection: "k1", lease: id }, { calls: 4, windowStart: T }));
    const fresh = leases(next, "k2")[0]?.id ?? "";
    const done = value(closeLease(next, "k2", fresh, "done", 1.5, "estimate", { kind: "operator" }, T + 20 * SEC, 20 * SEC));
    expect(leases(done, "k2")).toHaveLength(0);
  });
});
