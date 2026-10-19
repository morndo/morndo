// The Pool's members and seats (ADR-0029: PL2, PL3, PL8, PL9, PL11, PL13, PL14): states in order, one account behind two
// members, how marks start and end, and what only the principal turns on.
import { describe, expect, it } from "vitest";
import { markOut, place, recordReading, refuse, retireMember, seats, setMode, setSettings, noteResetAdvised, type Pool } from "../src/index.ts";
import { H, NOW, must, poolOf, reading } from "./pool-fixtures.ts";

const seat = (p: Pool, m: string, model: string | null = null) => seats(p, NOW, model).find(s => s.member === m);

describe("pool: seat states (PL3)", () => {
  it("is ok, low at a switch point, out under a mark, retired off a paid plan, logged out when signed out", () => {
    const p = markOut(poolOf([reading("a"), reading("b", { short: 97 }), reading("c", { long: 99 }), reading("d", { paid: false }), reading("e", { signedIn: false })]),
      "a", NOW + 3 * H, "usage limit", NOW);
    expect(seats(p, NOW).map(s => [s.member, s.state])).toEqual([["a", "out"], ["b", "low"], ["c", "low"], ["d", "retired"], ["e", "logged-out"]]);
    expect([seat(p, "a")?.backAt, seat(p, "b")?.backAt, seat(p, "c")?.backAt]).toEqual([NOW + 3 * H, NOW + 2 * H, NOW + 72 * H]);
  });

  it("counts a window whose reset has passed as full", () => {
    expect(seat(poolOf([reading("a", { short: 99, shortIn: -1 })]), "a")).toMatchObject({ state: "ok", shortLeft: 100, shortResets: null });
  });
});

describe("pool: one account behind two members (PL2)", () => {
  it("makes the second member a copy of the first that shares its marks", () => {
    const p = markOut(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]), "b", NOW + H, "usage limit", NOW);
    expect(seat(p, "b")?.sameAs).toBe("a");
    expect([seat(p, "a")?.state, seat(p, "b")?.state, seat(p, "c")?.state]).toEqual(["out", "out", "ok"]);
  });
});

describe("pool: marks (PL8, PL9)", () => {
  it("lasts until the named reset, else an hour, and a week at most", () => {
    const p = poolOf([reading("a")]);
    expect(markOut(p, "a", NOW + 5 * H, "usage limit", NOW).marks.a?.until).toBe(NOW + 5 * H);
    expect(markOut(p, "a", null, "usage limit", NOW).marks.a?.until).toBe(NOW + H);
    expect(markOut(p, "a", NOW + 30 * 24 * H, "usage limit", NOW).marks.a?.until).toBe(NOW + 168 * H);
  });

  it("ends only with a later reading that says ordinary use is allowed", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + 5 * H, "usage limit", NOW);
    const later = (allowed: boolean | null) => recordReading(p, { ...reading("a", { short: 0, long: 0 }), at: NOW + 60_000, allowed }, NOW + 60_000);
    expect(later(true).marks.a).toBeUndefined();
    expect(later(true).events.at(-1)).toMatchObject({ type: "MarkCleared", member: "a" });
    expect(later(null).marks.a?.until).toBe(NOW + 5 * H);
    expect(later(false).marks.a?.until).toBe(NOW + 5 * H);
    expect(recordReading(p, { ...reading("a"), at: NOW - 1, allowed: true }, NOW + 60_000).marks.a?.until).toBe(NOW + 5 * H);
  });

  it("forgets the marks of a member now signed in to another identity", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + 5 * H, "usage limit", NOW);
    expect(recordReading(p, { ...reading("a"), identity: "other", at: NOW + 60_000, allowed: null }, NOW + 60_000).marks.a).toBeUndefined();
  });

  it("keeps a member open for other models when only one model's limit was hit", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + H, "usage limit for one model", NOW, "model-big");
    expect([seat(p, "a", "model-big")?.state, seat(p, "a")?.state, p.marks["a model-big"]?.until]).toEqual(["out", "ok", NOW + H]);
  });
});

describe("pool: what only the principal turns on (PL11, PL13, PL14)", () => {
  it("turns rotation on only with who decided it, and off for anyone", () => {
    const p = poolOf([reading("a")], "pinned");
    expect(setMode(p, "rotate", null, NOW)).toEqual({ ok: false, error: "rotate-needs-principal" });
    const on = must(setMode(p, "rotate", "principal@example.com", NOW));
    expect(on.events.at(-1)).toMatchObject({ type: "ModeChanged", mode: "rotate", by: "principal@example.com" });
    expect(must(setMode(on, "pinned", null, NOW)).settings.mode).toBe("pinned");
  });

  it("needs who decided it to resume across accounts again or to run more than one turn per account", () => {
    const p = poolOf([reading("a")]);
    expect(setSettings(p, { moveBy: "resume" }, null, NOW)).toEqual({ ok: false, error: "needs-principal" });
    expect(setSettings(p, { turnsPerMember: 2 }, null, NOW)).toEqual({ ok: false, error: "needs-principal" });
    expect(must(setSettings(p, { turnsPerMember: 2 }, "principal@example.com", NOW)).settings.turnsPerMember).toBe(2);
    expect(setSettings(p, { defaultMember: "nobody" }, null, NOW)).toEqual({ ok: false, error: "unknown-member" });
  });
});

describe("pool: the seat of an account is its first member that can run (PL2)", () => {
  it("passes the seat to a sibling when the first member by name is retired, and pinning the sibling works", () => {
    const p = must(retireMember(poolOf([reading("a1", { identity: "same" }), reading("a2", { identity: "same" })], "pinned"), "a1", "turned off", NOW));
    expect(seat(p, "a1")).toMatchObject({ state: "retired", sameAs: "a2" });
    expect(seat(p, "a2")).toMatchObject({ state: "ok", sameAs: null });
    expect(place(p, { session: null, pin: "a2", dir: null, night: false, model: null }, NOW)).toEqual({ ok: true, member: "a2", moved: null });
    expect(place(p, { session: null, pin: "a1", dir: null, night: false, model: null }, NOW)).toEqual({ ok: true, member: "a2", moved: null });
  });

  it("passes the seat on when the first member's end has come", () => {
    const p = poolOf([reading("a1", { identity: "same" }), reading("a2", { identity: "same" })], "pinned", { a1: { keep: false, expires: NOW - 1, onlyFor: [] }, a2: { keep: false, expires: null, onlyFor: [] } });
    expect(seat(p, "a2")?.sameAs).toBeNull();
  });
});

describe("pool: a notice of advice goes through the aggregate (PL10)", () => {
  it("adds one ResetAdvised event, and the event list stays at its one cap", () => {
    let p = poolOf([reading("a")]);
    for (let i = 0; i < 600; i++) p = refuse(p, null, "x", NOW + i);
    p = noteResetAdvised(p, { member: "a", reason: "all-blocked", backAt: null, creditExpiresAt: null, longLeft: null }, NOW + 700);
    expect(p.events.at(-1)).toMatchObject({ type: "ResetAdvised", member: "a", reason: "all-blocked" });
    expect(p.events).toHaveLength(500);
  });
});
