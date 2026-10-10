// Usage (ADR-0016; U1–U4 in docs/domain.md): the newest report sets an account's windows, a missing window is kept
// until its reset passes, sessions count while fresh, and the headline picks the account nearest its limit.
import { describe, expect, it } from "vitest";
import { SESSION_FRESH_MS, accountNow, applyReport, pruneSessions, tightest, usageLevel, type UsageReport } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const report = (o: Partial<UsageReport> = {}): UsageReport => ({
  account: "max-1", sessionId: "s1", lane: "builder", model: "Opus", at: NOW, contextUsed: 8,
  fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 2 * HOUR }, sevenDay: { usedPercentage: 41.2, resetsAt: NOW + 3 * 24 * HOUR }, spend: null,
  ...o,
});

describe("one report (U2)", () => {
  it("the first report makes the account: its windows, its session", () => {
    const a = applyReport(null, report(), NOW);
    expect(a).toMatchObject({ account: "max-1", reportedAt: NOW, fiveHour: { usedPercentage: 23.5 }, sevenDay: { usedPercentage: 41.2 }, spend: null });
    expect(a.sessions).toEqual([{ sessionId: "s1", lane: "builder", model: "Opus", contextUsed: 8, at: NOW }]);
  });
  it("a newer report moves the windows; a window it lacks is kept until its reset passes, then dropped", () => {
    const first = applyReport(null, report(), NOW);
    const later = applyReport(first, report({ sessionId: "s2", at: NOW + 1000, fiveHour: { usedPercentage: 30, resetsAt: NOW + 2 * HOUR }, sevenDay: null }), NOW + 1000);
    expect(later.fiveHour?.usedPercentage).toBe(30);
    expect(later.sevenDay?.usedPercentage).toBe(41.2);              // kept: its reset is days away
    const afterReset = applyReport(later, report({ sessionId: "s3", at: NOW + 3 * HOUR, fiveHour: null, sevenDay: null }), NOW + 3 * HOUR);
    expect(afterReset.fiveHour).toBeNull();                           // its reset (NOW + 2 h) has passed
    expect(afterReset.sevenDay?.usedPercentage).toBe(41.2);
  });
  it("an older report never moves the windows, but its session is noted", () => {
    const a = applyReport(applyReport(null, report(), NOW), report({ sessionId: "s2", at: NOW - 5000, fiveHour: { usedPercentage: 99, resetsAt: NOW + HOUR } }), NOW);
    expect(a.fiveHour?.usedPercentage).toBe(23.5);
    expect(a.sessions.map(s => s.sessionId)).toEqual(["s1", "s2"]);
  });
  it("a session's own older report never replaces its newer one; percentages are clamped to 0..100", () => {
    const a = applyReport(applyReport(null, report({ contextUsed: 50 }), NOW), report({ at: NOW - 1, contextUsed: 10 }), NOW);
    expect(a.sessions[0]?.contextUsed).toBe(50);
    expect(applyReport(null, report({ fiveHour: { usedPercentage: 140, resetsAt: null }, contextUsed: -3 }), NOW)).toMatchObject({ fiveHour: { usedPercentage: 100 }, sessions: [{ contextUsed: 0 }] });
  });
  it("spend follows the same rule, with its dollars", () => {
    const a = applyReport(null, report({ spend: { usedPercentage: 62.8, resetsAt: NOW + 20 * 24 * HOUR, usedUsd: 314.12, limitUsd: 500, period: "monthly" } }), NOW);
    expect(a.spend).toEqual({ usedPercentage: 62.8, resetsAt: NOW + 20 * 24 * HOUR, usedUsd: 314.12, limitUsd: 500, period: "monthly" });
    expect(applyReport(a, report({ at: NOW + 1 }), NOW + 1).spend?.usedUsd).toBe(314.12);
  });
});

describe("sessions (U3) and what is shown now", () => {
  it("a session counts while fresh, newest first", () => {
    const s = (id: string, at: number) => ({ sessionId: id, lane: null, model: null, contextUsed: null, at });
    expect(pruneSessions([s("old", NOW - SESSION_FRESH_MS), s("a", NOW - 1000), s("b", NOW)], NOW).map(x => x.sessionId)).toEqual(["b", "a"]);
  });
  it("accountNow drops a window whose reset has passed, without a report", () => {
    const a = applyReport(null, report(), NOW);
    const shown = accountNow(a, NOW + 2 * HOUR + 1);
    expect(shown.fiveHour).toBeNull();
    expect(shown.sevenDay?.usedPercentage).toBe(41.2);
    expect(shown.sessions).toEqual([]);                               // 2 hours silent: not reporting
  });
});

describe("the headline", () => {
  it("picks the account nearest its limit per window; none when nobody reports it", () => {
    const a = applyReport(null, report(), NOW);
    const b = applyReport(null, report({ account: "max-2", fiveHour: { usedPercentage: 92, resetsAt: NOW + HOUR }, sevenDay: null }), NOW);
    expect(tightest([a, b], "fiveHour")).toEqual({ account: "max-2", window: { usedPercentage: 92, resetsAt: NOW + HOUR } });
    expect(tightest([a, b], "sevenDay")?.account).toBe("max-1");
    expect(tightest([b], "sevenDay")).toBeNull();
  });
  it("levels: ok below 75, warning from 75, critical from 90", () => {
    expect([0, 74.9, 75, 89.9, 90, 100].map(usageLevel)).toEqual(["ok", "ok", "warning", "warning", "critical", "critical"]);
  });
});
