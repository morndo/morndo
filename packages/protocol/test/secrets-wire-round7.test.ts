// Secrets on the wire: review round 1 of PR #31 (PR 2a; board T-88). Each block written failing before its fix.
import { describe, expect, it } from "vitest";
import { SecretsStoreResult } from "../src/index.ts";

describe("round 7, point 1: a node's store result names the Reference it stored under", () => {
  it("the Reference is required and must be one", () => {
    const at = 1_700_000_000_000;
    expect(SecretsStoreResult.safeParse({ reference: "secret://example-app/payments-test", version: 2, at, renewed: false }).success).toBe(true);
    expect(SecretsStoreResult.safeParse({ version: 2, at, renewed: false }).success).toBe(false);
    expect(SecretsStoreResult.safeParse({ reference: "secret://Bad/x", version: 2, at, renewed: false }).success).toBe(false);
  });
});
