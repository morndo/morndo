// The node's exact filter (ADR-0022; design §8.1, §15.4): the encodings a value is indexed in, the scanner and the index.
// Values here are synthetic. Buffer and node:crypto are the tests' oracle and keyed hash; secret-scan.ts uses neither.
import { describe, expect, it } from "vitest";
import { encodedForms } from "../src/secret-scan.ts";

const text = (s: string) => new TextEncoder().encode(s);
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (...xs: number[]) => Uint8Array.from(xs);
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const fill = (n: number, byte: number) => new Uint8Array(n).fill(byte);

const SAMPLE = text("sample-value 01/é\"\\&?=+");            // escapes in JSON and percent, non-ASCII
const BINARY = bytes(0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff, 0x00, 0x10, 0x83, 0x7f);   // "+" and "/" in base64, not UTF-8
const forms = (v: Uint8Array) => encodedForms(v).map(f => ({ ...f, text: ascii(f.bytes) }));

describe("encodings a value is indexed in (design §8.1)", () => {
  it("raw, lower-case hex, percent-encoded (strict and as encodeURIComponent leaves it) and JSON-escaped (as is and ASCII-only)", () => {
    const f = forms(SAMPLE);
    const of = (encoding: string) => f.filter(x => x.encoding === encoding).map(x => x.text);
    expect(of("raw")).toEqual([ascii(SAMPLE)]);
    expect(of("hex")).toEqual([Buffer.from(SAMPLE).toString("hex")]);
    const strict = [...SAMPLE].map(b => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
    expect(of("percent").sort()).toEqual([strict, encodeURIComponent(ascii(SAMPLE))].sort());
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
