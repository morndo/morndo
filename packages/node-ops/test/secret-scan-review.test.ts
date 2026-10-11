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

describe("round 7, points 4 and 5: the forms other writers use are found (checked against them, 2026-10-12)", () => {
  // DEL, a non-ASCII letter, a space, "+", "~", "*" and "!": the characters the writers below treat differently.
  const VALUE = "ab\u007fcd é~*!()+ x/y";
  const bytes = text(VALUE);
  const entries = () => entriesOf(bytes);
  const found = (form: string) => {
    const out = text(`k=${form}&next`);
    return scan(out, entries(), keyed).some(r => r.start <= 2 && r.end >= 2 + text(form).length);
  };
  const lower = (s: string) => s.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase());
  // Python 3.12.3: json.dumps(VALUE), urllib.parse.quote(VALUE, safe=""), urllib.parse.quote_plus(VALUE).
  const PY_JSON = ["ab", "\\u007f", "cd ", "\\u00e9", "~*!()+ x/y"].join("");
  const PY_QUOTE = "ab%7Fcd%20%C3%A9~%2A%21%28%29%2B%20x%2Fy";
  const PY_QUOTE_PLUS = "ab%7Fcd+%C3%A9~%2A%21%28%29%2B+x%2Fy";

  it("JSON written ASCII-only, as Python's json.dumps does, DEL as \\u007f included", () => {
    expect(found(PY_JSON)).toBe(true);
  });
  it("percent-encoding as encodeURIComponent, Python's quote and quote_plus, and URLSearchParams write it", () => {
    const whatwg = new URLSearchParams({ a: VALUE }).toString().slice(2);
    for (const form of [encodeURIComponent(VALUE), PY_QUOTE, PY_QUOTE_PLUS, whatwg]) expect(found(form), form).toBe(true);
  });
  it("the same with lower-case escapes, which RFC 3986 treats as equal", () => {
    const whatwg = new URLSearchParams({ a: VALUE }).toString().slice(2);
    for (const form of [encodeURIComponent(VALUE), PY_QUOTE, PY_QUOTE_PLUS, whatwg].map(lower)) expect(found(form), form).toBe(true);
  });
  it("hex in upper case as well as lower", () => {
    expect(found(Buffer.from(bytes).toString("hex"))).toBe(true);
    expect(found(Buffer.from(bytes).toString("hex").toUpperCase())).toBe(true);
  });
});
