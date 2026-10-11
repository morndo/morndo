// Secrets on the wire: review round 4 of PR #25 (board T-80). Each block written failing before its fix.
import { describe, expect, it } from "vitest";
import { StoreSecretBody } from "../src/index.ts";

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
  it("a repeat is named when there is one, beside a length issue or alone", () => {
    expect(issues({ destinations: [...hosts(10), "h0.example.com"] })).toEqual([["too_big", "destinations", ""], ["custom", "destinations", "each host once"]]);
    expect(issues({ grant: { ...grant, modes: ["exec", "file", "helper", "inject", "exec"] } }))
      .toEqual([["too_big", "grant.modes", ""], ["custom", "grant.modes", "each mode once"]]);
    expect(issues({ destinations: ["api.example.com", "api.example.com"] })).toEqual([["custom", "destinations", "each host once"]]);
    expect(issues({ grant: { ...grant, modes: ["exec", "exec"] } })).toEqual([["custom", "grant.modes", "each mode once"]]);
  });
});
