// Secrets on the wire: review round 6 of PR #25, the first commits of PR 2 (board T-85). Each block written failing
// before its fix.
import { describe, expect, it } from "vitest";
import { SecretsStoreResult } from "../src/index.ts";

describe("round 6, points 1, 2 and 7: a node's store result says whether the renew rule held there", () => {
  it("renewed is a boolean, and always present", () => {
    const reference = "secret://example-app/payments-test";
    expect(SecretsStoreResult.safeParse({ reference, version: 2, at: 1_700_000_000_000, renewed: true }).success).toBe(true);
    expect(SecretsStoreResult.safeParse({ reference, version: 2, at: 1_700_000_000_000 }).success).toBe(false);
    expect(SecretsStoreResult.safeParse({ reference, version: 2, at: 1_700_000_000_000, renewed: "yes" }).success).toBe(false);
  });
});
