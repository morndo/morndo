// Secrets on the wire: the verify review of PR #25's fix round. Each block written failing before its fix.
import { describe, expect, it } from "vitest";
import { hostsOk, modesOk, type UseMode } from "@morndo/domain";
import { SecretRequestedEvent, StoreSecretBody } from "../src/index.ts";

const REF = "secret://example-app/payments-test";
const sealed = Buffer.from("age-encryption.org/v1\n-> X25519 c29tZQ\nYWJj\n--- bWFj\n").toString("base64");
const recipient = `age1${"q".repeat(58)}`;
const grant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const body = { requestId: "q1", seen: 1, reference: REF, grant, expiry: null, destinations: [] as string[], targets: [{ node: "node-a", recipient, sealed }] };

describe("verify 9: a Grant's modes and the Destinations pass the wire exactly when the domain's rules do", () => {
  it("modes", () => {
    const samples: string[][] = [["exec"], ["exec", "file"], ["exec", "exec"], [], ["exec", "file", "helper", "inject"], ["print"], ["file", "file", "exec"]];
    for (const m of samples) {
      expect(StoreSecretBody.safeParse({ ...body, grant: { ...grant, modes: m } }).success, m.join(",")).toBe(modesOk(m as UseMode[]));
    }
  });
  it("destinations", () => {
    const samples: string[][] = [[], ["api.example.com"], ["api.example.com", "api.example.com"], ["API.example.com"], Array.from({ length: 11 }, (_, i) => `h${i}.example.com`)];
    for (const h of samples) {
      expect(StoreSecretBody.safeParse({ ...body, destinations: h }).success, h.join(",")).toBe(hostsOk(h));
    }
  });
});

describe("verify 10: a purpose the wire refuses says why", () => {
  const requested = { node: "node-a", reference: REF, kind: "new", lane: null, workspace: null, purpose: "p", proposed: grant };
  const issue = (purpose: string) => {
    const r = SecretRequestedEvent.safeParse({ ...requested, purpose });
    return r.success ? null : r.error.issues[0];
  };
  it("too long names its limit", () => {
    expect(issue("x".repeat(301))).toMatchObject({ code: "too_big", maximum: 300, path: ["purpose"] });
  });
  it("empty is too small", () => {
    expect(issue("")).toMatchObject({ code: "too_small", minimum: 1, path: ["purpose"] });
  });
  it("a control character is the plain-text rule", () => {
    expect(issue("a\u0007b")).toMatchObject({ code: "custom", message: "plain text", path: ["purpose"] });
  });
});
