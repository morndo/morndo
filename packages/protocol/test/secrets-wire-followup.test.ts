// Secrets on the wire: the follow-ups from the second verify review of PR #25 (board T-72). Each block written failing
// before its fix.
import { describe, expect, it } from "vitest";
import { StoreSecretBody } from "../src/index.ts";

const REF = "secret://example-app/payments-test";
const sealed = Buffer.from("age-encryption.org/v1\n-> X25519 c29tZQ\nYWJj\n--- bWFj\n").toString("base64");
const recipient = `age1${"q".repeat(58)}`;
const grant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const body = { requestId: "q1", seen: 1, reference: REF, grant, expiry: null, destinations: [] as string[], targets: [{ node: "node-a", recipient, sealed }] };
const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);

describe("follow-up 6: a refused list of modes or Destinations names the limit it broke, as a purpose does", () => {
  const issue = (over: Record<string, unknown>) => {
    const r = StoreSecretBody.safeParse({ ...body, ...over });
    return r.success ? null : r.error.issues[0];
  };
  it("eleven Destinations are too many: at most 10", () => {
    expect(issue({ destinations: hosts(11) })).toMatchObject({ code: "too_big", maximum: 10, path: ["destinations"] });
  });
  it("no mode is too few: at least 1", () => {
    expect(issue({ grant: { ...grant, modes: [] } })).toMatchObject({ code: "too_small", minimum: 1, path: ["grant", "modes"] });
  });
  it("five modes are more than there are: at most 4", () => {
    expect(issue({ grant: { ...grant, modes: ["exec", "file", "helper", "inject", "exec"] } }))
      .toMatchObject({ code: "too_big", maximum: 4, path: ["grant", "modes"] });
  });
  it("a repeat within the limits is the each-once rule", () => {
    expect(issue({ destinations: ["api.example.com", "api.example.com"] })).toMatchObject({ code: "custom", message: "each host once", path: ["destinations"] });
    expect(issue({ grant: { ...grant, modes: ["exec", "exec"] } })).toMatchObject({ code: "custom", message: "each mode once", path: ["grant", "modes"] });
  });
  it("ten different hosts and the four modes once each pass", () => {
    expect(StoreSecretBody.safeParse({ ...body, destinations: hosts(10), grant: { ...grant, modes: ["exec", "file", "helper", "inject"] } }).success).toBe(true);
  });
});
