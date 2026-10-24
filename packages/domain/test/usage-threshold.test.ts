// Thresholds (U12): a level is told once per crossing, only after two readings at or above it, and told again only
// after the usage clears well below it. A moved reset time is a new cycle and starts both over.
import { describe, expect, it } from "vitest";
import { noThresholdWatch, watchThreshold } from "../src/index.ts";

const R1 = 1_700_000_000_000;
const R2 = R1 + 7 * 86_400_000;

describe("thresholds (U12)", () => {
  it("a threshold is told once per crossing and cleared on recovery", () => {
    let w = noThresholdWatch;
    const step = (usedPercent: number | null, resetsAt: number | null) => {
      const r = watchThreshold(w, usedPercent, resetsAt);
      w = r.watch;
      return r.told;
    };
    expect(step(74, R1)).toBeNull();
    expect(step(76, R1)).toBeNull();
    expect(step(77, R1)).toBe("warning");
    expect(step(80, R1)).toBeNull();
    expect(step(91, R1)).toBeNull();
    expect(step(92, R1)).toBe("critical");
    // the reset moved to the next cycle: the runs and the told flags start over
    expect(step(76, R2)).toBeNull();
    expect(step(77, R2)).toBe("warning");
    // a recovery clears the warning, so a later crossing tells again
    expect(step(69, R2)).toBeNull();
    expect(step(76, R2)).toBeNull();
    expect(step(77, R2)).toBe("warning");
  });
});
