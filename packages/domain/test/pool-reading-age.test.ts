// How old a usage reading may be before its windows count as unknown in rotate placement (T-614; PL3, PL4). A reading older
// than `readingMaxAgeMinutes`, or none at all, proves no room: the seat goes after every seat its account read recently.
import { describe, expect, it } from "vitest";
import { addMember, place, placeSession, POOL_DEFAULTS, seats, setSettings, type PlaceAnswer, type PlaceAsk, type Pool } from "../src/index.ts";
import { H, NONE, NOW, must, poolOf, reading } from "./pool-fixtures.ts";

const MIN = 60_000;
const pick = (p: Pool, ask: Partial<PlaceAsk> = {}): PlaceAnswer =>
  place(p, { session: null, pin: null, dir: "/work/repo", night: false, model: null, ...ask }, NOW);

describe("pool: a reading older than readingMaxAgeMinutes proves no room (T-614)", () => {
  it("defaults to 30 minutes, twice the 15-minute read round", () => {
    expect(POOL_DEFAULTS.readingMaxAgeMinutes).toBe(30);
  });

  it("places a new session on a seat read recently before one whose last reading is older, roomy or not", () => {
    // a's reading is 31 minutes old and shows more room; b was read a minute ago.
    const roomy = poolOf([reading("a", { short: 0, long: 0, at: NOW - 31 * MIN }), reading("b", { short: 6, long: 40 })]);
    expect(pick(roomy)).toMatchObject({ ok: true, member: "b" });
    // b has 8 % of its short window left: past its pick margin, above its switch point. A fresh ok seat still goes first.
    const tight = poolOf([reading("a", { short: 0, long: 0, at: NOW - 31 * MIN }), reading("b", { short: 92, long: 40 })]);
    expect(pick(tight)).toMatchObject({ ok: true, member: "b" });
  });

  it("counts a seat with no reading at all as unknown too", () => {
    // Unread, a would count as full and go first (its unknown week weighs as 100 % over 168 hours).
    const p = must(addMember(poolOf([reading("b", { long: 10, longIn: 168 })]), "a", NONE, NOW - H));
    expect(pick(p)).toMatchObject({ ok: true, member: "b" });
  });

  it("moves a session that must move to a seat read recently first", () => {
    let p = poolOf([reading("a", { short: 98 }), reading("b", { short: 0, long: 0, at: NOW - 31 * MIN }), reading("c", { short: 6, long: 40 })]);
    p = placeSession(p, "s1", "a", false, NOW);
    expect(pick(p, { session: "s1" })).toMatchObject({ ok: true, member: "c", moved: { from: "a", why: "low" } });
  });

  it("uses the pool's readingMaxAgeMinutes", () => {
    const p = poolOf([reading("a", { short: 0, long: 0, at: NOW - 20 * MIN }), reading("b", { short: 6, long: 40 })]);
    expect(pick(p)).toMatchObject({ ok: true, member: "a" });
    expect(pick(must(setSettings(p, { readingMaxAgeMinutes: 15 }, null, NOW)))).toMatchObject({ ok: true, member: "b" });
  });

  it("keeps today's order when no seat was read recently", () => {
    const p = poolOf([reading("a", { long: 50, longIn: 24, at: NOW - 2 * H }), reading("b", { long: 10, longIn: 144, at: NOW - 2 * H })]);
    expect(pick(p)).toMatchObject({ ok: true, member: "a" });
  });

  it("keeps an old reading at its switch point low until that window resets, and then ranks the seat as unknown", () => {
    const low = poolOf([reading("a", { short: 98, shortIn: 2, at: NOW - 2 * H }), reading("b", { at: NOW - 2 * H })]);
    expect(seats(low, NOW).find(s => s.member === "a")?.state).toBe("low");
    expect(pick(low)).toMatchObject({ ok: true, member: "b" });
    const reset = poolOf([reading("a", { short: 98, shortIn: -1, at: NOW - 2 * H }), reading("b")]);
    expect(seats(reset, NOW).find(s => s.member === "a")?.state).toBe("ok");
    expect(pick(reset)).toMatchObject({ ok: true, member: "b" });
    expect(pick(reset, { skip: ["b"] })).toMatchObject({ ok: true, member: "a" });
  });

  it("goes by the freshest reading of the account (PL2)", () => {
    // a1 and a2 are one account: a1's own reading is two hours old, a2 read the account a minute ago.
    const p = poolOf([
      reading("a1", { identity: "id-a", short: 0, long: 0, at: NOW - 2 * H }),
      reading("a2", { identity: "id-a", short: 0, long: 0 }),
      reading("b", { short: 6, long: 40 }),
    ]);
    expect(pick(p)).toMatchObject({ ok: true, member: "a1" });
  });

  it("keeps a seat its fresh reading says can’t run after an unknown one, and leaves pins, pinned mode and placed sessions alone", () => {
    expect(pick(poolOf([reading("a", { short: 0, long: 0, allowed: false }), reading("b", { at: NOW - 2 * H })]))).toMatchObject({ ok: true, member: "b" });
    const q = poolOf([reading("a", { short: 0, long: 0, at: NOW - 2 * H }), reading("b", { short: 6, long: 40 })]);
    expect(pick(q, { pin: "a" })).toMatchObject({ ok: true, member: "a" });
    expect(pick(placeSession(q, "s1", "a", false, NOW), { session: "s1" })).toMatchObject({ ok: true, member: "a", moved: null });
    const pinned = must(setSettings(poolOf([reading("a", { at: NOW - 2 * H }), reading("b")], "pinned"), { defaultMember: "a" }, null, NOW));
    expect(pick(pinned)).toMatchObject({ ok: true, member: "a" });
  });
});
