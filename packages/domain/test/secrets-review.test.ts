// Secrets: the points a review of PR #25 confirmed against the design (ADR-0022, design §3.3, §3.4, §10). One block
// per point, each written failing before its fix.
import { describe, expect, it } from "vitest";
import {
  deleteSecret, emptySecretDirectory, endTimedGrants, findSecret, joinRequest, openRequest, revokeSecret, secretExpirySweep,
  storeSecret, useGate, withdrawRequest,
  type Actor, type RequestAsk, type SecretDirectory, type SecretGrant,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const REF = "secret://example-app/payments-test";
const who: Actor = { kind: "principal", command: "c1" };
const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };

type R<T> = { ok: true; value: T } | { ok: false; error: { problem: string } };
const value = <T>(r: R<T>): T => {
  if (!r.ok) throw new Error(`refused: ${r.error.problem}`);
  return r.value;
};
const store = (dir: SecretDirectory, fingerprint: string, expiry: number | null, at: number, reference = REF) =>
  value(storeSecret(dir, { reference, fingerprint, shape: null, grants: [nodeGrant], expiry, destinations: [] }, who, at));

describe("review 1: a Rotation takes the new value's Expiry (design §10: only Grants, Destinations and Reference stay)", () => {
  it("renewing an expired Secret with a new value and a later Expiry makes it usable again", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + DAY, T);
    dir = secretExpirySweep(dir, T + 2 * DAY);
    expect(useGate(findSecret(dir, REF), { lane: null, workspace: null }, "exec", T + 2 * DAY).ok).toBe(false);
    dir = store(dir, "0123456789a2", T + 30 * DAY, T + 2 * DAY);
    expect(findSecret(dir, REF)?.expiry).toBe(T + 30 * DAY);
    expect(useGate(findSecret(dir, REF), { lane: null, workspace: null }, "exec", T + 2 * DAY + 1).ok).toBe(true);
  });
  it("the renewed value's Expiry warns again: the old warnings are cleared", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + DAY, T);
    dir = secretExpirySweep(dir, T + 2 * DAY);
    dir = store(dir, "0123456789a2", T + 30 * DAY, T + 2 * DAY);
    const before = dir.events.length;
    dir = secretExpirySweep(dir, T + 24 * DAY);
    expect(dir.events.slice(before).map(e => e.type === "ExpiryWarned" ? e.lead : e.type)).toEqual(["7d"]);
  });
  it("a Rotation keeps the Grants and Destinations already there", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", null, T);
    dir = value(storeSecret(dir, { reference: REF, fingerprint: "0123456789a2", shape: null, grants: [], expiry: null, destinations: [] }, who, T + 1));
    expect(findSecret(dir, REF)?.grants).toEqual([nodeGrant]);
  });
});

describe("review 2: version numbers continue after a Delete, so Revoke hits only the current value (SC2, SC8)", () => {
  it("a Reference stored again after a Delete starts at the next version, not at 1", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", null, T);
    dir = value(deleteSecret(dir, REF, who, T + 1));
    dir = store(dir, "0123456789a2", null, T + 2);
    expect(findSecret(dir, REF)?.current?.number).toBe(2);
    expect(dir.ledger).toEqual([
      { reference: REF, version: 1, fingerprint: "0123456789a1", state: "retired" },
      { reference: REF, version: 2, fingerprint: "0123456789a2", state: "current" },
    ]);
  });
  it("revoking it marks only its own value revoked; the deleted earlier value stays usable under another Reference", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", null, T);
    dir = value(deleteSecret(dir, REF, who, T + 1));
    dir = store(dir, "0123456789a2", null, T + 2);
    dir = value(revokeSecret(dir, REF, who, T + 3));
    expect(dir.ledger.map(e => [e.version, e.state])).toEqual([[1, "retired"], [2, "revoked"]]);
    expect(storeSecret(dir, { reference: "secret://shared/other", fingerprint: "0123456789a1", shape: null, grants: [], expiry: null, destinations: [] }, who, T + 4).ok).toBe(true);
  });
});

describe("review 3: a waiter with no lane counts once, as a lane does (SR1: a repeat changes nothing)", () => {
  const ask: RequestAsk = {
    node: "node-a", reference: REF, kind: "new", waiter: { lane: "lane-a", workspace: null, purpose: "Run the tests" }, proposed: nodeGrant,
  };
  it("repeated joins without a lane leave one laneless waiter and one version step", () => {
    let r = value(openRequest(ask, "r1", T)).request;
    const first = value(joinRequest(r, { lane: null, workspace: null, purpose: "Nightly job" }, T + 1));
    r = first.request;
    for (let i = 2; i <= 4; i++) {
      const again = value(joinRequest(r, { lane: null, workspace: null, purpose: `Nightly job ${i}` }, T + i));
      expect(again.events).toEqual([]);
      r = again.request;
    }
    expect(r.waiting.map(w => w.lane)).toEqual(["lane-a", null]);
    expect(r.version).toBe(2);
  });
  it("the laneless waiter withdraws once, and the request is then only lane-a's", () => {
    let r = value(openRequest(ask, "r1", T)).request;
    r = value(joinRequest(r, { lane: null, workspace: null, purpose: "Nightly job" }, T + 1)).request;
    r = value(joinRequest(r, { lane: null, workspace: null, purpose: "Nightly job again" }, T + 2)).request;
    r = value(withdrawRequest(r, null, T + 3)).request;
    expect(r.waiting.map(w => w.lane)).toEqual(["lane-a"]);
    expect(withdrawRequest(r, null, T + 4).ok).toBe(false);
  });
});

describe("review 5: a bad workspace is refused as a bad workspace, not a bad Grant", () => {
  const ask: RequestAsk = {
    node: "node-a", reference: REF, kind: "new", waiter: { lane: "lane-a", workspace: "Bad Repo", purpose: "Run the tests" }, proposed: nodeGrant,
  };
  it("on open", () => {
    const r = openRequest(ask, "r1", T);
    expect(r.ok ? "ok" : r.error.problem).toBe("bad_workspace");
  });
  it("on join", () => {
    const r1 = value(openRequest({ ...ask, waiter: { ...ask.waiter, workspace: "example-app" } }, "r1", T)).request;
    const j = joinRequest(r1, { lane: "lane-b", workspace: "Bad Repo", purpose: "Deploy" }, T + 1);
    expect(j.ok ? "ok" : j.error.problem).toBe("bad_workspace");
  });
});

describe("review 7: a Grant with an end time ends, and the audit says so (GrantEnded)", () => {
  const timed: SecretGrant = { subject: { kind: "lane", lane: "lane-a" }, modes: ["exec"], until: { kind: "at", at: T + 100 } };
  const open: SecretGrant = { subject: { kind: "lane", lane: "lane-b" }, modes: ["exec"], until: { kind: "open" } };
  const dir0 = () => value(storeSecret(emptySecretDirectory(), { reference: REF, fingerprint: "0123456789a1", shape: null, grants: [timed, open], expiry: null, destinations: [] }, who, T));
  it("stays before its end", () => {
    const dir = endTimedGrants(dir0(), T + 99);
    expect(findSecret(dir, REF)?.grants).toEqual([timed, open]);
    expect(dir.events.map(e => e.type)).toEqual(["SecretStored"]);
  });
  it("is removed at its end with one GrantEnded, and a second sweep adds nothing", () => {
    let dir = endTimedGrants(dir0(), T + 100);
    expect(findSecret(dir, REF)?.grants).toEqual([open]);
    expect(dir.events.at(-1)).toEqual({ type: "GrantEnded", reference: REF, at: T + 100, subject: { kind: "lane", lane: "lane-a" } });
    const n = dir.events.length;
    dir = endTimedGrants(dir, T + 200);
    expect(dir.events.length).toBe(n);
  });
});
