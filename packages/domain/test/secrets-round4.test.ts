// Secrets: review round 4 of PR #25 (board T-80). One block per point, each written failing before its fix. Names, nodes
// and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  answerStored, emptySecretDirectory, findSecret, joinRequest, openRequest, receiveTransfer, renewSecret, secretExpirySweep, storeSecret,
  useGate, withdrawRequest,
  type Actor, type RequestAsk, type SecretDirectory, type SecretGrant,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REF = "secret://example-app/payments-test";
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const who: Actor = { kind: "principal", command: "c1" };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

describe("round 4, point 4: a store names the new value's shape, or none, which clears the old one; leaving it out keeps it", () => {
  const first = () => value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000a1", shape: "shape-a", grants: [nodeGrant], expiry: null, destinations: [] }, who, T));
  const rotate = (dir: SecretDirectory, shape: string | null) =>
    value(storeSecret(dir, { reference: REF, fingerprint: "0000000000a2", shape, grants: [], expiry: null, destinations: [] }, who, T + 1));
  it("a Rotation to a value that matches no shape clears it, so nothing looks for the old format", () => {
    expect(findSecret(rotate(first(), null), REF)?.shape).toBeNull();
  });
  it("a transfer of a value that matches no shape clears it on the target", () => {
    const dir = value(receiveTransfer(first(), { reference: REF, fingerprint: "0000000000a2", shape: null, grants: [], expiry: null, destinations: [], from: "node-b" }, who, T + 1));
    expect(findSecret(dir, REF)?.shape).toBeNull();
  });
  it("a first store that says to keep the shape has none", () => {
    const dir = value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000a1", shape: { keep: true }, grants: [], expiry: null, destinations: [] }, who, T));
    expect(findSecret(dir, REF)?.shape).toBeNull();
  });
});

describe("round 4, point 5: the withdrawal that ends a request names its waiter, as a Left does", () => {
  const ask = (lane: string | null, workspace: string | null): RequestAsk => ({
    node: "node-a", reference: REF, kind: "new", waiter: { lane, workspace, purpose: "Nightly job" }, proposed: nodeGrant,
  });
  it("of two callers without a lane, the audit shows which one ended it", () => {
    let r = value(openRequest(ask(null, "app-a"), "r1", T)).request;
    r = value(joinRequest(r, { lane: null, workspace: "app-b", purpose: "Deploy" }, T + 1)).request;
    r = value(withdrawRequest(r, { lane: null, workspace: "app-a" }, T + 2)).request;
    const ended = value(withdrawRequest(r, { lane: null, workspace: "app-b" }, T + 3));
    expect(ended.request.state).toBe("withdrawn");
    expect(ended.events).toEqual([{ type: "SecretRequestWithdrawn", request: "r1", lane: null, workspace: "app-b", at: T + 3 }]);
  });
  it("a lane is named with the workspace the request recorded for it", () => {
    const r = value(openRequest(ask("lane-a", "example-app"), "r1", T)).request;
    const ended = value(withdrawRequest(r, { lane: "lane-a", workspace: null }, T + 1));
    expect(ended.events).toEqual([{ type: "SecretRequestWithdrawn", request: "r1", lane: "lane-a", workspace: "example-app", at: T + 1 }]);
  });
});

describe("round 4, points 1 and 2: the node renews only with an Expiry later than now and than the current one (decided on T-80)", () => {
  const input = (expiry: number | null, fingerprint = "0000000000b2") =>
    ({ reference: REF, fingerprint, shape: null, grants: [], expiry, destinations: [] });
  const held = (expiry: number | null) =>
    value(storeSecret(emptySecretDirectory(), { ...input(expiry, "0000000000b1"), grants: [nodeGrant] }, who, T - 10 * DAY));
  const refusal = <X>(r: R<X>) => (r.ok ? "stored" : r.error);

  it("a renew that would shorten the Expiry is refused before anything is stored", () => {
    expect(refusal(renewSecret(held(T + 5 * DAY), input(T + HOUR), who, T))).toEqual({ problem: "renew_expiry" });
  });
  it("so is one that names no Expiry, the same one, or one later than the current one that has still passed", () => {
    const dir = held(T - DAY);
    expect(refusal(renewSecret(dir, input(null), who, T))).toEqual({ problem: "renew_expiry" });
    expect(refusal(renewSecret(dir, input(T - DAY), who, T))).toEqual({ problem: "renew_expiry" });
    expect(refusal(renewSecret(dir, input(T - HOUR), who, T))).toEqual({ problem: "renew_expiry" });
  });
  it("a later Expiry renews: a new version, the Expiry recorded, the warnings cleared, usable again", () => {
    let dir = secretExpirySweep(held(T - DAY), T);
    dir = value(renewSecret(dir, input(T + 30 * DAY), who, T + 1));
    const s = findSecret(dir, REF);
    expect([s?.current?.number, s?.expiry, s?.warned]).toEqual([2, T + 30 * DAY, []]);
    expect(dir.events.slice(-2).map(e => e.type)).toEqual(["SecretRotated", "ExpiryChanged"]);
    expect(useGate(s, { lane: null, workspace: null }, "exec", T + 2).ok).toBe(true);
  });
  it("on a node that holds no such Secret, a renew is refused: renewing is a Rotation of a Secret the node holds", () => {
    expect(refusal(renewSecret(emptySecretDirectory(), input(null), who, T))).toEqual({ problem: "renew_expiry" });
    expect(refusal(renewSecret(emptySecretDirectory(), input(T + DAY), who, T))).toEqual({ problem: "missing" });
  });
  it("only the principal renews", () => {
    expect(refusal(renewSecret(held(T - DAY), input(T + DAY), { kind: "operator" }, T))).toEqual({ problem: "principal" });
  });
});

describe("round 4, points 2 and 6: the hub's answer always names the Expiry its store sent (decided on T-80)", () => {
  const renew = value(openRequest({
    node: "node-a", reference: REF, kind: "renew", waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T)).request;
  it("an answer that leaves the Expiry out does not compile, so none is refused by accident; one that names none is refused", () => {
    // @ts-expect-error: the Expiry is required, null when the store named none.
    const left = answerStored(renew, { seen: 1, command: "c2", reference: REF, version: 2, nodes: ["node-a"] }, T + 1);
    expect(left.ok ? "ok" : left.error.problem).toBe("expiry");
    const none = answerStored(renew, { seen: 1, command: "c2", reference: REF, version: 2, nodes: ["node-a"], expiry: null, storedAt: T + 1 }, T + 1);
    expect(none.ok ? "ok" : none.error.problem).toBe("expiry");
  });
});

describe("round 5, point 4: a renew's input is checked as a store's is, before the renew rule", () => {
  const held = () =>
    value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000c1", shape: null, grants: [nodeGrant], expiry: T - DAY, destinations: [] }, who, T - 10 * DAY));
  const renew = (over: Record<string, unknown>) => {
    const r = renewSecret(held(), { reference: REF, fingerprint: "0000000000c2", shape: null, grants: [], expiry: null, destinations: [], ...over }, who, T);
    return r.ok ? "stored" : r.error.problem;
  };
  it("a bad Reference or fingerprint is named as such, not as a renew's Expiry", () => {
    expect(renew({ reference: "secret://Bad/x" })).toBe("bad_reference");
    expect(renew({ fingerprint: "nope" })).toBe("bad_fingerprint");
  });
  it("an Expiry that is no time at all is refused the same way, NaN or Infinity", () => {
    expect(renew({ expiry: Number.NaN })).toBe("expiry");
    expect(renew({ expiry: Number.POSITIVE_INFINITY })).toBe("expiry");
  });
});

describe("round 5, point 3: the hub judges a renew's Expiry by the node's time of the store, so the two never disagree", () => {
  const renew = () => value(openRequest({
    node: "node-a", reference: REF, kind: "renew", waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T - 1)).request;
  const answer = (expiry: number, storedAt: number) => ({ seen: 1, command: "c2", reference: REF, version: 2, nodes: ["node-a"], expiry, storedAt });
  const state = <X>(r: R<X & { request: { state: string } }>) => (r.ok ? r.value.request.state : r.error.problem);
  it("a renew the node stored by its clock is Stored, though the hub's clock has passed that Expiry", () => {
    expect(state(answerStored(renew(), answer(T + 10, T), T + 20))).toBe("stored");
  });
  it("an Expiry not later than the node's time of the store is refused, whatever the hub's clock says", () => {
    expect(state(answerStored(renew(), answer(T, T), T - 100))).toBe("expiry");
    expect(state(answerStored(renew(), answer(T - 50, T), T - 100))).toBe("expiry");
  });
});

describe("round 5, point 7: a store states the shape: an id, none (which clears it), or keep; a missing one is refused (T-83)", () => {
  const first = () => value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000d1", shape: "shape-a", grants: [nodeGrant], expiry: null, destinations: [] }, who, T));
  const rotate = (shape: unknown) => {
    const r = storeSecret(first(), { reference: REF, fingerprint: "0000000000d2", shape: shape as null, grants: [], expiry: null, destinations: [] }, who, T + 1);
    return r.ok ? findSecret(r.value, REF)?.shape : r.error.problem;
  };
  it("keep keeps it, none clears it, an id replaces it", () => {
    expect(rotate({ keep: true })).toBe("shape-a");
    expect(rotate(null)).toBeNull();
    expect(rotate("shape-b")).toBe("shape-b");
  });
  it("a shape an adapter left undefined is refused, so a stale one is never kept by accident", () => {
    expect(rotate(undefined)).toBe("bad_shape");
    expect(rotate({ keep: false })).toBe("bad_shape");
  });
  it("a store without a shape does not compile", () => {
    // @ts-expect-error: the shape is required: an id, null, or { keep: true }.
    const r = storeSecret(first(), { reference: REF, fingerprint: "0000000000d2", grants: [], expiry: null, destinations: [] }, who, T + 1);
    expect(r.ok ? "stored" : r.error.problem).toBe("bad_shape");
  });
});
