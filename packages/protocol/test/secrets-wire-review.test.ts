// Secrets on the wire: the points a review of PR #25 confirmed (ADR-0022, design §14). One block per point, each written
// failing before its fix.
import { describe, expect, it } from "vitest";
import { SecretView, StoreSecretBody } from "../src/index.ts";

const REF = "secret://example-app/payments-test";
const sealed = Buffer.from("age-encryption.org/v1\n-> X25519 c29tZQ\nYWJj\n--- bWFj\n").toString("base64");
const recipient = `age1${"q".repeat(58)}`;
const grant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const body = { requestId: "q1", seen: 1, reference: REF, grant, expiry: null, destinations: ["api.example.com"], targets: [{ node: "node-a", recipient, sealed }] };
const view = {
  node: "node-a", reference: REF, status: "active", version: 1, keyedFingerprint: "0123456789ab", grants: [grant],
  destinations: [], expiry: null, shape: "vendor-token", lastUse: null,
};

describe("review 6: the wire refuses what the domain refuses", () => {
  it("a Grant with a mode twice", () => {
    expect(StoreSecretBody.safeParse(body).success).toBe(true);
    expect(StoreSecretBody.safeParse({ ...body, grant: { ...grant, modes: ["exec", "exec"] } }).success).toBe(false);
  });
  it("a Destination twice", () => {
    expect(StoreSecretBody.safeParse({ ...body, destinations: ["api.example.com", "api.example.com"] }).success).toBe(false);
  });
  it("a shape id outside the domain's grammar (lower case, digits and dashes)", () => {
    expect(SecretView.safeParse(view).success).toBe(true);
    expect(SecretView.safeParse({ ...view, shape: "Vendor_Token" }).success).toBe(false);
  });
});
