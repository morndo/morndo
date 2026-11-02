// Sign-in from the app (ADR-0039): the wire shapes. Locked by the keryx run app-sign-in.
import { describe, expect, it } from "vitest";
import { KEYED_OPS, OP_ARGS, OP_NAMES, OP_RESULTS, STEP_UP_OPS } from "../src/fleet.ts";
import { RequestSignInBody, SEALED_MAX, SignInCodeBody, SignInViewSchema, StartSignInBody } from "../src/signin.ts";

describe("sign-in wire shapes (ADR-0039)", () => {
  it("declares five node ops; start is keyed; start and code need a fresh passkey", () => {
    for (const op of ["signin.accounts", "signin.start", "signin.code", "signin.status", "signin.cancel"] as const) {
      expect(OP_NAMES).toContain(op);
      expect(OP_ARGS[op]).toBeDefined();
      expect(OP_RESULTS[op]).toBeDefined();
    }
    expect(KEYED_OPS.has("signin.start")).toBe(true);
    expect(KEYED_OPS.has("signin.code")).toBe(false);
    expect(STEP_UP_OPS.has("signin.start")).toBe(true);
    expect(STEP_UP_OPS.has("signin.code")).toBe(true);
  });

  it("takes a start body with a known runtime and a pool-style account name", () => {
    expect(StartSignInBody.parse({ node: "n1", runtime: "claude", account: "a8", create: true })).toEqual({ node: "n1", runtime: "claude", account: "a8", create: true });
    expect(StartSignInBody.parse({ node: "n1", runtime: "cursor", account: "main" }).create).toBe(false);
    expect(StartSignInBody.safeParse({ node: "n1", runtime: "codex", account: "a1" }).success).toBe(false);
    expect(StartSignInBody.safeParse({ node: "n1", runtime: "claude", account: "../a1" }).success).toBe(false);
    expect(StartSignInBody.safeParse({ node: "n1", runtime: "claude", account: "a1", extra: 1 }).success).toBe(false);
  });

  it("takes only a sealed code: base64, at most SEALED_MAX characters, never a plain field", () => {
    expect(SignInCodeBody.safeParse({ sealed: "YWdlLWVuY3J5cHRpb24=" }).success).toBe(true);
    expect(SignInCodeBody.safeParse({ sealed: "a".repeat(SEALED_MAX + 4) }).success).toBe(false);
    expect(SignInCodeBody.safeParse({ code: "plain-code" }).success).toBe(false);
    expect(SignInCodeBody.safeParse({ sealed: "not base64 !" }).success).toBe(false);
    expect(OP_ARGS["signin.code"].safeParse({ id: "si-1", sealed: "YWdl" }).success).toBe(true);
    expect(OP_ARGS["signin.code"].safeParse({ id: "si-1", code: "plain" }).success).toBe(false);
  });

  it("lets an agent ask for a card with a reason, and nothing more", () => {
    expect(RequestSignInBody.parse({ node: "n1", runtime: "claude", account: "a9", create: true, why: "one account left in the pool" }).why)
      .toBe("one account left in the pool");
    expect(RequestSignInBody.safeParse({ node: "n1", runtime: "claude", account: "a9" }).success).toBe(false);
  });

  it("has no field for a code or a token in the view the app reads (SI6)", () => {
    expect(Object.keys(SignInViewSchema.shape).sort()).toEqual([
      "account", "create", "expiresAt", "id", "identity", "link", "needsCode", "node", "phase", "problem", "recipient", "runtime", "startedAt", "userCode",
    ]);
  });
});
