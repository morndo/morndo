// The node's exact filter (ADR-0022; design §8.1, §15.4): the encodings a value is indexed in, the scanner and the index.
// Values here are synthetic. Buffer and node:crypto are the tests' oracle and keyed hash; secret-scan.ts uses neither.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETIRED_KEPT_MS, SCAN_WINDOW, createScanner, emptySecretIndex, encodedForms, indexValue, liveEntries, parseIndex, pruneIndex,
  retireVersion, scan, serializeIndex, withVersion, type IndexEntry, type ScanRange,
} from "../src/secret-scan.ts";

const text = (s: string) => new TextEncoder().encode(s);
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (...xs: number[]) => Uint8Array.from(xs);
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const fill = (n: number, byte: number) => new Uint8Array(n).fill(byte);

const SAMPLE = text("sample-value 01/é\"\\&?=+!");           // escapes in JSON and percent, non-ASCII, a "!" that only
                                                             // the strict percent form escapes
const BINARY = bytes(0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, 0x00, 0x10, 0x83, 0x7f);   // "+" and "/" in base64, not UTF-8
const forms = (v: Uint8Array) => encodedForms(v).map(f => ({ ...f, text: ascii(f.bytes) }));

describe("encodings a value is indexed in (design §8.1)", () => {
  it("raw, lower-case hex, percent-encoded (strict and as encodeURIComponent leaves it) and JSON-escaped (as is and ASCII-only)", () => {
    const f = forms(SAMPLE);
    const of = (encoding: string) => f.filter(x => x.encoding === encoding).map(x => x.text);
    expect(of("raw")).toEqual([ascii(SAMPLE)]);
    expect(of("hex")).toEqual([Buffer.from(SAMPLE).toString("hex"), Buffer.from(SAMPLE).toString("hex").toUpperCase()]);
    const strict = [...SAMPLE].map(b => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    const quotePlus = [...SAMPLE].map(b => /[A-Za-z0-9_.\-~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : b === 0x20 ? "+" : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    const quoteDefault = [...SAMPLE].map(b => /[A-Za-z0-9_.\-~/]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    const upper = [strict, encodeURIComponent(ascii(SAMPLE)), new URLSearchParams({ a: ascii(SAMPLE) }).toString().slice(2), quotePlus, quoteDefault, encodeURI(ascii(SAMPLE))];
    const all = [...upper, ...upper.map(f => f.replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()))];
    expect(of("percent").sort()).toEqual([...new Set(all)].sort());
    expect(of("json").sort()).toEqual([JSON.stringify(ascii(SAMPLE)).slice(1, -1), JSON.stringify(ascii(SAMPLE)).slice(1, -1).replace("é", "\\u00e9")].sort());
  });
  it("a value that isn't UTF-8 has no JSON form, and identical forms are listed once", () => {
    expect(forms(BINARY).some(x => x.encoding === "json")).toBe(false);
    const plain = forms(text("abcdefgh12345678"));
    expect(plain.map(x => x.encoding).filter(e => e === "raw" || e === "percent" || e === "json")).toEqual(["raw"]);
    expect(new Set(plain.map(x => x.text)).size).toBe(plain.length);
  });
  it("base64 at each byte alignment, standard and URL-safe: the core is found inside any surrounding bytes, padded or not", () => {
    for (const value of [SAMPLE, BINARY, text("abcdefgh")]) {
      const b64 = forms(value).filter(x => x.encoding === "base64" || x.encoding === "base64url");
      expect(new Set(b64.filter(x => x.encoding === "base64").map(x => x.alignment))).toEqual(new Set([0, 1, 2]));
      for (const lead of [0, 1, 2, 3, 4, 5]) for (const trail of [0, 1, 2, 3]) for (const filler of [0x00, 0xff, 0x5a]) {
        const whole = join(fill(lead, filler), value, fill(trail, filler ^ 0x33));
        const encoded = [Buffer.from(whole).toString("base64"), Buffer.from(whole).toString("base64url")];
        const core = b64.filter(x => x.alignment === lead % 3);
        expect(core.length, `alignment ${lead % 3}`).toBeGreaterThan(0);
        for (const c of core) {
          const outer = c.encoding === "base64" ? encoded[0] : encoded[1];
          expect(outer?.includes(c.text), `${c.encoding} core at ${lead}+${trail}, filler ${filler}`).toBe(true);
        }
      }
    }
  });
  it("each base64 core says how many characters beside it also carry bits of the value, so a redaction covers them", () => {
    const b64 = forms(text("abcdefgh")).filter(x => x.encoding === "base64");
    expect(b64.map(x => [x.alignment, x.before, x.after])).toEqual([[0, 0, 1], [1, 1, 0], [2, 1, 1]]);
    expect(forms(text("abcdefgh")).filter(x => x.encoding !== "base64" && x.encoding !== "base64url").every(x => x.before === 0 && x.after === 0)).toBe(true);
  });
});

// ---- The index entries and the scanner (design §8.1, §15.4)

const KEY = new Uint8Array(32).fill(7);                      // a synthetic index key
const keyed = (b: Uint8Array) => new Uint8Array(createHmac("sha256", KEY).update(b).digest());
const entriesOf = (v: Uint8Array): IndexEntry[] => {
  const r = indexValue(v, keyed);
  if (r.kind !== "indexed") throw new Error("not indexed");
  return r.entries;
};
const covers = (ranges: readonly ScanRange[], start: number, end: number) => ranges.some(r => r.start <= start && r.end >= end);
// In a base64 text, the characters whose 6 bits overlap the value's bytes [lead, lead + n).
const valueChars = (lead: number, n: number, chars: number) =>
  Array.from({ length: chars }, (_, j) => j).filter(j => 6 * j < 8 * (lead + n) && 6 * j + 6 > 8 * lead);

describe("index entries: keyed hashes of each form, never the form (design §8.1)", () => {
  it("a value under 8 bytes is not indexed; one of 8 is, one entry per form", () => {
    expect(SCAN_WINDOW).toBe(8);
    expect(indexValue(text("1234567"), keyed)).toEqual({ kind: "too_short" });
    const entries = entriesOf(text("12345678"));
    expect(entries.length).toBe(encodedForms(text("12345678")).length);
    for (const e of entries) {
      expect(e.head).toMatch(/^[0-9a-f]{64}$/);
      expect(e.full).toMatch(/^[0-9a-f]{64}$/);
      expect(e.length).toBeGreaterThanOrEqual(SCAN_WINDOW);
    }
  });
});

describe("the scanner finds each form and covers every character that carries the value (design §15.4)", () => {
  it("each form inside other text", () => {
    for (const value of [SAMPLE, BINARY]) {
      const entries = entriesOf(value);
      for (const f of encodedForms(value)) {
        const out = join(text("log line: "), f.bytes, text(" end"));
        expect(covers(scan(out, entries, keyed), 10 - f.before, 10 + f.bytes.length + f.after), `${f.encoding}/${f.alignment}`).toBe(true);
      }
    }
  });
  it("base64 of the value inside a longer string, at any offset, padded or not, standard or URL-safe", () => {
    for (const value of [SAMPLE, BINARY]) {
      const entries = entriesOf(value);
      for (const lead of [0, 1, 2, 3, 4, 5]) for (const trail of [0, 1, 2, 4]) {
        const whole = join(text("user:".slice(0, lead)), fill(Math.max(0, lead - 5), 0x41), value, fill(trail, 0x7a));
        for (const enc of [Buffer.from(whole).toString("base64"), Buffer.from(whole).toString("base64url")]) {
          const out = join(text("Authorization: Basic "), text(enc), text("\n"));
          const ranges = scan(out, entries, keyed);
          const missed = valueChars(lead, value.length, enc.length).filter(j => !covers(ranges, 21 + j, 22 + j));
          expect(missed, `${enc} lead ${lead} trail ${trail}`).toEqual([]);
        }
      }
    }
  });
  it("a value that shares only its first 8 bytes with an indexed one is not reported", () => {
    const entries = entriesOf(text("sample-value-0001"));
    expect(scan(text("x sample-value-0002 y"), entries, keyed)).toEqual([]);
    expect(scan(text("x sample-value-0001 y"), entries, keyed)).toEqual([{ start: 2, end: 19 }]);
  });
  it("a value under 8 bytes is never reported, since it has no entries", () => {
    expect(scan(text("pin 1234567 end"), [], keyed)).toEqual([]);
  });
});

describe("the streaming scanner: split across chunks and at the end of the stream (design §15.4)", () => {
  const value = SAMPLE;
  const stream = join(...encodedForms(value).flatMap(f => [text(" | "), f.bytes]), text(" | tail"));
  const pieces = (bytes: Uint8Array, size: number) => Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size));

  it("finds every form whatever the chunk size, the same ranges as in one piece", () => {
    const entries = entriesOf(value);
    const whole = scan(stream, entries, keyed);
    expect(whole.length).toBeGreaterThan(0);
    for (const size of [1, 2, 3, 5, 7, 8, 13, 64]) {
      const s = createScanner(entries, keyed);
      const found = [...pieces(stream, size).flatMap(c => s.push(c).ranges), ...s.end().ranges];
      expect(merge(found), `chunks of ${size}`).toEqual(whole);
    }
  });
  it("no range found later starts before what an earlier step called settled", () => {
    const entries = entriesOf(value);
    for (const size of [1, 3, 7]) {
      const s = createScanner(entries, keyed);
      let settled = 0;
      for (const c of pieces(stream, size)) {
        const step = s.push(c);
        for (const r of step.ranges) expect(r.start).toBeGreaterThanOrEqual(settled);
        expect(step.settled).toBeGreaterThanOrEqual(settled);
        settled = step.settled;
      }
      const last = s.end();
      for (const r of last.ranges) expect(r.start).toBeGreaterThanOrEqual(settled);
      expect(last.settled).toBe(stream.length);
    }
  });
  it("a value that ends the stream is found, its padding included", () => {
    const entries = entriesOf(value);
    const enc = text(`${Buffer.from(value).toString("base64")}`);
    expect(enc.at(-1)).toBe(0x3d);
    const s = createScanner(entries, keyed);
    const found = [...s.push(join(text("k="), enc.subarray(0, enc.length - 3))).ranges, ...s.push(enc.subarray(enc.length - 3)).ranges, ...s.end().ranges];
    expect(covers(merge(found), 2, 2 + enc.length)).toBe(true);
    expect(covers(scan(join(text("raw="), value), entries, keyed), 4, 4 + value.length)).toBe(true);
  });
});

// ---- The index: versions, retirement, and the file's text (design §8.1, §15.4)

describe("the index keeps a retired version 30 days, and its text holds no value", () => {
  const REF = "secret://example-app/payments-test";
  const T = 1_700_000_000_000;
  const DAY = 86_400_000;
  const index = () => withVersion(withVersion(emptySecretIndex(), REF, 1, entriesOf(SAMPLE)), REF, 2, entriesOf(BINARY));

  it("a retired version is still found 30 days after it retired, and not after that", () => {
    expect(RETIRED_KEPT_MS).toBe(30 * DAY);
    const retired = retireVersion(index(), REF, 1, T);
    const found = (now: number) => scan(join(text("x "), SAMPLE), liveEntries(retired, now), keyed).length > 0;
    expect(found(T + 30 * DAY)).toBe(true);
    expect(found(T + 30 * DAY + 1)).toBe(false);
    expect(scan(join(text("x "), BINARY), liveEntries(retired, T + 365 * DAY), keyed).length).toBeGreaterThan(0);
  });
  it("retiring again keeps the first time, so it can't stretch the 30 days", () => {
    const twice = retireVersion(retireVersion(index(), REF, 1, T), REF, 1, T + 20 * DAY);
    expect(liveEntries(twice, T + 30 * DAY + 1).length).toBe(entriesOf(BINARY).length);
  });
  it("pruning drops what the 30 days no longer cover and keeps the rest", () => {
    const retired = retireVersion(index(), REF, 1, T);
    expect(pruneIndex(retired, T + 30 * DAY).versions.map(v => v.version)).toEqual([1, 2]);
    expect(pruneIndex(retired, T + 30 * DAY + 1).versions.map(v => v.version)).toEqual([2]);
  });
  it("the index's text holds no form of any value it indexes (a scan for each)", () => {
    const file = text(serializeIndex(retireVersion(index(), REF, 1, T)));
    const holds = (needle: Uint8Array) => {
      outer: for (let i = 0; i + needle.length <= file.length; i++) {
        for (let j = 0; j < needle.length; j++) if (file[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    };
    for (const value of [SAMPLE, BINARY]) {
      for (const f of encodedForms(value)) expect(holds(f.bytes), `${f.encoding}/${f.alignment}`).toBe(false);
    }
  });
  it("its text reads back as it was, and anything else is refused whole", () => {
    const one = retireVersion(index(), REF, 1, T);
    expect(parseIndex(serializeIndex(one))).toEqual(one);
    const good = JSON.parse(serializeIndex(one)) as { format: number; versions: Record<string, unknown>[] };
    const bad = (change: (doc: typeof good) => void) => {
      const doc = JSON.parse(JSON.stringify(good)) as typeof good;
      change(doc);
      return parseIndex(JSON.stringify(doc));
    };
    expect(parseIndex("not json")).toBeNull();
    expect(bad(d => { d.format = 2; })).toBeNull();
    expect(bad(d => { (d.versions[0] as Record<string, unknown>).reference = "secret://Bad/x"; })).toBeNull();
    expect(bad(d => { (d.versions[0] as Record<string, unknown>).version = 0; })).toBeNull();
    expect(bad(d => { (d.versions[0] as Record<string, unknown>).value = "x"; })).toBeNull();
    expect(bad(d => { ((d.versions[0] as { entries: Record<string, unknown>[] }).entries[0] as Record<string, unknown>).full = "nothex"; })).toBeNull();
    expect(bad(d => { ((d.versions[0] as { entries: Record<string, unknown>[] }).entries[0] as Record<string, unknown>).length = 7; })).toBeNull();
  });
});

describe("secret-scan.ts is pure (design §8.1: the scanner imports no file system)", () => {
  it("imports nothing from node:, and uses no process, Buffer or require", () => {
    const code = readFileSync(joinPath(import.meta.dirname, "../src/secret-scan.ts"), "utf8");
    expect(code).not.toMatch(/from\s+["']node:/);
    expect(code).not.toMatch(/\b(process|Buffer|require)\b/);
  });
});

function merge(ranges: readonly ScanRange[]): ScanRange[] {
  const out: ScanRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
