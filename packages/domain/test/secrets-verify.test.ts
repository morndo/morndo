// Secrets: the verify review of PR #25's fix round. The rule (docs/domain.md, "Expiry on a Rotation or a transfer, and
// waiters without a lane"): a Rotation keeps the Expiry unless it names one; a named one is recorded and clears the
// warnings only when later; a store or transfer never removes an Expiry. A waiter without a lane is its workspace.
import { describe, expect, it } from "vitest";
import {
  emptySecretDirectory, findSecret, joinRequest, openRequest, receiveTransfer, secretExpirySweep, storeSecret,
  withdrawRequest,
  type Actor, type RequestAsk, type SecretDirectory, type SecretGrant,
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
const store = (dir: SecretDirectory, fingerprint: string, expiry: number | null, at: number, command = "c1") =>
  value(storeSecret(dir, { reference: REF, fingerprint, shape: null, grants: [nodeGrant], expiry, destinations: [] }, who(command), at));
const transfer = (dir: SecretDirectory, fingerprint: string, expiry: number | null, at: number, command = "c1") =>
  value(receiveTransfer(dir, { reference: REF, fingerprint, shape: null, grants: [], expiry, destinations: [], from: "node-b" }, who(command), at));
const types = (dir: SecretDirectory, from = 0) => dir.events.slice(from).map(e => e.type);
const leads = (dir: SecretDirectory, from = 0) => dir.events.slice(from).flatMap(e => e.type === "ExpiryWarned" ? [e.lead] : []);

describe("verify 1: a Rotation that names no Expiry keeps the one there", () => {
  it("keeps it, and records no ExpiryChanged", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 3 * DAY, T);
    dir = store(dir, "0123456789a2", null, T + 1);
    expect(findSecret(dir, REF)?.expiry).toBe(T + 3 * DAY);
    expect(types(dir)).toEqual(["SecretStored", "SecretRotated"]);
  });
  it("a named Expiry replaces it and is recorded with the Command", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 3 * DAY, T);
    dir = store(dir, "0123456789a2", T + 10 * DAY, T + 1, "c2");
    expect(findSecret(dir, REF)?.expiry).toBe(T + 10 * DAY);
    expect(dir.events.slice(1)).toEqual([
      { type: "SecretRotated", reference: REF, version: 2, at: T + 1, command: "c2", sameAs: [] },
      { type: "ExpiryChanged", reference: REF, at: T + 1, command: "c2" },
    ]);
  });
});

describe("verify 2: a transfer onto a Reference the target holds is a Rotation there", () => {
  it("one that names no Expiry keeps the target's", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 5 * DAY, T);
    dir = transfer(dir, "0123456789a2", null, T + 1);
    expect(findSecret(dir, REF)?.expiry).toBe(T + 5 * DAY);
    expect(types(dir)).toEqual(["SecretStored", "SecretTransferred"]);
  });
  it("one that names an Expiry replaces it and records it", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 5 * DAY, T);
    dir = transfer(dir, "0123456789a2", T + 9 * DAY, T + 1, "c3");
    expect(findSecret(dir, REF)?.expiry).toBe(T + 9 * DAY);
    expect(types(dir)).toEqual(["SecretStored", "SecretTransferred", "ExpiryChanged"]);
  });
  it("onto a new Reference it brings the source's Expiry, as a first store does", () => {
    const dir = transfer(emptySecretDirectory(), "0123456789a1", T + 9 * DAY, T);
    expect(findSecret(dir, REF)?.expiry).toBe(T + 9 * DAY);
  });
});

describe("verify 4: only a later Expiry clears the warnings (SC9)", () => {
  it("a Rotation with the same Expiry warns no lead twice", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 1.5 * DAY, T);
    dir = secretExpirySweep(dir, T);
    expect(leads(dir)).toEqual(["7d", "2d"]);
    dir = store(dir, "0123456789a2", T + 1.5 * DAY, T + 1);
    const n = dir.events.length;
    dir = secretExpirySweep(dir, T + 2);
    expect(leads(dir, n)).toEqual([]);
  });
  it("a Rotation that names no Expiry warns no lead twice", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 1.5 * DAY, T);
    dir = secretExpirySweep(dir, T);
    dir = store(dir, "0123456789a2", null, T + 1);
    const n = dir.events.length;
    dir = secretExpirySweep(dir, T + 2);
    expect(leads(dir, n)).toEqual([]);
  });
  it("a Rotation with an earlier Expiry keeps the warnings too", () => {
    let dir = store(emptySecretDirectory(), "0123456789a1", T + 1.5 * DAY, T);
    dir = secretExpirySweep(dir, T);
    dir = store(dir, "0123456789a2", T + 1.4 * DAY, T + 1);
    const n = dir.events.length;
    dir = secretExpirySweep(dir, T + 2);
    expect(leads(dir, n)).toEqual([]);
  });
});

describe("verify 3 and 5: a waiter without a lane is its workspace (SR1, SR6)", () => {
  const cron: RequestAsk = {
    node: "node-a", reference: REF, kind: "new", waiter: { lane: null, workspace: "app-a", purpose: "Nightly job" }, proposed: nodeGrant,
  };
  const opened = () => value(openRequest(cron, "r1", T)).request;
  it("a caller without a lane from another workspace is another waiter, with its own purpose", () => {
    const j = value(joinRequest(opened(), { lane: null, workspace: "app-b", purpose: "Deploy" }, T + 1));
    expect(j.request.waiting.map(w => [w.lane, w.workspace, w.purpose])).toEqual([[null, "app-a", "Nightly job"], [null, "app-b", "Deploy"]]);
    expect(j.request.version).toBe(2);
    expect(j.events).toEqual([{ type: "SecretRequestJoined", request: "r1", lane: null, at: T + 1 }]);
  });
  it("the same workspace without a lane again changes nothing, whatever its words", () => {
    const j = value(joinRequest(opened(), { lane: null, workspace: "app-a", purpose: "Nightly job, again" }, T + 1));
    expect(j.events).toEqual([]);
    expect(j.request.version).toBe(1);
  });
  it("a withdrawal names its waiter: one workspace leaves, the other still waits", () => {
    let r = value(joinRequest(opened(), { lane: null, workspace: "app-b", purpose: "Deploy" }, T + 1)).request;
    const left = value(withdrawRequest(r, { lane: null, workspace: "app-a" }, T + 2));
    expect(left.request.state).toBe("open");
    expect(left.request.waiting.map(w => w.workspace)).toEqual(["app-b"]);
    expect(left.events.map(e => e.type)).toEqual(["SecretRequestLeft"]);
    r = left.request;
    expect(withdrawRequest(r, { lane: null, workspace: null }, T + 3).ok).toBe(false);
    expect(value(withdrawRequest(r, { lane: null, workspace: "app-b" }, T + 3)).request.state).toBe("withdrawn");
  });
});
