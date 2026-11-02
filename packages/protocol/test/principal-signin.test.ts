// The principal's proof for a sign-in (ADR-0039): signin.start and signin.code carry the hub's signed assertion for
// exactly one node and one sign-in id, like update.apply for one node and one Version, so the fleet's owner socket
// alone cannot start a sign-in or send a code.
import { describe, expect, it } from "vitest";
import { PrincipalAssertionSchema, parsePrincipalAssertion, principalPayloadText, type PrincipalAssertion } from "../src/principal.ts";

const NONCE = "ABCDEFGHIJKLMNOPQRSTUV";
const start: PrincipalAssertion = { op: "signin.start", node: "n1", signin: "si-abc", exp: 1_791_000_030_000, nonce: NONCE };

describe("a sign-in's proof", () => {
  it("is one canonical spelling: op, signin, node, exp, nonce; and parses back to itself", () => {
    expect(principalPayloadText(start)).toBe(`{"op":"signin.start","signin":"si-abc","node":"n1","exp":1791000030000,"nonce":"${NONCE}"}`);
    expect(parsePrincipalAssertion(principalPayloadText(start))).toEqual(start);
    expect(parsePrincipalAssertion(principalPayloadText({ ...start, op: "signin.code" }))).toEqual({ ...start, op: "signin.code" });
  });

  it("names a node and a sign-in id and no Version; the update proofs name no sign-in", () => {
    const ok = (a: unknown) => PrincipalAssertionSchema.safeParse(a).success;
    expect(ok(start)).toBe(true);
    expect(ok({ ...start, node: undefined })).toBe(false);
    expect(ok({ op: "signin.start", node: "n1", exp: 1, nonce: NONCE })).toBe(false);
    expect(ok({ ...start, version: "0.4.2" })).toBe(false);
    expect(ok({ ...start, signin: "not-an-id" })).toBe(false);
    expect(ok({ op: "update.apply", version: "0.4.2", node: "n1", signin: "si-abc", exp: 1, nonce: NONCE })).toBe(false);
    expect(ok({ op: "rollout.resume", version: "0.4.2", exp: 1, nonce: NONCE })).toBe(true);
    expect(ok({ op: "update.apply", version: "0.4.2", node: "n1", exp: 1, nonce: NONCE })).toBe(true);
  });
});
