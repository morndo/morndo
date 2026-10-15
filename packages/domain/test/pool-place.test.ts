// Placing a session (ADR-0029: PL4 to PL6, PL11): pinned by default, weighted round robin by the quota that expires first in
// rotate mode, and a placed session stays where it is while its seat is ok.
import { describe, expect, it } from "vitest";
import { markOut, place, placeSession, recordReading, setSettings, type PlaceAnswer, type PlaceAsk, type Pool } from "../src/index.ts";
import { H, NOW, must, poolOf, reading } from "./pool-fixtures.ts";

const pick = (p: Pool, ask: Partial<PlaceAsk> = {}): PlaceAnswer =>
  place(p, { session: null, pin: null, dir: "/work/repo", night: false, model: null, ...ask }, NOW);

function fill(p: Pool, sessions: readonly string[]): string[] {
  const order: string[] = [];
  for (const s of sessions) {
    const a = pick(p, { session: s });
    if (!a.ok) throw new Error(`no seat for ${s}`);
    order.push(a.member);
    p = placeSession(p, s, a.member, false, NOW);
  }
  return order;
}

describe("pool: rotate placement (PL4, PL5)", () => {
  it("alternates fresh members, then weights them by the quota that expires first", () => {
    expect(fill(poolOf([reading("a", { long: 0, longIn: 168 }), reading("b", { long: 0, longIn: 168 })]), ["s1", "s2", "s3"])).toEqual(["a", "b", "a"]);
    // a: half its week left, resetting in a day (2.08 %/h); b: 90 % left over six days (0.63 %/h).
    expect(fill(poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]), ["s1", "s2", "s3", "s4"])).toEqual(["a", "a", "a", "b"]);
  });

  it("counts a member's end as a reset", () => {
    const p = poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })], "rotate", { b: { keep: false, expires: NOW + 10 * H, onlyFor: [] } });
    expect(pick(p)).toMatchObject({ ok: true, member: "b" });
  });

  it("prefers a member with room over one close to its switch point", () => {
    expect(pick(poolOf([reading("a", { short: 92, long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]))).toMatchObject({ member: "b" });
  });

  it("keeps a member to its directories, and puts it first there", () => {
    const p = poolOf([reading("a", { long: 50, longIn: 24 }), reading("c", { long: 10, longIn: 160 })], "rotate", { c: { keep: false, expires: null, onlyFor: ["/work/client"] } });
    expect(pick(p, { dir: "/work/repo" })).toMatchObject({ member: "a" });
    expect(pick(p, { dir: "/work/client/app" })).toMatchObject({ member: "c" });
    expect(pick(p, { dir: "/work/client-other" })).toMatchObject({ member: "a" });
  });

  it("leaves the night reserve on members kept for the day", () => {
    const p = poolOf([reading("a", { long: 80, longIn: 24 }), reading("b", { long: 10, longIn: 144 })], "rotate", { a: { keep: true, expires: null, onlyFor: [] } });
    expect([pick(p, { night: true }), pick(p)]).toMatchObject([{ member: "b" }, { member: "a" }]);
  });

  it("places a turn for a model that is out on one member on another", () => {
    const p = markOut(poolOf([reading("a"), reading("b", { long: 10, longIn: 160 })]), "a", NOW + H, "usage limit for one model", NOW, "model-big");
    expect([pick(p, { model: "model-big" }), pick(p, { model: "model-small" })]).toMatchObject([{ member: "b" }, { member: "a" }]);
  });

  it("says when a seat comes back when none has room", () => {
    const p = markOut(poolOf([reading("a", { short: 98, shortIn: 3 }), reading("b")]), "b", NOW + 5 * H, "usage limit", NOW);
    expect(pick(p)).toEqual({ ok: false, problem: "no-seat", leastBad: "a", backAt: NOW + 3 * H });
  });

  it("can use claude-pool's strict soonest-reset order instead", () => {
    const p = must(setSettings(poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]), { order: "soonest-reset" }, null, NOW));
    expect(fill(p, ["s1", "s2", "s3", "s4", "s5"])).toEqual(["a", "a", "a", "a", "a"]);
  });
});

describe("pool: a placed session stays (PL6)", () => {
  it("stays while its member is ok, and moves at the next turn when it is low or out", () => {
    const p = placeSession(poolOf([reading("a", { long: 10, longIn: 144 }), reading("b", { long: 50, longIn: 24 })]), "s1", "a", false, NOW - 5 * 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: true, member: "a", moved: null });
    expect(pick(recordReading(p, { ...reading("a", { short: 97 }), at: NOW }, NOW), { session: "s1" })).toEqual({ ok: true, member: "b", moved: { from: "a", why: "low" } });
    expect(pick(markOut(p, "a", NOW + H, "usage limit", NOW), { session: "s1" })).toEqual({ ok: true, member: "b", moved: { from: "a", why: "out" } });
  });

  it("never moves a session to another member of its own account", () => {
    const p = placeSession(markOut(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]), "a", NOW + H, "usage limit", NOW), "s1", "a", false, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: true, member: "c", moved: { from: "a", why: "out" } });
  });
});

describe("pool: pinned (PL6, PL11)", () => {
  it("runs an unpinned session on the default member, a pinned one on its pin, and moves neither", () => {
    let p = poolOf([reading("a"), reading("b")], "pinned");
    expect(pick(p)).toEqual({ ok: false, problem: "no-default" });
    p = must(setSettings(p, { defaultMember: "b" }, null, NOW));
    expect(pick(p)).toEqual({ ok: true, member: "b", moved: null });
    expect(pick(p, { pin: "a" })).toEqual({ ok: true, member: "a", moved: null });
    p = placeSession(markOut(p, "a", NOW + 2 * H, "usage limit", NOW), "s1", "a", true, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: false, problem: "member-unavailable", member: "a", state: "out", backAt: NOW + 2 * H });
  });

  it("never moves a pinned session in rotate mode either", () => {
    const p = placeSession(markOut(poolOf([reading("a"), reading("b")]), "a", NOW + H, "usage limit", NOW), "s1", "a", true, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toMatchObject({ ok: false, problem: "member-unavailable", member: "a" });
  });
});
