// Claims and advice (ADR-0029: PL7, PL10, PL13): one writer per session, one turn at a time per account, resets only advised.
import { describe, expect, it } from "vitest";
import { bindSession, claim, placeSession, release, resetAdvice } from "../src/index.ts";
import { ALIVE, H, NOW, holder, must, poolOf, reading } from "./pool-fixtures.ts";

describe("pool: one writer per session (PL7)", () => {
  it("refuses a second writer while the first lives, and takes over from a dead one", () => {
    const p = must(claim(poolOf([reading("a"), reading("b")]), { id: "c1", session: "s1", member: "a", holder: holder(101) }, ALIVE, NOW));
    expect(claim(p, { id: "c2", session: "s1", member: "b", holder: holder(202) }, ALIVE, NOW))
      .toEqual({ ok: false, error: { problem: "session-busy", holder: holder(101) } });
    const taken = must(claim(p, { id: "c2", session: "s1", member: "b", holder: holder(202) }, h => h.pid !== 101, NOW));
    expect(taken.claims.map(c => c.id)).toEqual(["c2"]);
    expect(taken.events.some(e => e.type === "ClaimLost" && e.claim === "c1")).toBe(true);
  });

  it("binds a new session to its claim and keeps when its last turn ended", () => {
    let p = must(claim(poolOf([reading("a")]), { id: "c1", session: null, member: "a", holder: holder(101) }, ALIVE, NOW));
    p = placeSession(must(bindSession(p, "c1", "s-new", ALIVE, NOW)), "s-new", "a", false, NOW);
    p = release(p, "c1", NOW + 60_000);
    expect(p.claims).toEqual([]);
    expect(p.placements).toEqual([{ session: "s-new", member: "a", pinned: false, at: NOW, lastTurnAt: NOW + 60_000 }]);
  });
});

describe("pool: one turn per sign-in (PL13)", () => {
  it("runs one turn at a time per account, across members of one identity", () => {
    const p = must(claim(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]),
      { id: "c1", session: "s1", member: "a", holder: holder(101) }, ALIVE, NOW));
    expect(claim(p, { id: "c2", session: "s2", member: "b", holder: holder(202) }, ALIVE, NOW)).toEqual({ ok: false, error: { problem: "member-busy", member: "a" } });
    expect(claim(p, { id: "c3", session: null, member: "c", holder: holder(303) }, ALIVE, NOW).ok).toBe(true);
    expect(claim(release(p, "c1", NOW), { id: "c2", session: "s2", member: "b", holder: holder(202) }, ALIVE, NOW).ok).toBe(true);
  });
});

describe("pool: reset credits are only advised (PL10)", () => {
  const blocked = (bLongIn: number, credits = 1) => poolOf([
    reading("a", { long: 99, longIn: 120, credits: { available: credits, expiresAt: null } }),
    reading("b", { long: 99, longIn: bLongIn, credits: { available: credits, expiresAt: null } }),
  ]);

  it("advises a reset when every seat is blocked, work waits and the wait is long, on the member whose week runs longest", () => {
    expect(resetAdvice(blocked(30), 1, NOW)).toEqual({ member: "a", reason: "all-blocked", backAt: NOW + 30 * H, creditExpiresAt: null, longLeft: 1 });
    expect(resetAdvice(blocked(30), 0, NOW)).toBeNull();
    expect(resetAdvice(blocked(2), 1, NOW)).toBeNull();
    expect(resetAdvice(blocked(30, 0), 1, NOW)).toBeNull();
    expect(resetAdvice(poolOf([reading("a", { long: 99, credits: { available: 1, expiresAt: null } }), reading("b")]), 1, NOW)).toBeNull();
  });

  it("advises using a credit that would lapse unused", () => {
    const p = poolOf([reading("a", { long: 60, credits: { available: 1, expiresAt: NOW + 48 * H } }), reading("b")]);
    expect(resetAdvice(p, 0, NOW)).toEqual({ member: "a", reason: "credit-expiring", backAt: null, creditExpiresAt: NOW + 48 * H, longLeft: 40 });
  });
});
