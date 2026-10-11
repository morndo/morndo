// Secrets: the points a review of PR #25 confirmed against the design (ADR-0022, design §3.3, §3.4, §10). One block
// per point, each written failing before its fix.
import { describe, expect, it } from "vitest";
import {
  emptySecretDirectory, findSecret, secretExpirySweep, storeSecret, useGate,
  type Actor, type SecretDirectory, type SecretGrant,
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
