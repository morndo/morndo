// Grants of a pooled `run` (ADR-0037; KP8, KP12, KP17, KP18): a grant names the member a run is on and the lease it holds, moves when the
// helper hands the run to another member, and tells a report which member's key may have been in use. One history per rule.
import { describe, expect, it } from "vitest";
import {
  addKey, bindFilter, closeGrant, createKeyPool, emptyDirectory, findConnection, attributeToGrant, joinKeyPool, leaveKeyPool, moveGrant, openGrant,
  noteLent, noteSeen, touchGrant,
  type Actor, type Connection, type Grant, type KeyPool,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const SEC = 1_000;
const TTL = 60 * SEC;
const principal: Actor = { kind: "principal", command: "c1" };
const PLANTED_FP = "feedfacecafe";

function ok<V>(r: { ok: true; value: V } | { ok: false; error: unknown }): V {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}
const word = (r: { ok: boolean; error?: unknown }): string => (r.ok ? "ok" : String(r.error));

function pool(n = 3): KeyPool {
  let dir = emptyDirectory();
  for (let i = 1; i <= n; i++) {
    dir = ok(addKey(dir, {
      name: `k${i}`, vendor: "v", runtime: "r", isolation: "rules", floor: "rules", ref: `ref-k${i}`,
      fingerprint: i === 1 ? PLANTED_FP : `0123456789a${i}`, billing: "metered", budget: { kind: "unlimited" }, expiry: null,
    }, principal, T));
  }
  let p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, { connections: dir.connections.map(c => c.name), pools: [], deleted: [] }, principal, T));
  for (let i = 1; i <= n; i++) {
    const c = findConnection(dir, `k${i}`) as Connection;
    p = ok(joinKeyPool(p, c, { elsewhere: [] }, null, true, principal, T));
  }
  return p;
}
const grant = (over: Partial<Grant> = {}): Grant => ({
  id: "gl1", member: "k1", lease: "l1", holder: { node: "n1", pid: 10, startedAt: 100, bootId: "boot", lane: "lane-a" },
  request: { role: "run", entry: "m", workspacePath: "/work/repo", limit: 8, reserve: 2, margin: 0 },
  window: { calls: 1, windowStart: T }, previous: null, seen: [], lent: [], filter: null, ...over,
});
const moved = (p: KeyPool, at: number, to = "k2", lease = "l2") =>
  ok(moveGrant(p, "gl1", { member: to, lease, window: { calls: 2, windowStart: T }, movedAt: at }, "exhausted", at));

describe("a pool starts with no grants and opens one for a member it has", () => {
  it("openGrant adds the grant and one GrantOpened with the grant id and the member's name only", () => {
    const p = ok(openGrant(pool(), grant(), T + SEC));
    expect(p.grants).toEqual([grant()]);
    expect(p.events.at(-1)).toEqual({ type: "GrantOpened", grant: "gl1", member: "k1", at: T + SEC });
  });
  it("refuses a member the pool does not have and a grant id it already has", () => {
    expect(word(openGrant(pool(), grant({ member: "zz" }), T))).toBe("missing");
    const p = ok(openGrant(pool(), grant(), T));
    expect(word(openGrant(p, grant({ lease: "l9" }), T))).toBe("exists");
  });
  it("createKeyPool starts with grants: []", () => {
    expect(pool().grants).toEqual([]);
  });
});

describe("moveGrant", () => {
  it("names the new member, lease and window, keeps the old member as previous with the time it moved, and raises GrantMoved", () => {
    const p = moved(ok(openGrant(pool(), grant(), T)), T + 10 * SEC);
    expect(p.grants[0]).toMatchObject({ member: "k2", lease: "l2", window: { calls: 2, windowStart: T }, previous: { member: "k1", movedAt: T + 10 * SEC } });
    expect(p.events.at(-1)).toEqual({ type: "GrantMoved", grant: "gl1", from: "k1", to: "k2", why: "exhausted", at: T + 10 * SEC });
  });
  it("to the lease the grant already names changes nothing and raises nothing (a second saver after an adoption)", () => {
    const once = moved(ok(openGrant(pool(), grant(), T)), T + 10 * SEC);
    const again = ok(moveGrant(once, "gl1", { member: "k2", lease: "l2", window: { calls: 2, windowStart: T }, movedAt: T + 11 * SEC }, "adopted", T + 11 * SEC));
    expect(again).toBe(once);
  });
  it("on the same member (a new lease after a sweep) keeps previous as it was", () => {
    const once = moved(ok(openGrant(pool(), grant(), T)), T + 10 * SEC);
    const next = ok(moveGrant(once, "gl1", { member: "k2", lease: "l3", window: { calls: 3, windowStart: T }, movedAt: T + 20 * SEC }, "reopened", T + 20 * SEC));
    expect(next.grants[0]).toMatchObject({ member: "k2", lease: "l3", previous: { member: "k1", movedAt: T + 10 * SEC } });
  });
  it("refuses a grant or a member that is not there", () => {
    const p = ok(openGrant(pool(), grant(), T));
    expect(word(moveGrant(p, "nope", { member: "k2", lease: "l2", window: { calls: 1, windowStart: T }, movedAt: T }, "exhausted", T))).toBe("missing");
    expect(word(moveGrant(p, "gl1", { member: "zz", lease: "l2", window: { calls: 1, windowStart: T }, movedAt: T }, "exhausted", T))).toBe("no_member");
  });
});

describe("touchGrant and closeGrant", () => {
  it("touchGrant records the window of the last helper call, raises nothing, and is the same pool when nothing changed", () => {
    const p = ok(openGrant(pool(), grant(), T));
    const touched = touchGrant(p, "gl1", { calls: 3, windowStart: T });
    expect(touched.grants[0]?.window).toEqual({ calls: 3, windowStart: T });
    expect(touched.events).toEqual(p.events);
    expect(touchGrant(touched, "gl1", { calls: 3, windowStart: T })).toBe(touched);
    expect(touchGrant(p, "nope", { calls: 3, windowStart: T })).toBe(p);
  });
  it("closeGrant removes it with one GrantClosed, and a grant that is gone is no change", () => {
    const p = closeGrant(ok(openGrant(pool(), grant(), T)), "gl1", T + SEC);
    expect(p.grants).toEqual([]);
    expect(p.events.at(-1)).toEqual({ type: "GrantClosed", grant: "gl1", at: T + SEC });
    expect(closeGrant(p, "gl1", T + 2 * SEC)).toBe(p);
  });
});

describe("kp18 a report right after a hand-off belongs to the member the old key came from", () => {
  const open = () => moved(ok(openGrant(pool(), grant(), T)), T + 10 * SEC);
  it("inside the window it is the previous member's", () => {
    const hit = ok(attributeToGrant(open(), "gl1", T + 10 * SEC + 30 * SEC, TTL));
    expect(hit.member).toBe("k1");
  });
  it("at the edge of the window and after it, it is the current member's, and previous is cleared", () => {
    const edge = ok(attributeToGrant(open(), "gl1", T + 10 * SEC + TTL, TTL));
    expect(edge.member).toBe("k2");
    expect(edge.pool.grants[0]?.previous).toBeNull();
    expect(ok(attributeToGrant(edge.pool, "gl1", T + 20 * SEC + TTL, TTL)).pool).toBe(edge.pool);
  });
  it("a grant that never moved is its member's, and a grant that is not there is refused", () => {
    expect(ok(attributeToGrant(ok(openGrant(pool(), grant(), T)), "gl1", T + SEC, TTL)).member).toBe("k1");
    expect(word(attributeToGrant(pool(), "nope", T, TTL))).toBe("missing");
  });
});

describe("kp18 fix round 1: a report from a session the grant has seen is that session's key's", () => {
  const open = () => moved(ok(openGrant(pool(), grant(), T)), T + 10 * SEC);
  it("noteSeen records which member a session was last served, replaces it, and says nothing when it did not change", () => {
    const p = noteSeen(ok(openGrant(pool(), grant(), T)), "gl1", "20:1:boot", "k1");
    expect(p.grants[0]?.seen).toEqual([{ session: "20:1:boot", member: "k1" }]);
    expect(noteSeen(p, "gl1", "20:1:boot", "k1")).toBe(p);
    const later = noteSeen(p, "gl1", "20:1:boot", "k2");
    expect(later.grants[0]?.seen).toEqual([{ session: "20:1:boot", member: "k2" }]);
    expect(noteSeen(p, "nope", "20:1:boot", "k2")).toBe(p);
  });
  it("keeps the last sixteen sessions", () => {
    let p = ok(openGrant(pool(), grant(), T));
    for (let i = 0; i < 20; i++) p = noteSeen(p, "gl1", `s${i}`, "k1");
    expect(p.grants[0]?.seen).toHaveLength(16);
    expect(p.grants[0]?.seen[0]?.session).toBe("s4");
  });
  it("inside the window a session served the new key is the new key's; a session served the old key is the old key's", () => {
    const p = noteSeen(noteSeen(open(), "gl1", "s-new", "k2"), "gl1", "s-old", "k1");
    expect(ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL, "s-new")).member).toBe("k2");
    expect(ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL, "s-old")).member).toBe("k1");
  });
  it("a session the grant has not seen, or none, falls back to the window", () => {
    const p = noteSeen(open(), "gl1", "s-new", "k2");
    expect(ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL, "s-unknown")).member).toBe("k1");
    expect(ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL, null)).member).toBe("k1");
    expect(ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL)).member).toBe("k1");
    expect(ok(attributeToGrant(p, "gl1", T + 10 * SEC + TTL, TTL, "s-unknown")).member).toBe("k2");
  });
  it("an exact answer clears nothing: the window still serves the sessions that are not known", () => {
    const p = noteSeen(open(), "gl1", "s-new", "k2");
    const hit = ok(attributeToGrant(p, "gl1", T + 20 * SEC, TTL, "s-new"));
    expect(hit.pool).toBe(p);
  });
});

describe("fix round 3: the grant remembers every member it has lent the run", () => {
  it("noteLent adds a member once, in order, and says nothing when it is already there or the grant is gone", () => {
    const p = noteLent(noteLent(ok(openGrant(pool(), grant(), T)), "gl1", "k1"), "gl1", "k2");
    expect(p.grants[0]?.lent).toEqual(["k1", "k2"]);
    expect(noteLent(p, "gl1", "k1")).toBe(p);
    expect(noteLent(p, "nope", "k3")).toBe(p);
  });
  it("keeps the last thirty-two", () => {
    let p = ok(openGrant(pool(), grant(), T));
    for (let i = 0; i < 40; i++) p = noteLent(p, "gl1", `m${i}`);
    expect(p.grants[0]?.lent).toHaveLength(32);
    expect(p.grants[0]?.lent[0]).toBe("m8");
  });
  it("outlives the member: leaving the pool leaves the history as it was", () => {
    const p = noteLent(ok(openGrant(pool(), grant(), T)), "gl1", "k1");
    expect(ok(leaveKeyPool(p, "k1", T + SEC)).grants[0]?.lent).toEqual(["k1"]);
  });
});

describe("kp8 fix round 2: leaving takes the member's health, not the run's grant", () => {
  it("a grant on the member that leaves stays, naming the member it was on, so the next helper call can hand it off", () => {
    let p = ok(openGrant(pool(), grant(), T));
    p = ok(openGrant(p, grant({ id: "gl2", member: "k3", lease: "l2" }), T));
    for (const why of ["left", "revoked"] as const) {
      const left = ok(leaveKeyPool(p, "k1", T + SEC, why));
      expect(left.grants.map(g => [g.id, g.member])).toEqual([["gl1", "k1"], ["gl2", "k3"]]);
      expect(left.members.map(m => m.credential)).toEqual(["k2", "k3"]);
    }
  });
  it("a grant of a member that left can move to a member that is there, and keeps the one it left as previous", () => {
    const left = ok(leaveKeyPool(ok(openGrant(pool(), grant(), T)), "k1", T + SEC));
    const next = ok(moveGrant(left, "gl1", { member: "k2", lease: "l2", window: { calls: 2, windowStart: T }, movedAt: T + 2 * SEC }, "left", T + 2 * SEC));
    expect(next.grants[0]).toMatchObject({ member: "k2", previous: { member: "k1" } });
    expect(next.events.at(-1)).toEqual({ type: "GrantMoved", grant: "gl1", from: "k1", to: "k2", why: "left", at: T + 2 * SEC });
  });
});

describe("kp12 a grant and its events hold ids, names and times, never a secret", () => {
  it("the pool's JSON after a grant's whole history has no fingerprint, ref or provider text", () => {
    let p = ok(openGrant(pool(), grant(), T));
    p = moved(p, T + SEC);
    p = closeGrant(p, "gl1", T + 2 * SEC);
    const json = JSON.stringify(p);
    expect(json).not.toContain(PLANTED_FP);
    expect(json).not.toContain("ref-k1");
  });
});

describe("fix round 6: a grant is bound once to the filter socket of the run that holds it", () => {
  const SOCK = "/run/user/1000/mf-4242-abcdef/f.sock";
  it("a grant starts with no filter, and bindFilter records the path and changes nothing else", () => {
    const p = ok(openGrant(pool(), grant(), T));
    expect(p.grants[0]?.filter ?? null).toBeNull();
    const bound = ok(bindFilter(p, "gl1", SOCK));
    expect(bound.grants[0]).toEqual({ ...grant(), filter: SOCK });
    expect(bound.events).toEqual(p.events);
  });
  it("is refused a second time, even to the same path, so no later caller can point the grant somewhere else", () => {
    const bound = ok(bindFilter(ok(openGrant(pool(), grant(), T)), "gl1", SOCK));
    expect(word(bindFilter(bound, "gl1", SOCK))).toBe("bound");
    expect(word(bindFilter(bound, "gl1", "/tmp/own.sock"))).toBe("bound");
    expect(bound.grants[0]?.filter).toBe(SOCK);
  });
  it("is refused for a grant that is not there and for an empty or relative path", () => {
    const p = ok(openGrant(pool(), grant(), T));
    expect(word(bindFilter(p, "nope", SOCK))).toBe("missing");
    expect(word(bindFilter(p, "gl1", ""))).toBe("path");
    expect(word(bindFilter(p, "gl1", "f.sock"))).toBe("path");
    expect(p.grants[0]?.filter ?? null).toBeNull();
  });
  it("a hand-off keeps the binding: the grant moves to another member with the same filter", () => {
    const bound = ok(bindFilter(ok(openGrant(pool(), grant(), T)), "gl1", SOCK));
    expect(moved(bound, T + SEC).grants[0]?.filter).toBe(SOCK);
  });
});
