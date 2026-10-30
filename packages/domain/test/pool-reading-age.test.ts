// How old a usage reading may be before its windows count as unknown in rotate placement (T-614; PL3, PL4). A reading older
// than `readingMaxAgeMinutes`, or none at all, proves no room: the seat goes after every seat its account read recently.
import { describe, expect, it } from "vitest";
import { addMember, place, placeSession, POOL_DEFAULTS, seats, setSettings, type PlaceAnswer, type PlaceAsk, type Pool, type Reading } from "../src/index.ts";
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

describe("pool: a reading's age after onlyFor, at its bound, and with a seat that can’t run (T-614, review)", () => {
  it("keeps a member's own directories first for it though its reading is old", () => {
    // c serves /work/client only; its last reading is 40 minutes old (a turn held it through a read round).
    const p = poolOf([reading("a", { short: 0, long: 0 }), reading("c", { short: 0, long: 0, at: NOW - 40 * MIN })], "rotate", { c: { keep: false, expires: null, onlyFor: ["/work/client"] } });
    expect(pick(p, { dir: "/work/client/app" })).toMatchObject({ ok: true, member: "c" });
    expect(pick(p, { dir: "/work/repo" })).toMatchObject({ ok: true, member: "a" });
  });

  it("counts a reading exactly readingMaxAgeMinutes old as recent, and one a millisecond older as unknown", () => {
    const aged = (age: number): Pool => poolOf([reading("a", { short: 0, long: 0, at: NOW - age }), reading("b", { short: 6, long: 40 })]);
    expect(pick(aged(30 * MIN))).toMatchObject({ ok: true, member: "a" });
    expect(pick(aged(30 * MIN + 1))).toMatchObject({ ok: true, member: "b" });
  });

  it("puts a seat that can’t run last even when its reading is old too", () => {
    const p = poolOf([reading("a", { short: 0, long: 0, allowed: false, at: NOW - 2 * H }), reading("b", { short: 6, long: 40, at: NOW - 2 * H })]);
    expect(pick(p)).toMatchObject({ ok: true, member: "b" });
  });
});

describe("pool: an old low window with no reset time, a pool without the setting, and the setting's floor (T-614, review 2)", () => {
  // The short window (300 minutes) names no reset time.
  const noReset = (r: Reading): Reading => ({ ...r, windows: r.windows.map(w => (w.minutes === 300 ? { ...w, resetsAt: null } : w)) });

  it("counts an old low window with no reset time as unknown once its reading is older than the window's length", () => {
    const old = poolOf([noReset(reading("a", { short: 98, at: NOW - 301 * MIN }))]);
    expect(seats(old, NOW)[0]?.state).toBe("ok");
    expect(pick(old)).toMatchObject({ ok: true, member: "a" });
  });

  it("keeps it low within that length, and no seat then says when the window has turned over", () => {
    const recent = poolOf([noReset(reading("a", { short: 98, at: NOW - 2 * H }))]);
    expect(seats(recent, NOW)[0]).toMatchObject({ state: "low", backAt: NOW - 2 * H + 300 * MIN });
    expect(pick(recent)).toEqual({ ok: false, problem: "no-seat", leastBad: "a", backAt: NOW - 2 * H + 300 * MIN });
  });

  it("takes 168 hours for a window that names neither a reset time nor a length", () => {
    const one = (at: number): Pool => poolOf([{ ...reading("a"), at, windows: [{ usedPercent: 100, minutes: null, resetsAt: null }] }]);
    expect(seats(one(NOW - 167 * H), NOW)[0]).toMatchObject({ state: "low", backAt: NOW + H });
    expect(seats(one(NOW - 169 * H), NOW)[0]?.state).toBe("ok");
  });

  it("treats a pool whose settings lack readingMaxAgeMinutes as the default 30 minutes", () => {
    const p = poolOf([reading("a", { short: 0, long: 0, at: NOW - 31 * MIN }), reading("b", { short: 6, long: 40 })]);
    const { readingMaxAgeMinutes: _gone, ...older } = p.settings;
    expect(pick({ ...p, settings: older as Pool["settings"] })).toMatchObject({ ok: true, member: "b" });
  });

  it("refuses a readingMaxAgeMinutes below one minute", () => {
    const p = poolOf([reading("a")]);
    expect(setSettings(p, { readingMaxAgeMinutes: 0 }, null, NOW)).toEqual({ ok: false, error: "bad-value" });
    expect(setSettings(p, { readingMaxAgeMinutes: 1 }, null, NOW).ok).toBe(true);
  });
});
