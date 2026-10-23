// Seat limits (U9, U13): a mark clears only from a fresh lease reading a new cycle that began after the mark — an
// old cycle's numbers never clear it, whatever they say. The words for why a seat is out are closed, and each has
// its fix from the closed list.
import { describe, expect, it } from "vitest";
import { clearsMark, fixFor, worseSeatState, type FreshRead, type LimitMark } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00, the moment the seat was marked
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

const mark = (o: Partial<LimitMark> = {}): LimitMark => ({ markedAt: T, backAt: T + HOUR, cycleReset: T + 3 * HOUR, windowId: "five-hour", ...o });
const read = (o: Partial<FreshRead> = {}): FreshRead => ({ capturedAt: T + 3 * HOUR + 5 * MIN, leased: true, windows: [{ id: "five-hour", usedPercent: 20, resetsAt: T + 8 * HOUR, lengthMins: 300 }], ...o });

describe("seat limits (U9, U13)", () => {
  it("no early clear, from any source", () => {
    // a fresh read of a new cycle, on lease: clears
    expect(clearsMark(mark(), read())).toBe(true);
    // a stale read of the old cycle: 80% at the old reset, stamped after the back time, still holds
    expect(clearsMark(mark(), read({ capturedAt: T + 65 * MIN, windows: [{ id: "five-hour", usedPercent: 80, resetsAt: T + 3 * HOUR, lengthMins: 300 }] }))).toBe(false);
    // the same fresh read without a lease holds
    expect(clearsMark(mark(), read({ leased: false }))).toBe(false);
    // a read after the back time that shows the same cycle reset as the one recorded holds, though its length would put the cycle start after the mark
    expect(clearsMark(mark(), read({ windows: [{ id: "five-hour", usedPercent: 20, resetsAt: T + 3 * HOUR, lengthMins: 60 }] }))).toBe(false);
    // a first-ever hit has no cycle reset; the stale read's cycle began before the mark, so it holds
    expect(clearsMark(mark({ cycleReset: null }), read({ capturedAt: T + 65 * MIN, windows: [{ id: "five-hour", usedPercent: 80, resetsAt: T + 3 * HOUR, lengthMins: 300 }] }))).toBe(false);
    // an unknown length can never clear
    expect(clearsMark(mark(), read({ windows: [{ id: "five-hour", usedPercent: 20, resetsAt: T + 8 * HOUR, lengthMins: null }] }))).toBe(false);
    // a read not later than the mark, and one not later than the back time, hold
    expect(clearsMark(mark(), read({ capturedAt: T - 30 * MIN }))).toBe(false);
    expect(clearsMark(mark(), read({ capturedAt: T + 30 * MIN }))).toBe(false);
    // a flag read: only an explicit yes with no limit type reached clears
    expect(clearsMark(mark(), read({ windows: [], ordinaryUsageAllowed: true, rateLimitReachedType: null }))).toBe(true);
    expect(clearsMark(mark(), read({ windows: [], ordinaryUsageAllowed: false }))).toBe(false);
    expect(clearsMark(mark(), read({ windows: [], ordinaryUsageAllowed: true, rateLimitReachedType: "rate_limit" }))).toBe(false);
    expect(clearsMark(mark(), read({ windows: [], ordinaryUsageAllowed: null }))).toBe(false);
    // the mark's own window is the one read; another window's numbers do not clear it
    expect(clearsMark(mark(), read({ windows: [{ id: "weekly", usedPercent: 20, resetsAt: T + 8 * DAY, lengthMins: 10080 }] }))).toBe(false);
  });

  it("the worse seat state wins", () => {
    for (const [a, b, worse] of [
      ["ok", "low", "low"], ["low", "out", "out"], ["out", "retired", "retired"], ["retired", "logged-out", "logged-out"],
      ["ok", "logged-out", "logged-out"], ["ok", "ok", "ok"],
    ] as const) {
      expect(worseSeatState(a, b)).toBe(worse);
      expect(worseSeatState(b, a)).toBe(worse);
    }
  });

  it("a Fix comes from the closed list", () => {
    expect(fixFor("logged-out", null)).toBe("sign_in_again");
    expect(fixFor("logged-out", "usage_limit")).toBe("sign_in_again");
    expect(fixFor("retired", "refused")).toBe("use_another_account");
    expect(fixFor("retired", "plan_ended")).toBe("reactivate_the_seat");
    expect(fixFor("retired", "billing")).toBe("ask_the_org_admin");
    expect(fixFor("retired", null)).toBe("use_another_account");
    expect(fixFor("out", "usage_limit")).toBe("wait_for_reset");
    expect(fixFor("out", "by_hand")).toBe("wait_for_reset");
    expect(fixFor("low", "usage_limit")).toBeNull();
    expect(fixFor("ok", null)).toBeNull();
  });
});
