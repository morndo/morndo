// Two sources read one window (plan 4.3 item 5, AT-30): the newer reading by capture time wins, a "last-known" echo
// of an earlier reading loses to any status line that spoke after it, and two recent readings from different sources
// that disagree by 15 points or more are both shown.
import { describe, expect, it } from "vitest";
import { DISAGREE_POINTS, DISAGREE_WITHIN_MS, mergeWindow, type Candidate } from "../src/index.ts";

const T = 1_700_000_000_000;      // 10:00
const MIN = 60_000;

const cand = (o: Partial<Candidate> & { source: Candidate["source"]; capturedAt: number; usedPercent: number }): Candidate =>
  ({ node: null, resetsAt: null, sameAsPrevious: false, ...o });

describe("merging two sources' readings of one window (AT-30)", () => {
  it("the headless 40% at 10:00 loses to the status line's 70% at 10:03, and both are shown as a disagreement", () => {
    const m = mergeWindow([
      cand({ source: "cli-screen", capturedAt: T, usedPercent: 40 }),
      cand({ source: "status-line", capturedAt: T + 3 * MIN, usedPercent: 70 }),
    ]);
    expect(m.shown?.usedPercent).toBe(70);
    expect(m.disagree).not.toBeNull();
    expect(m.disagree?.a.usedPercent).toBe(70);
    expect(m.disagree?.b.usedPercent).toBe(40);
  });

  it("a headless echo of its own earlier reading never beats the status line that moved", () => {
    const m = mergeWindow([
      cand({ source: "app-server", capturedAt: T + 10 * MIN, usedPercent: 40, sameAsPrevious: true }),
      cand({ source: "status-line", capturedAt: T + 3 * MIN, usedPercent: 70 }),
    ]);
    expect(m.shown?.usedPercent).toBe(70);
    expect(m.shown?.source).toBe("status-line");
    expect(m.disagree).toBeNull();
  });

  it("a headless reading that differs and is newer shows", () => {
    const m = mergeWindow([
      cand({ source: "status-line", capturedAt: T + 3 * MIN, usedPercent: 70 }),
      cand({ source: "app-server", capturedAt: T + 15 * MIN, usedPercent: 40 }),
    ]);
    expect(m.shown?.usedPercent).toBe(40);
    expect(m.shown?.source).toBe("app-server");
  });

  it("a difference of 14 points is no disagreement", () => {
    const m = mergeWindow([
      cand({ source: "cli-screen", capturedAt: T, usedPercent: 56 }),
      cand({ source: "status-line", capturedAt: T + 3 * MIN, usedPercent: 70 }),
    ]);
    expect(m.shown?.usedPercent).toBe(70);
    expect(m.disagree).toBeNull();
  });

  it("readings 11 minutes apart are no disagreement", () => {
    const m = mergeWindow([
      cand({ source: "cli-screen", capturedAt: T, usedPercent: 40 }),
      cand({ source: "status-line", capturedAt: T + 11 * MIN, usedPercent: 70 }),
    ]);
    expect(m.shown?.usedPercent).toBe(70);
    expect(m.disagree).toBeNull();
  });

  it("an empty list shows nothing and disagrees about nothing", () => {
    expect(mergeWindow([])).toEqual({ shown: null, disagree: null });
  });

  it("the lines are where the plan drew them", () => {
    expect(DISAGREE_POINTS).toBe(15);
    expect(DISAGREE_WITHIN_MS).toBe(10 * 60_000);
  });
});
