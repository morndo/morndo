// Usage (ADR-0016; U1–U4 in docs/domain.md): the newest report sets an account's windows, a missing window is kept
// until its reset passes, sessions count while fresh, and the headline picks the account nearest its limit.
import { describe, expect, it } from "vitest";
import { SESSION_FRESH_MS, accountLabel, accountNow, applyReport, cleanProfile, pruneSessions, tightest, usageLevel, type AccountProfile, type AccountUsage, type UsageReport } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const report = (o: Partial<UsageReport> = {}): UsageReport => ({
  account: "max-1", sessionId: "s1", lane: "builder", model: "Opus", at: NOW, contextUsed: 8,
  fiveHour: { usedPercentage: 23.5, resetsAt: NOW + 2 * HOUR }, sevenDay: { usedPercentage: 41.2, resetsAt: NOW + 3 * 24 * HOUR }, spend: null,
  limits: null, onDemand: null,
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

describe("an account's own windows", () => {
  const cursor = (): UsageReport => ({
    ...report({ account: "cursor", fiveHour: null, sevenDay: null, spend: null, model: "Cursor Ultra" }),
    limits: [
      { label: "Cursor models", usedPercentage: 88, resetsAt: NOW + 27 * 24 * HOUR, resetsOn: "2026-11-07" },
      { label: "Other models", usedPercentage: 45, resetsAt: NOW + 27 * 24 * HOUR, resetsOn: "2026-11-07" },
    ],
    onDemand: "off",
  } as UsageReport);

  it("a report names each window with its label, percent and reset, and says when it has no 5-hour or weekly window", () => {
    const a = applyReport(null, cursor(), NOW);
    expect(a.limits?.map(w => [w.label, w.usedPercentage, w.resetsOn])).toEqual([
      ["Cursor models", 88, "2026-11-07"],
      ["Other models", 45, "2026-11-07"],
    ]);
    expect(a.onDemand).toBe("off");
    expect(a.fiveHour).toBeNull();
    expect(a.sevenDay).toBeNull();
    const classic = applyReport(null, report(), NOW);
    expect(classic.limits).toBeNull();
    expect(classic.onDemand).toBeNull();
    expect(classic.fiveHour?.usedPercentage).toBe(23.5);
  });

  it("a later status line keeps named windows until they reset", () => {
    const first = applyReport(null, cursor(), NOW);
    const kept = applyReport(first, report({ account: "cursor", at: NOW + 1000, fiveHour: null, sevenDay: null }), NOW + 1000);
    expect(kept.limits?.[0]?.label).toBe("Cursor models");
    expect(kept.onDemand).toBe("off");
    expect(kept.fiveHour).toBeNull();
    const after = accountNow(first, NOW + 27 * 24 * HOUR + 1);
    expect(after.limits).toBeNull();
    expect(after.onDemand).toBeNull();
    const back = applyReport(after, report({ account: "cursor", at: NOW + 27 * 24 * HOUR + 2, fiveHour: { usedPercentage: 10, resetsAt: NOW + 30 * 24 * HOUR }, sevenDay: null }), NOW + 27 * 24 * HOUR + 2);
    expect(back.limits).toBeNull();
    expect(back.fiveHour?.usedPercentage).toBe(10);
    expect(back.onDemand).toBeNull();
  });

  it("an empty named list is not named mode, and a row without a label does not wipe the bars", () => {
    const empty = applyReport(null, report({ limits: [], fiveHour: { usedPercentage: 10, resetsAt: NOW + HOUR } }), NOW);
    expect(empty.limits).toBeNull();
    expect(empty.onDemand).toBeNull();
    expect(empty.fiveHour?.usedPercentage).toBe(10);
    const first = applyReport(null, cursor(), NOW);
    const kept = applyReport(first, { ...cursor(), at: NOW + 1, limits: [{ label: " ", usedPercentage: 9, resetsAt: NOW + HOUR, resetsOn: null }] }, NOW + 1);
    expect(kept.limits?.map(w => w.label)).toEqual(["Cursor models", "Other models"]);
    expect(kept.onDemand).toBe("off");
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

describe("named windows with no reset time (review of the Codex runtime, point 2)", () => {
  const nameless = (at: number) => report({ at, sessionId: "s1", fiveHour: null, sevenDay: null, limits: [{ label: "Window", usedPercentage: 90, resetsAt: null, resetsOn: null }] });
  it("a read that named a window with no reset, then ordinary 5-hour and weekly reads: the old named row goes within a day, not never", () => {
    const first = applyReport(null, nameless(NOW), NOW);
    expect(first.limits?.map(w => w.label)).toEqual(["Window"]);
    const soon = applyReport(first, report({ at: NOW + HOUR }), NOW + HOUR);
    expect(soon.limits?.map(w => w.label)).toEqual(["Window"]);               // kept for now: its own reset is unknown
    const later = applyReport(first, report({ at: NOW + 25 * HOUR }), NOW + 25 * HOUR);
    expect(later.limits).toBeNull();                                             // a day on, the fixed rows show again
    expect(later.fiveHour?.usedPercentage).toBe(23.5);
  });
  it("what the dashboard shows drops such a row a day after the report that set it", () => {
    const a = applyReport(null, nameless(NOW), NOW);
    expect(accountNow(a, NOW + 23 * HOUR).limits).not.toBeNull();
    expect(accountNow(a, NOW + 25 * HOUR).limits).toBeNull();
  });
  it("a named window that does name its reset stays until that reset, however long", () => {
    const a = applyReport(null, report({ fiveHour: null, sevenDay: null, limits: [{ label: "Weekly", usedPercentage: 50, resetsAt: NOW + 6 * 24 * HOUR, resetsOn: null }] }), NOW);
    expect(accountNow(a, NOW + 5 * 24 * HOUR).limits).not.toBeNull();
  });
});

describe("an account's profile (U5)", () => {
  const team: AccountProfile = { email: "ada@example.test", org: "team", plan: "Max 5x" };

  it("the label is the name, then email, organization and plan; a missing part is skipped; no profile is the name alone", () => {
    expect(accountLabel({ account: "a3", profile: team })).toBe("a3 · ada@example.test · Team · Max 5x");
    expect(accountLabel({ account: "a3", profile: { ...team, email: null } })).toBe("a3 · Team · Max 5x");
    expect(accountLabel({ account: "a3", profile: { ...team, org: null } })).toBe("a3 · ada@example.test · Max 5x");
    expect(accountLabel({ account: "a3", profile: { ...team, plan: null } })).toBe("a3 · ada@example.test · Team");
    expect(accountLabel({ account: "a3", profile: null })).toBe("a3");
  });

  it("a report never sets a profile and never clears one; a row stored without the field reads back as null", () => {
    expect(applyReport(null, report(), NOW).profile).toBeNull();
    const current: AccountUsage = { account: "max-1", reportedAt: NOW - 1000, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, profile: team, sessions: [] };
    expect(applyReport(current, report({ sessionId: "s2", at: NOW }), NOW).profile).toEqual(team);
    const stored: Omit<AccountUsage, "profile"> = { account: "max-1", reportedAt: NOW, fiveHour: null, sevenDay: null, spend: null, limits: null, onDemand: null, sessions: [] };
    expect(accountNow(stored as AccountUsage, NOW).profile).toBeNull();
  });

  it("cleanProfile trims and caps its texts, drops an email without an '@', and an empty profile is none", () => {
    expect(cleanProfile({ email: " ada@example.test ", org: "team", plan: " pro " })).toEqual({ email: "ada@example.test", org: "team", plan: "pro" });
    expect(cleanProfile({ plan: "p".repeat(100) })).toEqual({ email: null, org: null, plan: "p".repeat(80) });
    expect(cleanProfile({ email: "ada at example.test", plan: "pro" })).toEqual({ email: null, org: null, plan: "pro" });
    expect(cleanProfile({ org: "family" })).toBeNull();
    expect(cleanProfile({})).toBeNull();
  });
});
