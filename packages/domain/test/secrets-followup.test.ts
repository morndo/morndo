// Secrets: the follow-ups from the second verify review of PR #25 (board T-72). One block per point, each written failing
// before its fix. Names, nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  REQUEST_LIMITS, admitRequest, answerStored, emptySecretDirectory, findSecret, joinRequest, openRequest, receiveTransfer,
  storeSecret, withdrawRequest,
  type Actor, type RequestAsk, type Secret, type SecretDirectory, type SecretGrant, type SecretRequest, type SecretVersion,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
const who = (command = "c1"): Actor => ({ kind: "principal", command });

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};

describe("follow-up 3: a version number is never given twice, even when the ledger lacks the Secret's versions (SC8)", () => {
  const version = (number: number, retiredAt: number | null): SecretVersion =>
    ({ number, fingerprint: `00000000000${number}`, storedAt: T, command: "c1", retiredAt });
  const held: Secret = {
    reference: REF, status: "active", current: version(3, null), versions: [version(1, T), version(2, T), version(3, null)],
    grants: [nodeGrant], destinations: [], expiry: null, shape: null, warned: [],
  };
  const rotate = (dir: SecretDirectory) =>
    value(storeSecret(dir, { reference: REF, fingerprint: "0000000000a4", shape: null, grants: [], expiry: null, destinations: [] }, who(), T + 1));

  it("a Rotation numbers past the Secret's own versions when the ledger has none of them", () => {
    const dir = rotate({ held: [held], ledger: [], events: [] });
    expect(findSecret(dir, REF)?.current?.number).toBe(4);
    expect(dir.events.at(-1)).toMatchObject({ type: "SecretRotated", version: 4 });
  });
  it("and past them when the ledger has only some", () => {
    const dir = rotate({ held: [held], ledger: [{ reference: REF, version: 1, fingerprint: "000000000001", state: "retired" }], events: [] });
    expect(findSecret(dir, REF)?.versions.map(v => v.number)).toEqual([1, 2, 3, 4]);
  });
  it("a first store still starts at 1", () => {
    const dir = value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0000000000a1", shape: null, grants: [], expiry: null, destinations: [] }, who(), T));
    expect(findSecret(dir, REF)?.current?.number).toBe(1);
  });
});

describe("follow-up 4: a request holds at most 20 waiters, lanes and callers without one alike (SR10)", () => {
  const ask = (lane: string | null, workspace: string | null): RequestAsk => ({
    node: "node-a", reference: REF, kind: "new", waiter: { lane, workspace, purpose: "Nightly job" }, proposed: nodeGrant,
  });
  // One request with `n` waiters: the opener's workspace, then lane-less callers from other workspaces.
  const withWaiters = (n: number): SecretRequest => {
    let r = value(openRequest(ask(null, "ws-0"), "r1", T)).request;
    for (let i = 1; i < n; i++) r = value(joinRequest(r, { lane: null, workspace: `ws-${i}`, purpose: "Nightly job" }, T + i)).request;
    return r;
  };

  it("the limit is 20", () => {
    expect(REQUEST_LIMITS.waiters).toBe(20);
  });
  it("admission lets the 20th waiter join and refuses the 21st, with or without a lane", () => {
    expect(admitRequest([withWaiters(19)], ask(null, "ws-new"), T + 50)).toEqual({ kind: "join", request: "r1" });
    expect(admitRequest([withWaiters(20)], ask(null, "ws-new"), T + 50)).toEqual({ kind: "refuse", limit: "request-waiters" });
    expect(admitRequest([withWaiters(20)], ask("lane-a", null), T + 50)).toEqual({ kind: "refuse", limit: "request-waiters" });
  });
  it("a waiter already on a full request still joins, which changes nothing", () => {
    const full = withWaiters(20);
    expect(admitRequest([full], ask(null, "ws-3"), T + 50)).toEqual({ kind: "join", request: "r1" });
    const again = value(joinRequest(full, { lane: null, workspace: "ws-3", purpose: "Nightly job" }, T + 50));
    expect(again.events).toEqual([]);
    expect(again.request).toEqual(full);
  });
  it("the request itself refuses a 21st waiter, so its version stops moving", () => {
    const full = withWaiters(20);
    expect(full.version).toBe(20);
    const j = joinRequest(full, { lane: null, workspace: "ws-new", purpose: "Nightly job" }, T + 50);
    expect(j.ok ? "ok" : j.error.problem).toBe("full");
  });
});

describe("follow-up 5: a renew is Stored only when its store names an Expiry later than now (SR8, SC9)", () => {
  const renew = (kind: RequestAsk["kind"] = "renew") => value(openRequest({
    node: "node-a", reference: REF, kind, waiter: { lane: "lane-a", workspace: null, purpose: "The token expired" }, proposed: nodeGrant,
  }, "r1", T)).request;
  const answer = (expiry: number | null) =>
    ({ seen: 1, command: "c2", reference: REF, expiry, confirmations: [{ reference: REF, node: "node-a", version: 2, at: T + 1, renewed: true }] });
  const problem = <T>(r: R<T>) => (r.ok ? "ok" : r.error.problem);

  it("a store that names no Expiry, or one that has passed, leaves the renew open", () => {
    expect(problem(answerStored(renew(), answer(null), T + 1))).toBe("expiry");
    expect(problem(answerStored(renew(), answer(null), T + 1))).toBe("expiry");
    expect(problem(answerStored(renew(), answer(T + 1), T + 1))).toBe("expiry");
    expect(problem(answerStored(renew(), answer(T - DAY), T + 1))).toBe("expiry");
  });
  it("a later Expiry answers it", () => {
    const r = value(answerStored(renew(), answer(T + 30 * DAY), T + 1));
    expect(r.request.state).toBe("stored");
    expect(r.events.map(e => e.type)).toEqual(["SecretRequestStored"]);
  });
  it("the other kinds that store need no Expiry", () => {
    expect(problem(answerStored(renew("new"), answer(null), T + 1))).toBe("ok");
    expect(problem(answerStored(renew("rotate"), answer(null), T + 1))).toBe("ok");
  });
});

describe("follow-up 8: a Rotation keeps the shape unless it names one, as it keeps the Expiry", () => {
  const put = (dir: SecretDirectory, fingerprint: string, shape: string | null | { keep: true }, at: number) =>
    value(storeSecret(dir, { reference: REF, fingerprint, shape, grants: [nodeGrant], expiry: null, destinations: [] }, who(), at));
  it("a store that names no shape keeps the one there", () => {
    let dir = put(emptySecretDirectory(), "0000000000a1", "shape-a", T);
    dir = put(dir, "0000000000a2", { keep: true }, T + 1);
    expect(findSecret(dir, REF)?.shape).toBe("shape-a");
  });
  it("a store that names one replaces it", () => {
    let dir = put(emptySecretDirectory(), "0000000000a1", "shape-a", T);
    dir = put(dir, "0000000000a2", "shape-b", T + 1);
    expect(findSecret(dir, REF)?.shape).toBe("shape-b");
  });
  it("a transfer onto the Reference keeps it too", () => {
    let dir = put(emptySecretDirectory(), "0000000000a1", "shape-a", T);
    dir = value(receiveTransfer(dir, { reference: REF, fingerprint: "0000000000a2", shape: { keep: true }, grants: [], expiry: null, destinations: [], from: "node-b" }, who(), T + 1));
    expect(findSecret(dir, REF)?.shape).toBe("shape-a");
  });
});

describe("follow-up 2: a withdrawal names its waiter by lane and workspace, so it can't take another one off", () => {
  const ask = (lane: string | null, workspace: string | null): RequestAsk => ({
    node: "node-a", reference: REF, kind: "new", waiter: { lane, workspace, purpose: "Nightly job" }, proposed: nodeGrant,
  });
  it("a caller without a lane in app-a takes itself off, not the waiter without a workspace", () => {
    let r = value(openRequest(ask(null, null), "r1", T)).request;
    r = value(joinRequest(r, { lane: null, workspace: "app-a", purpose: "Deploy" }, T + 1)).request;
    const left = value(withdrawRequest(r, { lane: null, workspace: "app-a" }, T + 2));
    expect(left.request.waiting.map(w => [w.lane, w.workspace])).toEqual([[null, null]]);
    expect(left.request.state).toBe("open");
  });
  it("a lane is its waiter, whatever workspace the withdrawal names", () => {
    let r = value(openRequest(ask("lane-a", "example-app"), "r1", T)).request;
    r = value(joinRequest(r, { lane: "lane-b", workspace: null, purpose: "Deploy" }, T + 1)).request;
    const left = value(withdrawRequest(r, { lane: "lane-a", workspace: null }, T + 2));
    expect(left.request.waiting.map(w => w.lane)).toEqual(["lane-b"]);
  });
});

describe("follow-up 1: Joined and Left name the waiter by lane and workspace, so the audit tells lane-less waiters apart", () => {
  const ask: RequestAsk = {
    node: "node-a", reference: REF, kind: "new", waiter: { lane: null, workspace: "app-a", purpose: "Nightly job" }, proposed: nodeGrant,
  };
  it("two callers without a lane: the one that leaves is named", () => {
    let r = value(openRequest(ask, "r1", T)).request;
    const joined = value(joinRequest(r, { lane: null, workspace: "app-b", purpose: "Deploy" }, T + 1));
    expect(joined.events).toEqual([{ type: "SecretRequestJoined", request: "r1", lane: null, workspace: "app-b", at: T + 1 }]);
    r = joined.request;
    const left = value(withdrawRequest(r, { lane: null, workspace: "app-a" }, T + 2));
    expect(left.events).toEqual([{ type: "SecretRequestLeft", request: "r1", lane: null, workspace: "app-a", at: T + 2 }]);
  });
  it("a lane's events carry the workspace it was seen in", () => {
    let r = value(openRequest(ask, "r1", T)).request;
    r = value(joinRequest(r, { lane: "lane-b", workspace: "example-app", purpose: "Deploy" }, T + 1)).request;
    const left = value(withdrawRequest(r, { lane: "lane-b", workspace: "example-app" }, T + 2));
    expect(left.events).toEqual([{ type: "SecretRequestLeft", request: "r1", lane: "lane-b", workspace: "example-app", at: T + 2 }]);
  });
});
