// The exact filter: review round 1 of PR #31 (board T-88). Each block written failing before its fix. Values and keys are
// synthetic; Buffer and node:crypto are the tests' oracle and keyed hash.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptySecretIndex, indexValue, liveEntries, retireVersion, scan, withVersion, type IndexEntry } from "../src/secret-scan.ts";

const KEY = new Uint8Array(32).fill(5);
const keyed = (b: Uint8Array) => new Uint8Array(createHmac("sha256", KEY).update(b).digest());
const text = (s: string) => new TextEncoder().encode(s);
const entriesOf = (v: Uint8Array): IndexEntry[] => {
  const r = indexValue(v, keyed);
  if (r.kind !== "indexed") throw new Error("not indexed");
  return r.entries;
};
const REF = "secret://example-app/payments-test";
const T = 1_700_000_000_000;
const DAY = 86_400_000;

describe("round 7, point 3: a retired version can't be revived by adding it again", () => {
  it("its first retirement stands, so the 30 days still end", () => {
    const value = text("sample-value-to-retire");
    let index = withVersion(emptySecretIndex(), REF, 1, entriesOf(value));
    index = retireVersion(index, REF, 1, T);
    index = withVersion(index, REF, 1, entriesOf(value));
    expect(index.versions.map(v => [v.version, v.retiredAt])).toEqual([[1, T]]);
    expect(scan(text(`x ${"sample-value-to-retire"} y`), liveEntries(index, T + 30 * DAY + 1), keyed)).toEqual([]);
  });
});
