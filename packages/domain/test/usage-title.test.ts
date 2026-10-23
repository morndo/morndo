// Window titles (U7): a title comes from a reported length, an observed gap between resets, or the horizon of the
// furthest reset seen — never from a caption the provider printed. A horizon is always said with "about".
import { describe, expect, it } from "vitest";
import { cadenceOf, lengthTitle, resetsInLabel, takeNamed, windowTitle } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

describe("window titles (U7)", () => {
  it("names a window from its reported length", () => {
    expect(lengthTitle(300)).toBe("5-hour");
    expect(lengthTitle(10080)).toBe("weekly");
    expect(windowTitle({ basis: "reported", lengthMins: 300 }, null, NOW)).toBe("5-hour");
  });

  it("never names from a caption", () => {
    // cadenceOf and windowTitle take no label: exactly the documented arguments, and a reported length titles itself.
    const weekly = cadenceOf({ lengthMins: 10080, observedGapMs: null, furthestResetMs: null, family: null });
    expect(weekly).toEqual({ basis: "reported", lengthMins: 10080 });
    expect(lengthTitle(10080)).toBe("weekly");
    expect(windowTitle(weekly, null, NOW)).toBe("weekly");
    // through the named-window path: a caption ("monthly") cannot steer the title; the reported length can.
    const rows = takeNamed([{ label: "monthly", usedPercentage: 50, resetsAt: null, resetsOn: null, lengthMins: 10080 }]);
    expect(rows?.[0]?.lengthMins).toBe(10080);
  });

  it("observes a cycle", () => {
    const c = cadenceOf({ lengthMins: null, observedGapMs: 7 * DAY + 90 * 1000, furthestResetMs: null, family: null });
    expect(c).toEqual({ basis: "observed", lengthMins: 10080 });      // 7 d + 90 s rounds to 10082, which snaps to a week
    const title = windowTitle(c, null, NOW);
    expect(title).toBe("weekly");
    expect(title).not.toContain("about");
  });

  it("horizon only says about", () => {
    expect(windowTitle(cadenceOf({ lengthMins: null, observedGapMs: null, furthestResetMs: 6 * DAY + 20 * HOUR, family: "weekly" }), null, NOW)).toBe("about weekly");
    expect(windowTitle(cadenceOf({ lengthMins: null, observedGapMs: null, furthestResetMs: 25 * DAY, family: "weekly" }), null, NOW)).toBe("about monthly");
    expect(windowTitle(cadenceOf({ lengthMins: null, observedGapMs: null, furthestResetMs: 5 * DAY, family: "either" }), null, NOW)).toBe("plan period");
    const none = cadenceOf({ lengthMins: null, observedGapMs: null, furthestResetMs: 6 * DAY + 2 * HOUR, family: null });
    expect(none).toEqual({ basis: "none", lengthMins: null });
    expect(windowTitle(none, NOW + 6 * DAY + 2 * HOUR, NOW)).toBe("resets in 6 d 2 h");
  });

  it("lengths: the two named ones first, then days, months, hours, minutes", () => {
    expect([300, 10080, 4320, 43200, 40320, 44640, 7200, 120, 90].map(lengthTitle)).toEqual([
      "5-hour", "weekly", "3-day", "monthly", "monthly", "monthly", "5-day", "2-hour window", "90-minute window",
    ]);
  });

  it("resets: nothing to say, past, days and hours and minutes", () => {
    expect(resetsInLabel(null, NOW)).toBe("window");
    expect(resetsInLabel(NOW, NOW)).toBe("resetting");
    expect(resetsInLabel(NOW - 1, NOW)).toBe("resetting");
    expect(resetsInLabel(NOW + 6 * DAY + 2 * HOUR, NOW)).toBe("resets in 6 d 2 h");
    expect(resetsInLabel(NOW + 3 * DAY, NOW)).toBe("resets in 3 d");
    expect(resetsInLabel(NOW + 25 * HOUR, NOW)).toBe("resets in 1 d 1 h");
    expect(resetsInLabel(NOW + 2 * HOUR + 30 * MIN, NOW)).toBe("resets in 2 h 30 min");
    expect(resetsInLabel(NOW + 2 * HOUR, NOW)).toBe("resets in 2 h");
    expect(resetsInLabel(NOW + 90 * MIN, NOW)).toBe("resets in 1 h 30 min");
    expect(resetsInLabel(NOW + 45 * MIN, NOW)).toBe("resets in 45 min");
    expect(resetsInLabel(NOW + 30 * 1000, NOW)).toBe("resets in 1 min");
  });
});
