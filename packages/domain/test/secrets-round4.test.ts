// Secrets: review round 4 of PR #25 (board T-80). One block per point, each written failing before its fix. Names, nodes
// and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  emptySecretDirectory, findSecret, joinRequest, openRequest, receiveTransfer, storeSecret, withdrawRequest,
  type Actor, type RequestAsk, type SecretDirectory, type SecretGrant,
} from "../src/index.ts";

const T = 1_700_000_000_000;
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
  it("a first store that leaves the shape out has none", () => {
    const dir = value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000a1", grants: [], expiry: null, destinations: [] }, who, T));
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
