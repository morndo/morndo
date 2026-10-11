// The node's exact filter (ADR-0022; design §8.1): the encodings a value is indexed in. Pure: no file system, no process.
// A form is the run of output bytes that depends on the value alone, so it is found wherever the value is written that
// way, inside any surrounding bytes.

export type SecretEncoding = "raw" | "hex" | "percent" | "json" | "base64" | "base64url";
// `alignment` is the value's byte offset mod 3 inside a longer base64-encoded string (null for the other encodings);
// `before` and `after` count the characters beside the form that carry bits of the value and of a neighbour, so a
// redaction covers them too.
export type EncodedForm = { encoding: SecretEncoding; alignment: 0 | 1 | 2 | null; bytes: Uint8Array; before: number; after: number };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";
// RFC 3986 unreserved characters stay as they are; encodeURIComponent also leaves ! ' ( ) * alone.
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const COMPONENT_SAFE = /^[A-Za-z0-9\-._~!'()*]$/;
// At alignment a, the first LEAD[a] characters also depend on the bytes before the value.
const LEAD = [0, 2, 3] as const;
const ALIGNMENTS = [0, 1, 2] as const;

const ascii = (s: string) => new TextEncoder().encode(s);

export function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
  return out;
}

// Unpadded base64 in the given alphabet (RFC 4648 §4 and §5).
function base64(bytes: Uint8Array, alphabet: string): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const left = bytes.length - i;
    out += alphabet.charAt((n >> 18) & 63) + alphabet.charAt((n >> 12) & 63);
    if (left > 1) out += alphabet.charAt((n >> 6) & 63);
    if (left > 2) out += alphabet.charAt(n & 63);
  }
  return out;
}

function percent(bytes: Uint8Array, safe: RegExp): string {
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    out += safe.test(c) ? c : `%${HEX.charAt(b >> 4).toUpperCase()}${HEX.charAt(b & 15).toUpperCase()}`;
  }
  return out;
}

function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

// As JSON.stringify writes the string, and as an ASCII-only writer does (Python's json.dumps by default): every code
// unit above 0x7f as \uXXXX.
function jsonForms(text: string): string[] {
  const plain = JSON.stringify(text).slice(1, -1);
  let only = "";
  for (let i = 0; i < plain.length; i++) {
    const n = plain.charCodeAt(i);
    only += n > 0x7f ? `\\u${n.toString(16).padStart(4, "0")}` : plain.charAt(i);
  }
  return [plain, only];
}

// The value at byte offset `a` (mod 3) of a longer string: encode it behind `a` zero bytes, then drop the characters that
// also depend on the bytes before it (LEAD[a]) and, unless it ends on a 3-byte boundary, the last one, which also depends
// on the byte after it. Padding carries no bits, so the core is found in padded and unpadded text alike.
function base64Core(value: Uint8Array, a: 0 | 1 | 2, alphabet: string): { text: string; before: number; after: number } {
  const shifted = new Uint8Array(a + value.length);
  shifted.set(value, a);
  const partial = (a + value.length) % 3 !== 0;
  const encoded = base64(shifted, alphabet);
  return { text: encoded.slice(LEAD[a], partial ? -1 : undefined), before: a === 0 ? 0 : 1, after: partial ? 1 : 0 };
}

// Every form of a value, each once: raw, lower-case hex, percent-encoded (strict, and as encodeURIComponent leaves it),
// JSON-escaped (as is, and ASCII-only) when the value is UTF-8, and base64 and base64url at each of the three alignments.
export function encodedForms(value: Uint8Array): EncodedForm[] {
  const forms: EncodedForm[] = [];
  const seen = new Set<string>();
  const add = (encoding: SecretEncoding, alignment: 0 | 1 | 2 | null, bytes: Uint8Array, before = 0, after = 0) => {
    const key = hexOf(bytes);
    if (seen.has(key)) return;
    seen.add(key);
    forms.push({ encoding, alignment, bytes, before, after });
  };
  add("raw", null, value);
  add("hex", null, ascii(hexOf(value)));
  add("percent", null, ascii(percent(value, UNRESERVED)));
  add("percent", null, ascii(percent(value, COMPONENT_SAFE)));
  const text = utf8(value);
  if (text !== null) for (const j of jsonForms(text)) add("json", null, new TextEncoder().encode(j));
  for (const [encoding, alphabet] of [["base64", B64], ["base64url", B64URL]] as const) {
    for (const a of ALIGNMENTS) {
      const core = base64Core(value, a, alphabet);
      add(encoding, a, ascii(core.text), core.before, core.after);
    }
  }
  return forms;
}

// ---- Index entries and the scanner (stubs until their fix)

export type Keyed = (bytes: Uint8Array) => Uint8Array;
export const SCAN_WINDOW = 8;
export type IndexEntry = {
  encoding: SecretEncoding; alignment: 0 | 1 | 2 | null; length: number; head: string; full: string; before: number; after: number;
};
export type Indexed = { kind: "indexed"; entries: IndexEntry[] } | { kind: "too_short" };
export type ScanRange = { start: number; end: number };
export type ScanStep = { ranges: ScanRange[]; settled: number };
export type Scanner = { push(chunk: Uint8Array): ScanStep; end(): ScanStep };

export function indexValue(_value: Uint8Array, _keyed: Keyed): Indexed {
  return { kind: "too_short" };
}
export function createScanner(_entries: readonly IndexEntry[], _keyed: Keyed): Scanner {
  return { push: () => ({ ranges: [], settled: 0 }), end: () => ({ ranges: [], settled: 0 }) };
}
export function scan(_bytes: Uint8Array, _entries: readonly IndexEntry[], _keyed: Keyed): ScanRange[] {
  return [];
}
