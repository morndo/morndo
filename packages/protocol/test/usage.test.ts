// The usage report on the wire (ADR-0016): a status line without named windows still parses, and an account frame
// from before named windows still parses. Named windows are optional.
import { describe, expect, it } from "vitest";
import { AccountUsageSchema, UsageReportBody, parseBody } from "../src/index.ts";

const claude = {
  session_id: "s1",
  model: { id: "claude-opus-5-5", display_name: "Opus" },
  context_window: { used_percentage: 8 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_700_000_000 }, seven_day: { used_percentage: 41.2, resets_at: 1_700_100_000 } },
};

describe("usage report shape", () => {
  it("a status line without named windows still parses", () => {
    const b = parseBody(UsageReportBody, claude);
    expect(b?.session_id).toBe("s1");
    expect(b?.rate_limits?.five_hour?.used_percentage).toBe(23.5);
    expect(b && "limits" in b ? b.limits : undefined).toBeUndefined();
  });

  it("a cursor report names its windows, and a bad row does not reject the report", () => {
    const b = parseBody(UsageReportBody, {
      session_id: "cursor-plan",
      model: { display_name: "Cursor Ultra" },
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: 1_762_560_000, period: "included usage, monthly" } },
      limits: [
        { label: "Cursor models", used_percentage: 88, resets_at: 1_762_560_000, resets_on: "2026-11-07" },
        { label: "Other models", used_percentage: 45, resets_at: 1_762_560_000, resets_on: "2026-11-07" },
      ],
      on_demand: "off",
    });
    expect(b?.limits?.map(w => [w.label, w.used_percentage, w.resets_on])).toEqual([
      ["Cursor models", 88, "2026-11-07"],
      ["Other models", 45, "2026-11-07"],
    ]);
    expect(b?.on_demand).toBe("off");
    const bad = parseBody(UsageReportBody, {
      session_id: "cursor-plan",
      rate_limits: { spend_limit: { used_percentage: 85, resets_at: 1_762_560_000 } },
      limits: [{ label: "", used_percentage: 1 }, ...Array.from({ length: 8 }, (_, i) => ({ label: `W${i}`, used_percentage: i + 1 }))],
    });
    expect(bad?.session_id).toBe("cursor-plan");
    expect(bad?.rate_limits?.spend_limit?.used_percentage).toBe(85);
    expect(bad?.limits).toHaveLength(9);
    const wrong = parseBody(UsageReportBody, {
      session_id: "cursor-plan",
      rate_limits: { spend_limit: { used_percentage: 85 } },
      limits: [
        { label: 42, used_percentage: 10 },
        { used_percentage: "50" },
        { label: "Kept", used_percentage: 12, resets_on: 20261107 },
        null,
      ],
      on_demand: `on-demand ${"y".repeat(100)}`,
    });
    expect(wrong?.session_id).toBe("cursor-plan");
    expect(wrong?.rate_limits?.spend_limit?.used_percentage).toBe(85);
    expect(wrong?.on_demand).toBe(`on-demand ${"y".repeat(100)}`);
    expect(wrong?.limits).toHaveLength(4);
  });

  it("an old account frame still parses, and a named one keeps its windows", () => {
    const old = parseBody(AccountUsageSchema, {
      account: "max-1", reportedAt: 1, fiveHour: { usedPercentage: 23.5, resetsAt: 2 }, sevenDay: null, spend: null, sessions: [],
    });
    expect(old).toMatchObject({ account: "max-1", fiveHour: { usedPercentage: 23.5 }, limits: null, onDemand: null });
    const named = parseBody(AccountUsageSchema, {
      account: "cursor", reportedAt: 1, fiveHour: null, sevenDay: null, spend: null, sessions: [],
      limits: [
        { label: "Cursor models", usedPercentage: 88, resetsAt: 2, resetsOn: "2026-11-07" },
        { label: "Other models", usedPercentage: 45, resetsAt: 2, resetsOn: "2026-11-07" },
      ],
      onDemand: "off",
    });
    expect(named?.limits?.map(w => w.label)).toEqual(["Cursor models", "Other models"]);
    expect(named?.onDemand).toBe("off");
  });
});

describe("an account's profile on the wire (ADR-0034)", () => {
  const base = { account: "a3", reportedAt: 1, fiveHour: null, sevenDay: null, spend: null, sessions: [] };

  it("an account carries its profile; one from before profiles decodes with profile null", () => {
    expect(parseBody(AccountUsageSchema, { ...base, profile: { email: "ada@example.test", org: "team", plan: "Max 5x" } })?.profile)
      .toEqual({ email: "ada@example.test", org: "team", plan: "Max 5x" });
    expect(parseBody(AccountUsageSchema, { ...base, fiveHour: { usedPercentage: 23.5, resetsAt: 2 } })?.profile).toBeNull();
  });

  it("a profile with an org that is not one of the two words is dropped, and the account is kept", () => {
    const a = parseBody(AccountUsageSchema, { ...base, profile: { email: "ada@example.test", org: "family", plan: "Max 5x" } });
    expect(a?.account).toBe("a3");
    expect(a?.profile).toBeNull();
  });
});
