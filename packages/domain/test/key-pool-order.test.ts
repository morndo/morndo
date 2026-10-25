// The order `chooseKey` walks. Nothing is saved: a failing member yields no one, and an exhausted member is skipped.
import { describe, expect, it } from "vitest";
import {
  addKey, chooseKey, createKeyPool, joinKeyPool, reportKeyOutcome, servableOrder,
  type Actor, type Directory, type KeyPool, type Outcome,
  emptyDirectory, findConnection,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const principal = (command = "c1"): Actor => ({ kind: "principal", command });

function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}

function keys(n: number): Directory {
  let dir = emptyDirectory();
  for (let i = 1; i <= n; i++) {
    dir = ok(addKey(dir, {
      name: `k${i}`, vendor: "v", runtime: "r", isolation: "rules", floor: "rules",
      ref: `ref-k${i}`, fingerprint: `0123456789a${i}`, billing: "metered", budget: { kind: "unlimited" }, expiry: null,
    }, principal(), T));
  }
  return dir;
}

function pool(n: number, mode: "round-robin" | "drain" = "round-robin"): KeyPool {
  const dir = keys(n);
  let p = ok(createKeyPool(
    { name: "p", runtime: "r", vendor: "v", policy: { mode, recheckEveryMs: DAY } },
    { connections: dir.connections.map(c => c.name), pools: [], deleted: [] }, principal(), T,
  ));
  for (let i = 1; i <= n; i++) {
    const connection = findConnection(dir, `k${i}`);
    if (!connection) throw new Error(`no k${i}`);
    p = ok(joinKeyPool(p, connection, { elsewhere: [] }, null, true, principal(), T));
  }
  return p;
}

const exhausted = (): Outcome => ({ kind: "exhausted", reason: "credit", resumeAt: null });

describe("servableOrder", () => {
  it("starts after the last pick and skips a member that is not active", () => {
    let p = pool(3);
    expect(servableOrder(p)).toEqual(["k1", "k2", "k3"]);
    expect(servableOrder(p)[0]).toBe(ok(chooseKey(p)).member);
    p = ok(chooseKey(p)).pool;
    expect(servableOrder(p)).toEqual(["k2", "k3", "k1"]);
    p = ok(reportKeyOutcome(p, "k2", exhausted(), T, T));
    expect(servableOrder(p)).toEqual(["k3", "k1"]);
    expect(servableOrder(p)[0]).toBe(ok(chooseKey(p)).member);
  });

  it("drain starts at the member already serving", () => {
    const serving = ok(chooseKey(pool(3, "drain"))).pool;
    expect(serving.lastPick).toBe("k1");
    expect(servableOrder(serving)).toEqual(["k1", "k2", "k3"]);
    expect(servableOrder(serving)[0]).toBe(ok(chooseKey(serving)).member);
  });

  it("a failing member leaves no order", () => {
    const blocked = ok(reportKeyOutcome(pool(2), "k1", { kind: "failing", reason: "rejected" }, T, T));
    expect(servableOrder(blocked)).toEqual([]);
    const refused = chooseKey(blocked);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.problem).toBe("pool_blocked");
  });
});
