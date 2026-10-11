// The exact filter: the check review of PR #31 (board T-94). Each block written failing before its fix. Values and keys are
// synthetic; node:crypto is the tests' keyed hash.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  emptySecretIndex, indexValue, liveEntries, parseIndex, pruneIndex, retireVersion, scan, serializeIndex, withVersion, type IndexEntry,
} from "../src/secret-scan.ts";

const KEY = new Uint8Array(32).fill(6);
const keyed = (b: Uint8Array) => new Uint8Array(createHmac("sha256", KEY).update(b).digest());
const text = (s: string) => new TextEncoder().encode(s);
const entriesOf = (v: Uint8Array): IndexEntry[] => {
  const r = indexValue(v, keyed);
  if (r.kind !== "indexed") throw new Error("not indexed");
  return r.entries;
};
const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const T = 1_700_000_000_000;
const DAY = 86_400_000;

describe("check review, point 3: a version pruning dropped can't come back live", () => {
  const value = text("sample-value-to-prune");
  const pruned = () => {
    let index = withVersion(emptySecretIndex(), REF, 1, entriesOf(text("sample-value-first")));
    index = withVersion(retireVersion(index, REF, 1, T - DAY), REF, 2, entriesOf(value));
    index = withVersion(retireVersion(index, REF, 2, T), REF, 3, entriesOf(text("sample-value-current")));
    return pruneIndex(index, T + 31 * DAY);
  };
  it("adding the pruned version again, a replay, indexes nothing live", () => {
    const again = withVersion(pruned(), REF, 2, entriesOf(value));
    expect(scan(text("x sample-value-to-prune y"), liveEntries(again, T + 31 * DAY), keyed)).toEqual([]);
    expect(again.versions.map(v => v.version)).toEqual([3]);
  });
  it("an older version of that Reference can't either; a newer one, or another Reference's, can", () => {
    expect(withVersion(pruned(), REF, 1, entriesOf(value)).versions.map(v => v.version)).toEqual([3]);
    expect(withVersion(pruned(), REF, 4, entriesOf(value)).versions.map(v => v.version)).toEqual([3, 4]);
    expect(withVersion(pruned(), OTHER, 1, entriesOf(value)).versions.map(v => [v.reference, v.version])).toEqual([[REF, 3], [OTHER, 1]]);
  });
  it("the mark is the highest version pruned, it survives the file, and the file refuses a bad one", () => {
    const index = pruned();
    expect(index.pruned).toEqual([{ reference: REF, through: 2 }]);
    expect(parseIndex(serializeIndex(index))).toEqual(index);
    const doc = JSON.parse(serializeIndex(index)) as { pruned: unknown[] };
    for (const bad of [[{ reference: REF, through: 0 }], [{ reference: "secret://Bad/x", through: 1 }], [{ reference: REF, through: 1, x: 1 }],
      [{ reference: REF, through: 1 }, { reference: REF, through: 2 }]]) {
      expect(parseIndex(JSON.stringify({ ...doc, pruned: bad })), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("check review, point 4: a value written by Python's default quote or by encodeURI is found", () => {
  // The characters these two writers keep and the others escape: "/" (both), and ; ? : @ & = + $ , # (encodeURI).
  const VALUE = "ab\u007fcd \u00e9~*!()+ x/y;?:@&=$,#";
  const found = (form: string) => {
    const out = text(`k=${form}&next`);
    return scan(out, entriesOf(text(VALUE)), keyed).some(r => r.start <= 2 && r.end >= 2 + text(form).length);
  };
  const lower = (s: string) => s.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase());
  // Python 3.12.3, urllib.parse.quote(VALUE), whose safe is "/" by default (docs.python.org/3/library/urllib.parse.html,
  // read 2026-10-12).
  const PY_QUOTE_DEFAULT = "ab%7Fcd%20%C3%A9~%2A%21%28%29%2B%20x/y%3B%3F%3A%40%26%3D%24%2C%23";

  it("the review's case: a '/' kept beside escapes, as quote(value) writes it", () => {
    expect(found(PY_QUOTE_DEFAULT)).toBe(true);
    const short = "ab/cd+ef12";
    expect(scan(text(`x ab/cd%2Bef12 y`), entriesOf(text(short)), keyed)).toEqual([{ start: 2, end: 14 }]);
  });
  it("encodeURI, which keeps ; / ? : @ & = + $ , # as well", () => {
    expect(found(encodeURI(VALUE))).toBe(true);
  });
  it("both with lower-case escapes", () => {
    expect(found(lower(PY_QUOTE_DEFAULT))).toBe(true);
    expect(found(lower(encodeURI(VALUE)))).toBe(true);
  });
});
