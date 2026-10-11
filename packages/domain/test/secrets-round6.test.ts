// Secrets: review round 6 of PR #25, the first commits of PR 2 (board T-85). One block per point, each written failing
// before its fix. Names, nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_SKEW_MS, answerStored, disableSecret, emptySecretDirectory, findSecret, openRequest, renewSecret, revokeSecret,
  storeSecret,
  type Actor, type RequestKind, type SecretGrant,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const who: Actor = { kind: "principal", command: "c1" };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};
const refusal = <X>(r: R<X>) => (r.ok ? "stored" : r.error);
const input = (expiry: number | null, fingerprint = "0000000000f2") =>
  ({ reference: REF, fingerprint, shape: null, grants: [], expiry, destinations: [] });
const held = (expiry: number | null = T - DAY) =>
  value(storeSecret(emptySecretDirectory(), { ...input(expiry, "0000000000f1"), grants: [nodeGrant] }, who, T - 10 * DAY));

describe("round 6, point 3: a renew never revives a revoked Secret, and a disabled one is not reported renewed", () => {
  it("a revoked Secret is refused as revoked and stays revoked", () => {
    const revoked = value(revokeSecret(held(), REF, who, T - 1));
    expect(refusal(renewSecret(revoked, input(T + DAY), who, T))).toEqual({ problem: "revoked" });
    expect(findSecret(revoked, REF)?.status).toBe("revoked");
  });
  it("a disabled Secret is refused as disabled, since every Use of it is still refused", () => {
    const disabled = value(disableSecret(held(), REF, { kind: "operator" }, T - 1));
    expect(refusal(renewSecret(disabled, input(T + DAY), who, T))).toEqual({ problem: "disabled" });
  });
  it("an active one still renews", () => {
    const dir = value(renewSecret(held(), input(T + DAY), who, T));
    expect([findSecret(dir, REF)?.status, findSecret(dir, REF)?.expiry]).toEqual(["active", T + DAY]);
  });
});

describe("round 6, point 4: a renew names the missing Reference before its Expiry, the problem the principal can act on", () => {
  it("an unheld Reference is missing, whatever Expiry the renew names", () => {
    for (const expiry of [null, T - DAY, T + DAY]) expect(refusal(renewSecret(emptySecretDirectory(), input(expiry), who, T))).toEqual({ problem: "missing" });
  });
  it("a held one with no Expiry, or a passed one, is still a renew's Expiry problem", () => {
    expect(refusal(renewSecret(held(), input(null), who, T))).toEqual({ problem: "renew_expiry" });
    expect(refusal(renewSecret(held(), input(T - 1), who, T))).toEqual({ problem: "renew_expiry" });
  });
});

describe("round 6, point 5: only { keep: true } keeps the shape; a near miss is refused, never a stale keep", () => {
  const first = () => value(storeSecret(emptySecretDirectory(), { ...input(null, "0000000000f1"), shape: "shape-a" }, who, T));
  const rotate = (shape: unknown) => {
    const r = storeSecret(first(), { ...input(null), shape: shape as null }, who, T + 1);
    return r.ok ? findSecret(r.value, REF)?.shape : r.error.problem;
  };
  it("a keep that isn't true, or with another key beside it, is refused", () => {
    for (const s of [{ keep: "false" }, { keep: 1 }, { keep: "true" }, { keep: true, id: "shape-b" }, {}]) expect(rotate(s), JSON.stringify(s)).toBe("bad_shape");
  });
  it("exactly { keep: true } keeps it", () => {
    expect(rotate({ keep: true })).toBe("shape-a");
  });
});

describe("round 6, points 1, 2 and 7: a renew is Stored on the requester node's own confirmation that the renew rule held", () => {
  const opened = (kind: RequestKind = "renew") => value(openRequest({
    node: "node-a", reference: REF, kind, waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T - DAY)).request;
  const confirm = (over: Partial<{ reference: string; node: string; version: number; at: number; renewed: boolean }> = {}) =>
    ({ reference: REF, node: "node-a", version: 2, at: T, renewed: true, ...over });
  const answer = (kind: RequestKind, confirmation: ReturnType<typeof confirm>, nodes = ["node-a", "node-b"], expiry: number | null = T + 30 * DAY) =>
    answerStored(opened(kind), { seen: 1, command: "c2", reference: REF, nodes, expiry, confirmation }, T + 60_000);
  const state = (r: ReturnType<typeof answer>) => (r.ok ? r.value.request.state : r.error.problem);

  it("the requester node's confirmation that it renewed answers the renew, and carries its version", () => {
    const r = answer("renew", confirm());
    expect(state(r)).toBe("stored");
    expect(r.ok && r.value.events[0]).toMatchObject({ type: "SecretRequestStored", version: 2, nodes: ["node-a", "node-b"] });
  });
  it("point 1: another node's confirmation never stands in for the requester's", () => {
    expect(state(answer("renew", confirm({ node: "node-b" })))).toBe("node");
    expect(state(answer("new", confirm({ node: "node-b", renewed: false })))).toBe("node");
  });
  it("point 2: the node's time of the store lies between the request's opening and the hub's now, five minutes either way", () => {
    expect(CONFIRMATION_SKEW_MS).toBe(5 * 60_000);
    for (const at of [0, Number.NaN, Number.POSITIVE_INFINITY, T - DAY - CONFIRMATION_SKEW_MS - 1, T + 60_000 + CONFIRMATION_SKEW_MS + 1]) {
      expect(state(answer("renew", confirm({ at }))), String(at)).toBe("clock");
    }
    expect(state(answer("renew", confirm({ at: T - DAY - CONFIRMATION_SKEW_MS })))).toBe("stored");
    expect(state(answer("renew", confirm({ at: T + 60_000 + CONFIRMATION_SKEW_MS })))).toBe("stored");
  });
  it("point 7: a confirmation from a store that skipped the renew rule leaves the renew open", () => {
    expect(state(answer("renew", confirm({ renewed: false })))).toBe("not_renewed");
  });
  it("the other kinds that store need no renew", () => {
    expect(state(answer("new", confirm({ renewed: false }), ["node-a"], null))).toBe("stored");
    expect(state(answer("rotate", confirm({ renewed: false }), ["node-a"], null))).toBe("stored");
  });
});
