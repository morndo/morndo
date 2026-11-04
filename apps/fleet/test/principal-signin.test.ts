// The fleet's check of a sign-in's proof (ADR-0039): signin.start and signin.code are forwarded only with the hub's signed
// assertion for exactly that node and sign-in id; status, accounts and cancel need none. A lost answer to a code or a
// cancel reads as "may have run" (a side effect), never as "not run", so nothing retries a code on a guess.
import { generateKeyPairSync, randomBytes, sign as signEd } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PRINCIPAL_HEADER, PRINCIPAL_SIGN_PREFIX, encodePrincipalHeader, principalPayloadText, type PrincipalAssertion } from "@morndo/protocol";
import { SIDE_EFFECT_OPS } from "../src/application/requests.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

describe("a sign-in's proof at the fleet", () => {
  const hub = generateKeyPairSync("ed25519");
  const principalKey = (hub.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const headerOf = (a: PrincipalAssertion): Record<string, string> => {
    const text = principalPayloadText(a);
    return { [PRINCIPAL_HEADER]: encodePrincipalHeader(text, new Uint8Array(signEd(null, Buffer.from(PRINCIPAL_SIGN_PREFIX + text), hub.privateKey))) };
  };

  it("forwards signin.start and signin.code only with the proof for that node and id; the others need none", async () => {
    const now = Date.UTC(2026, 10, 2);
    const fleet = await startTestFleet({ config: { principalKey }, now: () => now });
    const n1 = await fleet.online("n1");
    const ask = (op: "signin.start" | "signin.code", over: Partial<PrincipalAssertion> = {}): PrincipalAssertion =>
      ({ op, node: "n1", signin: "si-one", exp: now + 30_000, nonce: randomBytes(16).toString("base64url"), ...over });
    const post = (body: unknown, headers: Record<string, string> = {}) => client(fleet.config.socketPath, headers).post("/v1/op", body);
    const startBody = { node: "n1", op: "signin.start", args: { id: "si-one", runtime: "claude", account: "a1", create: false }, key: "hub:signin:si-one" };
    const codeBody = { node: "n1", op: "signin.code", args: { id: "si-one", sealed: "YWdl" } };
    const refused = { ok: false, error: { code: "not_allowed", executed: "no" } };
    expect((await post(startBody))?.body).toMatchObject(refused);
    expect((await post(startBody, headerOf(ask("signin.start", { signin: "si-two" }))))?.body).toMatchObject(refused);
    expect((await post(startBody, headerOf(ask("signin.start", { node: "n2" }))))?.body).toMatchObject(refused);
    expect((await post(startBody, headerOf(ask("signin.code"))))?.body).toMatchObject(refused);
    expect((await post(codeBody))?.body).toMatchObject(refused);
    expect(n1.reqs.filter(r => r.op.startsWith("signin."))).toHaveLength(0);
    expect((await post(startBody, headerOf(ask("signin.start"))))?.body).toMatchObject({ ok: true });
    expect((await post(codeBody, headerOf(ask("signin.code"))))?.body).toMatchObject({ ok: true });
    expect((await post({ node: "n1", op: "signin.status", args: { id: "si-one" } }))?.body).toMatchObject({ ok: true });
    expect((await post({ node: "n1", op: "signin.accounts", args: { runtime: "claude" } }))?.body).toMatchObject({ ok: true });
    expect((await post({ node: "n1", op: "signin.cancel", args: { id: "si-one" } }))?.body).toMatchObject({ ok: true });
    expect(n1.reqs.filter(r => r.op.startsWith("signin.")).map(r => r.op)).toEqual(["signin.start", "signin.code", "signin.status", "signin.accounts", "signin.cancel"]);
  });

  it("counts signin.start, signin.code and signin.cancel as side effects", () => {
    for (const op of ["signin.start", "signin.code", "signin.cancel"] as const) expect(SIDE_EFFECT_OPS.has(op), op).toBe(true);
  });
});
