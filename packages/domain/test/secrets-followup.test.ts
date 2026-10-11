// Secrets: the follow-ups from the second verify review of PR #25 (board T-72). One block per point, each written failing
// before its fix. Names, nodes and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  emptySecretDirectory, findSecret, storeSecret,
  type Actor, type Secret, type SecretDirectory, type SecretGrant, type SecretVersion,
} from "../src/index.ts";

const T = 1_700_000_000_000;
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
