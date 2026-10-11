// Named windows count toward the notice, and the 5-hour and weekly tiles count only the rows a card shows.
// The on-demand line and the reset date have one rule, here.
import { describe, expect, it } from "vitest";
import { applyReport, onDemandLine, resetsOnLabel, shownLevel, tightestShown, type UsageReport } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const report = (o: Partial<UsageReport> = {}): UsageReport => ({
  account: "max-1", sessionId: "s1", lane: "builder", model: "Opus", at: NOW, contextUsed: 8,
  fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 2 * HOUR }, sevenDay: { usedPercentage: 41.2, resetsAt: NOW + 3 * 24 * HOUR }, spend: null,
  limits: null, onDemand: null,
  ...o,
});

const DEMAND = `on-demand ${"x".repeat(61)}`;

describe("what Home counts", () => {
  it("a named window at 90 or above raises the same notice, and a hidden 5-hour row is not the tightest", () => {
    const named = applyReport(null, report({
      account: "cursor", fiveHour: { usedPercentage: 99, resetsAt: NOW + HOUR }, sevenDay: null,
      limits: [{ label: "Cursor models", usedPercentage: 92, resetsAt: NOW + HOUR, resetsOn: "2026-11-07" }],
      onDemand: "off",
    }), NOW);
    const classic = applyReport(null, report(), NOW);
    expect(shownLevel([named, classic])).toBe("critical");
    expect(tightestShown([named, classic], "fiveHour")).toEqual({ account: "max-1", window: { usedPercentage: 23.5, resetsAt: NOW + 2 * HOUR } });
  });

  it("the on-demand line and the reset date are decided once", () => {
    expect(onDemandLine("off")).toBe("on-demand off");
    expect(onDemandLine("unavailable")).toBe("on-demand limit unavailable");
    expect(onDemandLine(DEMAND)).toBe(DEMAND);
    expect(onDemandLine("nope")).toBeNull();
    expect(resetsOnLabel("2026-11-07")).toBe("resets 7 Nov");
    expect(resetsOnLabel("2026-02-31")).toBeNull();
  });
});
