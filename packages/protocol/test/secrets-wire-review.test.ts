// Secrets on the wire: the points a review of PR #25 confirmed (ADR-0022, design §14). One block per point, each written
// failing before its fix.
import { describe, expect, it } from "vitest";
import {
  DESTINATION_HOST, KEYED_FINGERPRINT, LANE_NAME, NODE_LABEL, SHAPE_ID, USE_REFUSAL_REASONS, WORKSPACE_NAME, plainText,
} from "@morndo/domain";
import {
  ED25519_SIGNATURE, SecretRequestedEvent, SecretView, SecretsCheckArgs, SecretsCheckResult, SecretsTransferArgs, StoreSecretBody,
} from "../src/index.ts";

const REF = "secret://example-app/payments-test";
const sealed = Buffer.from("age-encryption.org/v1\n-> X25519 c29tZQ\nYWJj\n--- bWFj\n").toString("base64");
const recipient = `age1${"q".repeat(58)}`;
const grant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const body = { requestId: "q1", seen: 1, reference: REF, grant, expiry: null, destinations: ["api.example.com"], targets: [{ node: "node-a", recipient, sealed }] };
const view = {
  node: "node-a", reference: REF, status: "active", version: 1, keyedFingerprint: "000000000000", grants: [grant],
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

describe("review 8: the wire takes its rules from the domain, not from copies", () => {
  const samples = [
    "lane-a", "Lane.A_1", "example-app", "Example", "a b", "-x", "x", "x".repeat(63), "x".repeat(64), "x".repeat(65),
    "api.example.com", "API.example.com", "a..b", "0123456789ab", "0123456789AB", "vendor-token", "vendor_token", "node-a.local", "",
  ];
  it("the check's refusal reasons are the domain's, and nothing else", () => {
    expect(USE_REFUSAL_REASONS.length).toBeGreaterThan(0);
    for (const r of USE_REFUSAL_REASONS) expect(SecretsCheckResult.safeParse({ admitted: false, reason: r }).success, r).toBe(true);
    expect(SecretsCheckResult.safeParse({ admitted: false, reason: "other" }).success).toBe(false);
  });
  it("lanes, workspaces, nodes, hosts, fingerprints and shape ids pass exactly when the domain's rule does", () => {
    for (const t of samples) {
      expect(SecretsCheckArgs.safeParse({ reference: REF, lane: t, workspace: null, mode: "exec" }).success, `lane ${t}`).toBe(LANE_NAME.test(t));
      expect(SecretsCheckArgs.safeParse({ reference: REF, lane: null, workspace: t, mode: "exec" }).success, `workspace ${t}`).toBe(WORKSPACE_NAME.test(t));
      expect(SecretRequestedEvent.safeParse({ node: t, reference: REF, kind: "new", lane: null, workspace: null, purpose: "p", proposed: grant }).success, `node ${t}`).toBe(NODE_LABEL.test(t));
      expect(SecretView.safeParse({ ...view, destinations: [t] }).success, `host ${t}`).toBe(DESTINATION_HOST.test(t));
      expect(SecretView.safeParse({ ...view, keyedFingerprint: t }).success, `fingerprint ${t}`).toBe(KEYED_FINGERPRINT.test(t));
      expect(SecretView.safeParse({ ...view, shape: t }).success, `shape ${t}`).toBe(SHAPE_ID.test(t));
    }
  });
  it("a purpose passes exactly when the domain's plain-text rule does", () => {
    for (const t of ["p", "x".repeat(300), "x".repeat(301), "", "a\u0007b", "a\u009bb", "tab\there"]) {
      expect(SecretRequestedEvent.safeParse({ node: "node-a", reference: REF, kind: "new", lane: null, workspace: null, purpose: t, proposed: grant }).success, JSON.stringify(t)).toBe(plainText(t, 300));
    }
  });
  it("a transfer's signature is the fleet's Ed25519 signature", () => {
    const sig = `${"A".repeat(86)}==`;
    expect(ED25519_SIGNATURE.test(sig)).toBe(true);
    expect(SecretsTransferArgs.safeParse({ reference: REF, target: "node-b", recipient, signature: sig }).success).toBe(true);
    expect(SecretsTransferArgs.safeParse({ reference: REF, target: "node-b", recipient, signature: "short" }).success).toBe(false);
  });
});
