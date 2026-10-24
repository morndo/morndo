// The hub's memory of a window's cycle (plan 4.1 item 3, U7): the first reset starts the book, a reset close by only
// widens the horizon, a later reset once the old cycle ended is a new cycle and yields the gap between the two, and a
// reset that slid later while the old cycle was still ahead is a rolling window, never a gap.
import { describe, expect, it } from "vitest";
import { cadenceInput, cadenceOf, noCycleBook, observeCycle, windowTitle } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

describe("the cycle book (U7, plan 4.1 item 3)", () => {
  it("the first reset ever starts the book and the horizon", () => {
    const b = observeCycle(noCycleBook, T + 3 * HOUR, T);
    expect(b).toEqual({ cycleResetsAt: T + 3 * HOUR, furthestMs: 3 * HOUR, gapMs: null });
  });

  it("a reset within a minute of the cycle's own only widens the horizon", () => {
    const first = observeCycle(noCycleBook, T + 3 * HOUR, T);
    const widened = observeCycle(first, T + 3 * HOUR + 30_000, T);          // the same cycle, seen 30 s further out
    expect(widened).toEqual({ cycleResetsAt: T + 3 * HOUR, furthestMs: 3 * HOUR + 30_000, gapMs: null });
  });

  it("a new cycle a week later yields the week's gap, and the cadence title says weekly without about", () => {
    const first = observeCycle(noCycleBook, T + 3 * HOUR, T);
    const next = observeCycle(first, T + 3 * HOUR + 7 * DAY, T + 7 * DAY);  // the old cycle had ended
    expect(next.gapMs).toBe(7 * DAY);
    const cadence = cadenceOf({ lengthMins: null, ...cadenceInput(next), family: null });
    expect(cadence).toEqual({ basis: "observed", lengthMins: 10080 });
    const title = windowTitle(cadence, T + 3 * HOUR + 7 * DAY, T + 7 * DAY);
    expect(title).toBe("weekly");
    expect(title.includes("about")).toBe(false);
  });

  it("a reset that slid later while the old cycle was still ahead is a rolling window, not a gap", () => {
    const first = observeCycle(noCycleBook, T + 3 * HOUR, T);
    const slid = observeCycle(first, T + 4 * HOUR, T + HOUR);               // the old reset is still ahead of now
    expect(slid).toEqual({ cycleResetsAt: T + 4 * HOUR, furthestMs: 3 * HOUR, gapMs: null });
  });

  it("a null reading and an out-of-order reading change nothing", () => {
    const b = observeCycle(noCycleBook, T + 3 * HOUR, T);
    expect(observeCycle(b, null, T + HOUR)).toEqual(b);
    expect(observeCycle(b, T + HOUR, T + 10 * MIN)).toEqual(b);             // earlier by more than a minute
  });
});
