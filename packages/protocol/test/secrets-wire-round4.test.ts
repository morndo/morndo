// Secrets on the wire: review round 4 of PR #25 (board T-80). Each block written failing before its fix.
import { describe, expect, it } from "vitest";
import { SecretsStoreArgs, SecretsStoreResult, StoreSecretBody } from "../src/index.ts";

const REF = "secret://example-app/payments-test";
const sealed = Buffer.from("age-encryption.org/v1\n-> X25519 c29tZQ\nYWJj\n--- bWFj\n").toString("base64");
const recipient = `age1${"q".repeat(58)}`;
const grant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const body = { requestId: "q1", seen: 1, reference: REF, grant, expiry: null, destinations: [] as string[], targets: [{ node: "node-a", recipient, sealed }] };
const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);

// Every issue, not just the first: its code, where, and for the each-once rule its words.
const issues = (over: Record<string, unknown>) => {
  const r = StoreSecretBody.safeParse({ ...body, ...over });
  return r.success ? [] : r.error.issues.map(i => [i.code, i.path.join("."), i.code === "custom" ? i.message : ""]);
};

describe("round 4, point 3: a refused list of modes or Destinations has only the issues that are true", () => {
  it("eleven different hosts: too many, and nothing about repeats", () => {
    expect(issues({ destinations: hosts(11) })).toEqual([["too_big", "destinations", ""]]);
  });
  it("no mode: too few, and nothing about repeats", () => {
    expect(issues({ grant: { ...grant, modes: [] } })).toEqual([["too_small", "grant.modes", ""]]);
  });
  it("a malformed host: its own format issue, and nothing about repeats", () => {
    expect(issues({ destinations: ["API.example.com"] })).toEqual([["invalid_format", "destinations.0", ""]]);
  });
  it("a repeat is named when there is one within the bounds", () => {
    expect(issues({ destinations: ["api.example.com", "api.example.com"] })).toEqual([["custom", "destinations", "each host once"]]);
    expect(issues({ grant: { ...grant, modes: ["exec", "exec"] } })).toEqual([["custom", "grant.modes", "each mode once"]]);
  });
  // zod 4.6.6 and later stop at an oversized list before any element or rule runs (colinhacks/zod#6652), so a repeat
  // beside a length issue is no longer named there; what stays true under any zod is that the length issue is reported.
  it("a list over its bound reports its length issue, whatever else it holds", () => {
    expect(issues({ destinations: [...hosts(10), "h0.example.com"] })).toContainEqual(["too_big", "destinations", ""]);
    expect(issues({ grant: { ...grant, modes: ["exec", "file", "helper", "inject", "exec"] } })).toContainEqual(["too_big", "grant.modes", ""]);
  });
});

describe("round 4, points 1 and 2: secrets.store carries the request it answers, with its kind (decided on T-80)", () => {
  const args = { reference: REF, sealed, grants: [grant], expiry: null, destinations: [] as string[] };
  it("a store for a renew request names the request and its kind", () => {
    expect(SecretsStoreArgs.safeParse({ ...args, expiry: 1_700_000_000_000, request: { id: "q1", kind: "renew" } }).success).toBe(true);
    expect(SecretsStoreArgs.safeParse({ ...args, request: { id: "q1", kind: "new" } }).success).toBe(true);
  });
  it("a store from the Secrets page or the machine names none", () => {
    expect(SecretsStoreArgs.safeParse({ ...args, request: null }).success).toBe(true);
  });
  it("a request without its kind, an access request, or no request key at all is refused", () => {
    expect(SecretsStoreArgs.safeParse({ ...args, request: "q1" }).success).toBe(false);
    expect(SecretsStoreArgs.safeParse({ ...args, request: { id: "q1" } }).success).toBe(false);
    expect(SecretsStoreArgs.safeParse({ ...args, request: { id: "q1", kind: "access" } }).success).toBe(false);
    expect(SecretsStoreArgs.safeParse(args).success).toBe(false);
  });
});

describe("round 5, point 3: a node confirms a store with its version and its own time of the store (T-83)", () => {
  it("names both, and nothing else", () => {
    expect(SecretsStoreResult.safeParse({ reference: REF, version: 2, at: 1_700_000_000_000, renewed: false }).success).toBe(true);
    expect(SecretsStoreResult.safeParse({ reference: REF, version: 2 }).success).toBe(false);
    expect(SecretsStoreResult.safeParse({ reference: REF, version: 0, at: 1_700_000_000_000, renewed: false }).success).toBe(false);
    expect(SecretsStoreResult.safeParse({ reference: REF, version: 2, at: 1_700_000_000_000, renewed: false, expiry: 1 }).success).toBe(false);
  });
});
