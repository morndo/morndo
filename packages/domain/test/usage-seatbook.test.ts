// One seat state per account, whatever reported the limit (plan 4.5, U9, AT-16 to AT-18): the worse state wins, the
// same state and why only extends the back time, and a mark clears only the way usage-seat's clearsMark says. A
// seat the pool set by hand is never cleared by a reading.
import { describe, expect, it } from "vitest";
import { DEFAULT_MARK_MS, MARK_EXPIRY_MS, MAX_MARK_MS, MIN_MARK_MS, applyLimit, clearSeat, markExpired, poolSeat, shownSeat, type FreshRead, type LimitHit, type SeatRecord } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00
const MIN = 60_000, HOUR = 3_600_000;

const hit = (o: Partial<LimitHit> = {}): LimitHit =>
  ({ kind: "usage_limit", at: T, backAt: null, by: "seat-a", cycle: { windowId: "five_hour", resetsAt: T + 3 * HOUR }, ...o });
const out = (o: Partial<SeatRecord> = {}): SeatRecord =>
  ({ state: "out", why: "usage_limit", since: T, markedAt: T, backAt: T + HOUR, cycleReset: T + 3 * HOUR, windowId: "five_hour", owner: "derived", by: "seat-a", ...o });
const read = (o: Partial<FreshRead> = {}): FreshRead =>
  ({ capturedAt: T + 3 * HOUR + 5 * MIN, leased: true, windows: [{ id: "five_hour", usedPercent: 20, resetsAt: T + 8 * HOUR, lengthMins: 300 }], ...o });

describe("one seat state per account (plan 4.5)", () => {
  it("a usage limit marks the seat out, with the reset it named and the back time clamped to 1 min..168 h", () => {
    const r = applyLimit(null, hit());
    expect(r.changed).toBe(true);
    expect(r.seat).toEqual({ state: "out", why: "usage_limit", since: T, markedAt: T, backAt: T + DEFAULT_MARK_MS, cycleReset: T + 3 * HOUR, windowId: "five_hour", owner: "derived", by: "seat-a" });
    expect(applyLimit(null, hit({ backAt: T + 10_000 }))?.seat?.backAt).toBe(T + MIN_MARK_MS);
    expect(applyLimit(null, hit({ backAt: T + 200 * HOUR }))?.seat?.backAt).toBe(T + MAX_MARK_MS);
    expect(DEFAULT_MARK_MS).toBe(HOUR);
    expect(MIN_MARK_MS).toBe(MIN);
    expect(MAX_MARK_MS).toBe(168 * HOUR);
  });

  it("a refusal retires the seat, a sign-out logs it out, a billing problem retires it", () => {
    expect(applyLimit(null, hit({ kind: "refused" })).seat).toMatchObject({ state: "retired", why: "refused", backAt: null, cycleReset: null, windowId: null });
    expect(applyLimit(null, hit({ kind: "signed_out" })).seat).toMatchObject({ state: "logged-out", why: "signed_out", backAt: null });
    expect(applyLimit(null, hit({ kind: "billing" })).seat).toMatchObject({ state: "retired", why: "billing", backAt: null });
  });

  it("an unknown limit changes nothing, from nothing or from a seat", () => {
    expect(applyLimit(null, hit({ kind: "unknown" }))).toEqual({ seat: null, changed: false });
    const prev = out();
    expect(applyLimit(prev, hit({ kind: "unknown" }))).toEqual({ seat: prev, changed: false });
  });

  it("the worse state stays: a retired seat survives an out, and an out is replaced by a refusal", () => {
    const retired: SeatRecord = { ...out(), state: "retired", why: "refused", backAt: null, cycleReset: null, windowId: null };
    expect(applyLimit(retired, hit())).toEqual({ seat: retired, changed: false });
    const r = applyLimit(out(), hit({ kind: "refused" }));
    expect(r.changed).toBe(true);
    expect(r.seat).toMatchObject({ state: "retired", why: "refused" });
  });

  it("the same state and why only extends the back time, without a change", () => {
    const prev = out({ backAt: T + 5 * HOUR, by: "worker-one" });
    const r = applyLimit(prev, hit({ at: T + 30 * MIN, backAt: null }));      // would say 90 min; the seat already says 5 h
    expect(r).toEqual({ seat: { ...prev, backAt: T + 5 * HOUR, by: "worker-one" }, changed: false });
    const both = applyLimit(out({ backAt: null }), hit({ backAt: T + 2 * HOUR }));
    expect(both.seat?.backAt).toBe(T + 2 * HOUR);
    expect(both.changed).toBe(false);
  });

  it("clearing an out mark delegates to the mark's own rule: a fresh new cycle clears, a stale read holds", () => {
    expect(clearSeat(out(), read())).toEqual({ seat: null, cleared: true });
    expect(clearSeat(out(), read({ windows: [{ id: "five_hour", usedPercent: 80, resetsAt: T + 3 * HOUR, lengthMins: 300 }] }))).toEqual({ seat: out(), cleared: false });
  });

  it("a refusal clears on a leased later read with a window; the rest hold", () => {
    const refused: SeatRecord = { ...out(), state: "retired", why: "refused", backAt: null, cycleReset: null, windowId: null };
    expect(clearSeat(refused, read())).toEqual({ seat: null, cleared: true });
    expect(clearSeat(refused, read({ leased: false }))).toEqual({ seat: refused, cleared: false });
    expect(clearSeat(refused, read({ capturedAt: T }))).toEqual({ seat: refused, cleared: false });
    expect(clearSeat(refused, read({ windows: [] }))).toEqual({ seat: refused, cleared: false });
    expect(clearSeat(refused, read({ windows: [{ id: "five_hour", usedPercent: null, resetsAt: null, lengthMins: null }] }))).toEqual({ seat: refused, cleared: false });
  });

  it("a seat the pool set by hand is never cleared here", () => {
    const pooled = out({ owner: "pool", by: "hand" });
    expect(clearSeat(pooled, read())).toEqual({ seat: pooled, cleared: false });
  });

  it("a derived out mark expires six hours past its back time, and nothing else does (PR #127, finding 3b)", () => {
    expect(MARK_EXPIRY_MS).toBe(6 * HOUR);
    expect(markExpired(out({ backAt: T }), T + 6 * HOUR)).toBe(false);        // exactly six hours: not yet
    expect(markExpired(out({ backAt: T }), T + 6 * HOUR + 1)).toBe(true);     // a millisecond past: expired
    expect(markExpired(out({ backAt: T }), T + 5 * HOUR)).toBe(false);        // the back time not six hours past
    expect(markExpired(out({ backAt: null }), T + 8 * HOUR)).toBe(false);     // no back time to pass
    expect(markExpired(out({ owner: "pool" }), T + 8 * HOUR)).toBe(false);    // the pool's word never expires by time
    const retired: SeatRecord = { ...out(), state: "retired", why: "refused", backAt: null, cycleReset: null, windowId: null };
    expect(markExpired(retired, T + 8 * HOUR)).toBe(false);                   // a retired derived seat stays
    const signedOut: SeatRecord = { ...out(), state: "logged-out", why: "signed_out", backAt: null, cycleReset: null, windowId: null };
    expect(markExpired(signedOut, T + 8 * HOUR)).toBe(false);                 // a logged-out derived seat stays
  });

  it("the pool's own record: owner pool, its own times, no cycle and no window, the back time as given (U15)", () => {
    expect(poolSeat({ state: "retired", why: "refused", backAt: null, at: T + 5 * MIN, by: "pool-bot" })).toEqual({
      state: "retired", why: "refused", since: T + 5 * MIN, markedAt: T + 5 * MIN, backAt: null, cycleReset: null, windowId: null, owner: "pool", by: "pool-bot",
    });
    expect(poolSeat({ state: "out", why: null, backAt: T + 2 * HOUR, at: T, by: "hand" })).toMatchObject({ state: "out", why: null, backAt: T + 2 * HOUR, owner: "pool", by: "hand" });
  });

  it("the seat shown is the worse of the pool's and the derived one; on an equal state, the pool's (U17)", () => {
    const pooled = out({ owner: "pool", by: "hand" });
    const derivedOut = out({ owner: "derived", by: "worker-one" });
    const derivedRetired: SeatRecord = { ...out(), state: "retired", why: "refused", backAt: null, cycleReset: null, windowId: null, owner: "derived", by: "worker-one" };
    expect(shownSeat(pooled, null)).toBe(pooled);
    expect(shownSeat(null, derivedOut)).toBe(derivedOut);
    expect(shownSeat(null, null)).toBeNull();
    expect(shownSeat({ ...pooled, state: "ok" }, derivedOut)).toBe(derivedOut);
    expect(shownSeat(pooled, { ...derivedOut, state: "low" })).toBe(pooled);
    expect(shownSeat(pooled, derivedRetired)).toBe(derivedRetired);
    expect(shownSeat({ ...derivedRetired, owner: "pool" }, derivedRetired)).toMatchObject({ state: "retired", owner: "pool" });
  });
});
