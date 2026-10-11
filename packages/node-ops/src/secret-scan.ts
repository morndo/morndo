// The node's exact filter (ADR-0022; design §8.1): the encodings a value is indexed in, the index entries and the scanner.
// Pure: no file system and no globals of the runtime; the keyed hash is passed in, so the index key stays in an adapter.
// A form is the run of output bytes that depends on the value alone, so it is found wherever the value is written that
// way, inside any surrounding bytes.
import { parseReference } from "@morndo/domain";

export type SecretEncoding = "raw" | "hex" | "percent" | "json" | "base64" | "base64url";
// `alignment` is the value's byte offset mod 3 inside a longer base64-encoded string (null for the other encodings);
// `before` and `after` count the characters beside the form that carry bits of the value and of a neighbour, so a
// redaction covers them too.
export type EncodedForm = { encoding: SecretEncoding; alignment: 0 | 1 | 2 | null; bytes: Uint8Array; before: number; after: number };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HEX = "0123456789abcdef";
// The characters each percent writer leaves alone (design §8.1, checked against each on 2026-10-12): RFC 3986's
// unreserved ones (Python's quote with safe=""); encodeURIComponent, which also keeps ! ' ( ) *; the WHATWG form encoding
// (URLSearchParams), which keeps * - . _ and writes a space as "+"; Python's quote_plus, which keeps _ . - ~ and writes a
// space as "+"; Python's quote with its default safe "/", which keeps "/" too; and encodeURI, which keeps
// ; / ? : @ & = + $ , # as well (T-94).
const PERCENT_WRITERS = [
  { safe: /^[A-Za-z0-9\-._~]$/, plus: false },
  { safe: /^[A-Za-z0-9\-._~!'()*]$/, plus: false },
  { safe: /^[A-Za-z0-9*\-._]$/, plus: true },
  { safe: /^[A-Za-z0-9_.\-~]$/, plus: true },
  { safe: /^[A-Za-z0-9_.\-~/]$/, plus: false },
  { safe: /^[A-Za-z0-9\-_.!~*'();/?:@&=+$,#]$/, plus: false },
] as const;
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

// Escapes in upper case unless `lower`: RFC 3986 treats both as equal, and writers differ.
function percent(bytes: Uint8Array, safe: RegExp, plus: boolean, lower: boolean): string {
  let out = "";
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    const escape = `%${HEX.charAt(b >> 4)}${HEX.charAt(b & 15)}`;
    out += safe.test(c) ? c : plus && b === 0x20 ? "+" : lower ? escape : escape.toUpperCase();
  }
  return out;
}

function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

// As JSON.stringify writes the string, and as an ASCII-only writer does (Python's json.dumps by default): every code
// unit from 0x7f up, DEL included, as \uXXXX.
function jsonForms(text: string): string[] {
  const plain = JSON.stringify(text).slice(1, -1);
  let only = "";
  for (let i = 0; i < plain.length; i++) {
    const n = plain.charCodeAt(i);
    only += n >= 0x7f ? `\\u${n.toString(16).padStart(4, "0")}` : plain.charAt(i);
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

// Every form of a value, each once: raw; hex in lower and upper case; percent-encoded as each writer above does it, with
// upper- and lower-case escapes; JSON-escaped (as is, and ASCII-only) when the value is UTF-8; and base64 and base64url
// at each of the three alignments.
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
  add("hex", null, ascii(hexOf(value).toUpperCase()));
  for (const w of PERCENT_WRITERS) for (const lower of [false, true]) add("percent", null, ascii(percent(value, w.safe, w.plus, lower)));
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

// ---- Index entries and the scanner

// HMAC-SHA-256 under the node's index key, from an adapter: the index holds only its output, never a form.
export type Keyed = (bytes: Uint8Array) => Uint8Array;
// The scanner's window, and the floor: a value under 8 bytes is not indexed (design §8.1), so every form is at least this.
export const SCAN_WINDOW = 8;
// `head` is the keyed hash of the form's first SCAN_WINDOW bytes, `full` of the whole form, both hex.
export type IndexEntry = {
  encoding: SecretEncoding; alignment: 0 | 1 | 2 | null; length: number; head: string; full: string; before: number; after: number;
};
export type Indexed = { kind: "indexed"; entries: IndexEntry[] } | { kind: "too_short" };
// Byte offsets in the stream, end exclusive.
export type ScanRange = { start: number; end: number };
// `settled`: no range found later starts before it, so the bytes before it can be passed on once the ranges are applied.
export type ScanStep = { ranges: ScanRange[]; settled: number };
export type Scanner = { push(chunk: Uint8Array): ScanStep; end(): ScanStep };

const PAD = 0x3d;   // "=": base64 padding after a form carries no bits, but a redaction takes it with the form

export function indexValue(value: Uint8Array, keyed: Keyed): Indexed {
  if (value.length < SCAN_WINDOW) return { kind: "too_short" };
  const entries = encodedForms(value).map(f => ({
    encoding: f.encoding, alignment: f.alignment, length: f.bytes.length, head: hexOf(keyed(f.bytes.subarray(0, SCAN_WINDOW))),
    full: hexOf(keyed(f.bytes)), before: f.before, after: f.after,
  }));
  return { kind: "indexed", entries };
}

const isBase64 = (e: IndexEntry) => e.encoding === "base64" || e.encoding === "base64url";
// How far past its start a match of this entry can reach, its padding included.
const reachOf = (e: IndexEntry) => e.length + e.after + (isBase64(e) ? 2 : 0);

function mergeRanges(ranges: readonly ScanRange[]): ScanRange[] {
  const out: ScanRange[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// Rolls an 8-byte window over the stream: each window's keyed hash is looked up among the heads, and a candidate is
// confirmed with the keyed hash of its full length. A position is checked once the longest match from it could have
// arrived, so the bytes from the first unchecked position on are held back; at the end, every position left is checked
// with what there is.
export function createScanner(entries: readonly IndexEntry[], keyed: Keyed): Scanner {
  // One pass, no argument spread: an index of many versions would overflow the call stack (T-88).
  const heads = new Map<string, IndexEntry[]>();
  let maxReach = SCAN_WINDOW;
  let maxBefore = 0;
  for (const e of entries) {
    const same = heads.get(e.head);
    if (same) same.push(e);
    else heads.set(e.head, [e]);
    maxReach = Math.max(maxReach, reachOf(e));
    maxBefore = Math.max(maxBefore, e.before);
  }
  let held = new Uint8Array(0);   // the bytes from `base` on
  let base = 0;
  let next = 0;                   // the first position not yet checked
  const total = () => base + held.length;
  const at = (i: number, n: number) => held.subarray(i - base, i - base + n);

  const check = (i: number, found: ScanRange[]) => {
    if (heads.size === 0 || i + SCAN_WINDOW > total()) return;
    for (const e of heads.get(hexOf(keyed(at(i, SCAN_WINDOW)))) ?? []) {
      if (i + e.length > total() || hexOf(keyed(at(i, e.length))) !== e.full) continue;
      let end = Math.min(total(), i + e.length + e.after);
      if (isBase64(e)) for (let p = 0; p < 2 && end < total() && held[end - base] === PAD; p++) end++;
      found.push({ start: Math.max(0, i - e.before), end });
    }
  };

  return {
    push(chunk) {
      const grown = new Uint8Array(held.length + chunk.length);
      grown.set(held);
      grown.set(chunk, held.length);
      held = grown;
      const found: ScanRange[] = [];
      for (; next + maxReach <= total(); next++) check(next, found);
      held = held.subarray(next - base);
      base = next;
      return { ranges: mergeRanges(found), settled: Math.max(0, next - maxBefore) };
    },
    end() {
      const found: ScanRange[] = [];
      for (; next < total(); next++) check(next, found);
      held = new Uint8Array(0);
      base = next;
      return { ranges: mergeRanges(found), settled: next };
    },
  };
}

// One piece: every range, merged.
export function scan(bytes: Uint8Array, entries: readonly IndexEntry[], keyed: Keyed): ScanRange[] {
  const s = createScanner(entries, keyed);
  return mergeRanges([...s.push(bytes).ranges, ...s.end().ranges]);
}

// ---- The index: what the Secrets service writes and every output path reads (design §8.1)

// A retired version stays indexed this long after its rotation or revocation.
export const RETIRED_KEPT_MS = 30 * 86_400_000;
export type IndexedVersion = { reference: string; version: number; retiredAt: number | null; entries: readonly IndexEntry[] };
// The highest version of a Reference that pruning dropped. Versions are never reused, so one at or under it is a replay.
export type PrunedThrough = { reference: string; through: number };
export type SecretIndex = { format: 1; versions: readonly IndexedVersion[]; pruned: readonly PrunedThrough[] };
export const emptySecretIndex = (): SecretIndex => ({ format: 1, versions: [], pruned: [] });

const sameVersion = (v: IndexedVersion, reference: string, version: number) => v.reference === reference && v.version === version;

// A version's entries: added live, or put in place of the same (Reference, version). A retired version stays retired from
// its first time, so adding it again can't restart its 30 days (T-88). One at or under the Reference's pruned mark is a
// replay, since versions are never reused, and changes nothing (T-94).
export function withVersion(index: SecretIndex, reference: string, version: number, entries: readonly IndexEntry[]): SecretIndex {
  if (index.pruned.some(p => p.reference === reference && version <= p.through)) return index;
  const retiredAt = index.versions.find(v => sameVersion(v, reference, version))?.retiredAt ?? null;
  return { ...index, versions: [...index.versions.filter(v => !sameVersion(v, reference, version)), { reference, version, retiredAt, entries: [...entries] }] };
}

// Retiring again keeps the first time, so the 30 days can't be stretched.
export function retireVersion(index: SecretIndex, reference: string, version: number, at: number): SecretIndex {
  return { ...index, versions: index.versions.map(v => sameVersion(v, reference, version) && v.retiredAt === null ? { ...v, retiredAt: at } : v) };
}

const kept = (v: IndexedVersion, now: number) => v.retiredAt === null || now - v.retiredAt <= RETIRED_KEPT_MS;

// What the scanner looks for now: every live version, and every retired one for 30 days.
export const liveEntries = (index: SecretIndex, now: number): IndexEntry[] => index.versions.filter(v => kept(v, now)).flatMap(v => v.entries);

// Drops what the 30 days no longer cover, and raises each such Reference's mark to the highest version dropped.
export function pruneIndex(index: SecretIndex, now: number): SecretIndex {
  const through = new Map(index.pruned.map(p => [p.reference, p.through]));
  for (const v of index.versions) if (!kept(v, now)) through.set(v.reference, Math.max(through.get(v.reference) ?? 0, v.version));
  return { format: 1, versions: index.versions.filter(v => kept(v, now)), pruned: [...through].map(([reference, n]) => ({ reference, through: n })) };
}

// The file's text: References, versions, times and keyed hashes, never a form.
export const serializeIndex = (index: SecretIndex): string => `${JSON.stringify(index)}\n`;

const HEX64 = /^[0-9a-f]{64}$/;
const ENCODINGS: readonly string[] = ["raw", "hex", "percent", "json", "base64", "base64url"];
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const keysAre = (x: Record<string, unknown>, keys: readonly string[]) => Object.keys(x).length === keys.length && keys.every(k => k in x);
const count = (x: unknown, min: number, max: number) => Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;

function entryOf(x: unknown): IndexEntry | null {
  if (!isRecord(x) || !keysAre(x, ["encoding", "alignment", "length", "head", "full", "before", "after"])) return null;
  const { encoding, alignment, length, head, full, before, after } = x;
  if (typeof encoding !== "string" || !ENCODINGS.includes(encoding)) return null;
  const base64 = encoding === "base64" || encoding === "base64url";
  if (base64 ? !(alignment === 0 || alignment === 1 || alignment === 2) : alignment !== null) return null;
  if (!count(length, SCAN_WINDOW, 1 << 20) || !count(before, 0, 1) || !count(after, 0, 1)) return null;
  if (typeof head !== "string" || !HEX64.test(head) || typeof full !== "string" || !HEX64.test(full)) return null;
  return { encoding: encoding as SecretEncoding, alignment: alignment as 0 | 1 | 2 | null, length: length as number, head, full, before: before as number, after: after as number };
}

function versionOf(x: unknown): IndexedVersion | null {
  if (!isRecord(x) || !keysAre(x, ["reference", "version", "retiredAt", "entries"])) return null;
  const { reference, version, retiredAt, entries } = x;
  if (typeof reference !== "string" || parseReference(reference) === null || !count(version, 1, Number.MAX_SAFE_INTEGER)) return null;
  if (retiredAt !== null && !(typeof retiredAt === "number" && Number.isFinite(retiredAt))) return null;
  if (!Array.isArray(entries)) return null;
  const parsed = entries.map(entryOf);
  return parsed.every(e => e !== null) ? { reference, version: version as number, retiredAt, entries: parsed as IndexEntry[] } : null;
}

function prunedOf(x: unknown): PrunedThrough | null {
  if (!isRecord(x) || !keysAre(x, ["reference", "through"])) return null;
  const { reference, through } = x;
  if (typeof reference !== "string" || parseReference(reference) === null || !count(through, 1, Number.MAX_SAFE_INTEGER)) return null;
  return { reference, through: through as number };
}

// The file's text back, or null: anything it doesn't expect, an unknown key included, refuses the whole file.
export function parseIndex(text: string): SecretIndex | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isRecord(doc) || !keysAre(doc, ["format", "versions", "pruned"]) || doc.format !== 1) return null;
  if (!Array.isArray(doc.versions) || !Array.isArray(doc.pruned)) return null;
  const versions = doc.versions.map(versionOf);
  const pruned = doc.pruned.map(prunedOf);
  if (!versions.every(v => v !== null) || !pruned.every(p => p !== null)) return null;
  // Each Reference once: two marks for one would leave which one holds to the reader.
  if (new Set(pruned.map(p => (p as PrunedThrough).reference)).size !== pruned.length) return null;
  return { format: 1, versions: versions as IndexedVersion[], pruned: pruned as PrunedThrough[] };
}
