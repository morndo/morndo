// A key pool in the routing policy (ADR-0037, slice 2): the pool's name takes its members' place in the Priority and the picks, and
// gives it back when a member leaves or the pool goes. Pure, idempotent, and the same derivation as for a Connection.
import { describe, expect, it } from "vitest";
import {
  chainText, deriveChain, emptyPolicy, engineText, foldPool, parseEngine, roleOrder, unfoldPool, withPools,
  type Engine, type Listed, type Policy, type RoleRoute,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const e = (text: string): Engine => {
  const parsed = parseEngine(text);
  if (!parsed) throw new Error(`bad engine ${text}`);
  return parsed;
};
const role = (name: string, picks: string[], over: Partial<RoleRoute> = {}): RoleRoute => ({
  role: name, override: "follow", priority: null, picks: picks.map(e), riskPicks: null, written: null, writtenRisk: null, seenChain: null, seenRisk: null, ...over,
});
const policy = (order: string[], roles: RoleRoute[] = []): Policy => ({ ...emptyPolicy(), priority: { mode: "keys-first", order }, roles });
const listed: Listed[] = ["k1", "k2", "k3", "p", "sub"].map(name => ({ name, kind: name === "sub" ? "subscription" as const : "api-key" as const, models: ["m"], efforts: null }));
const order = (p: Policy) => p.priority.order;
const picksOf = (p: Policy, name: string) => p.roles.find(r => r.role === name)?.picks.map(engineText) ?? [];

describe("foldPool: the pool's name replaces its members", () => {
  it("puts the pool at the first member's place in the order and drops the other members", () => {
    expect(order(foldPool(policy(["sub", "k1", "x", "k2", "k3"]), "p", ["k1", "k2", "k3"], T))).toEqual(["sub", "p", "x"]);
  });
  it("appends the pool when none of its members is in the order yet", () => {
    expect(order(foldPool(policy(["sub"]), "p", ["k1"], T))).toEqual(["sub", "p"]);
  });
  it("renames the members' picks to the pool's, keeps the model and effort, and drops a pick that is then a copy", () => {
    const next = foldPool(policy(["k1", "k2"], [role("implement", ["k1:m@high", "sub:m", "k2:m@high", "k2:m"])]), "p", ["k1", "k2"], T);
    expect(picksOf(next, "implement")).toEqual(["p:m@high", "sub:m", "p:m"]);
  });
  it("folds the order of a role with its own order and its risk picks too", () => {
    const own = role("review", ["k1:m"], { override: "own", priority: { mode: "custom", order: ["k2", "sub", "k1"] }, riskPicks: [e("k2:m")] });
    const next = foldPool(policy(["k1", "k2"], [own]), "p", ["k1", "k2"], T);
    const row = next.roles[0];
    expect(row?.priority?.order).toEqual(["p", "sub"]);
    expect(row?.riskPicks?.map(engineText)).toEqual(["p:m"]);
  });
  it("is idempotent, and says nothing when nothing changes", () => {
    const once = foldPool(policy(["k1", "k2"], [role("implement", ["k1:m"])]), "p", ["k1", "k2"], T);
    expect(foldPool(once, "p", ["k1", "k2"], T + 1)).toBe(once);
  });
  it("a member that joins later is folded into the pool that is already there", () => {
    const once = foldPool(policy(["k1", "k2", "k3"]), "p", ["k1", "k2"], T);
    expect(order(once)).toEqual(["p", "k3"]);
    expect(order(foldPool(once, "p", ["k1", "k2", "k3"], T + 1))).toEqual(["p"]);
  });
  it("the derived chain of a role follows the pool's place in the order (R10)", () => {
    const next = foldPool(policy(["sub", "k1", "k2"], [role("implement", ["sub:m", "k1:m", "k2:m"])]), "p", ["k1", "k2"], T);
    const row = next.roles[0] as RoleRoute;
    const known = listed.map(l => ({ name: l.name, kind: l.kind }));
    expect(chainText(deriveChain(row.picks, roleOrder(next, row, known), false))).toEqual(["p:m", "sub:m"]);
  });
});

describe("unfoldPool: a member that leaves, or the whole pool, comes back as a Connection", () => {
  const folded = () => foldPool(policy(["sub", "k1", "k2", "k3"], [role("implement", ["sub:m", "k1:m@high"])]), "p", ["k1", "k2", "k3"], T);
  it("when others remain, the member goes into the order right after the pool and takes the pool's picks' models", () => {
    const next = unfoldPool(folded(), "p", ["k2"], ["k1", "k3"], listed, T + 1);
    expect(order(next)).toEqual(["sub", "p", "k2"]);
    expect(picksOf(next, "implement")).toEqual(["sub:m", "p:m@high", "k2:m@high"]);
  });
  it("when the pool goes, its members take its place in the order and in the picks, in the order given", () => {
    const next = unfoldPool(folded(), "p", ["k1", "k2", "k3"], [], listed, T + 1);
    expect(order(next)).toEqual(["sub", "k1", "k2", "k3"]);
    expect(picksOf(next, "implement")).toEqual(["sub:m", "k1:m@high", "k2:m@high", "k3:m@high"]);
  });
  it("a member that does not list the model gets no pick, and a pool with no member left drops out of the order and the picks", () => {
    const thin = listed.map(l => l.name === "k2" ? { ...l, models: ["other"] } : l);
    const next = unfoldPool(folded(), "p", ["k1", "k2"], [], thin, T + 1);
    expect(picksOf(next, "implement")).toEqual(["sub:m", "k1:m@high"]);
    const none = unfoldPool(folded(), "p", [], [], listed, T + 1);
    expect(order(none)).toEqual(["sub"]);
    expect(picksOf(none, "implement")).toEqual(["sub:m"]);
  });
  it("is the same policy when the pool is not named anywhere", () => {
    const plain = policy(["sub", "k1"]);
    expect(unfoldPool(plain, "p", ["k1"], [], listed, T)).toBe(plain);
  });
});

describe("withPools: a saved order that left a pool out keeps it", () => {
  it("puts the pool back before the entry that followed it, or at the end", () => {
    expect(withPools(["sub", "x"], ["sub", "p", "x"], ["p"])).toEqual(["sub", "p", "x"]);
    expect(withPools(["sub"], ["sub", "p"], ["p"])).toEqual(["sub", "p"]);
    expect(withPools(["x", "sub"], ["p", "sub", "x"], ["p"])).toEqual(["x", "p", "sub"]);
  });
  it("leaves an order that has the pool, and a pool that was not in the current order, as they are", () => {
    expect(withPools(["p", "sub"], ["sub", "p"], ["p"])).toEqual(["p", "sub"]);
    expect(withPools(["sub"], ["sub"], ["p"])).toEqual(["sub"]);
  });
});
