// The lease wire (S5, plan 4.4, U16): what a node asks before a rationed read, what a failure may carry, and the
// closed shape of the hub's answer. Synthetic data only.
import { describe, expect, it } from "vitest";
import { UsageLeaseAnswer, UsageLeaseBody, UsageReadingsBody } from "../src/usage.ts";

describe("the usage lease wire", () => {
  it("takes an account, a known source and an optional node", () => {
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "claude-usage", node: "pc" }).success).toBe(true);
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "claude-usage" }).success).toBe(true);
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "claude-usage", node: null }).success).toBe(true);
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "vendor-api", node: "x".repeat(80) }).success).toBe(true);
  });

  it("refuses a bad account, an unknown source and a node past 80 characters", () => {
    expect(UsageLeaseBody.safeParse({ account: "", source: "claude-usage" }).success).toBe(false);
    expect(UsageLeaseBody.safeParse({ account: "x".repeat(81), source: "claude-usage" }).success).toBe(false);
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "claude-headless" }).success).toBe(false);
    expect(UsageLeaseBody.safeParse({ account: "seat-a", source: "claude-usage", node: "x".repeat(81) }).success).toBe(false);
  });

  it("a failure may carry retry_after_s, whole seconds, one day at most", () => {
    const withRetry = UsageReadingsBody.safeParse({
      source: "claude-usage", captured_at: 1, failure: { reason: "rate_limited", retry_after_s: 120 },
    });
    expect(withRetry.success).toBe(true);
    if (withRetry.success) expect(withRetry.data.failure?.retry_after_s).toBe(120);
    expect(UsageReadingsBody.safeParse({
      source: "claude-usage", captured_at: 1, failure: { reason: "rate_limited", retry_after_s: null },
    }).success).toBe(true);
    expect(UsageReadingsBody.safeParse({
      source: "claude-usage", captured_at: 1, failure: { reason: "rate_limited", retry_after_s: -1 },
    }).success).toBe(false);
    expect(UsageReadingsBody.safeParse({
      source: "claude-usage", captured_at: 1, failure: { reason: "rate_limited", retry_after_s: 86401 },
    }).success).toBe(false);
  });

  it("the answer carries only its status and the fields that status owns, in seconds", () => {
    expect(UsageLeaseAnswer.safeParse({ status: "granted", lease_id: "lease-1-aabb", expires_at: 1761234567 }).success).toBe(true);
    expect(UsageLeaseAnswer.safeParse({ status: "fresh", captured_at: 1761234567 }).success).toBe(true);
    expect(UsageLeaseAnswer.safeParse({ status: "denied", reason: "busy", retry_after_s: 42 }).success).toBe(true);
    expect(UsageLeaseAnswer.safeParse({ status: "held" }).success).toBe(false);
    expect(UsageLeaseAnswer.safeParse({ status: "denied", reason: "on_fire", retry_after_s: 1 }).success).toBe(false);
    // A granted lease id is short and opaque: an id past 80 characters is not this hub's answer.
    expect(UsageLeaseAnswer.safeParse({ status: "granted", lease_id: "x".repeat(81), expires_at: 1 }).success).toBe(false);
  });
});
