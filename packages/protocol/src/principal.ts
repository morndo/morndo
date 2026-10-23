// The principal's proof on the wire (updates design §5.4, PR 6c): the hub signs one assertion — what it asks for
// (resume a Rollout, apply a Version to a node), until when it is good, and a nonce — and sends it as
// x-morndo-principal: <base64url payload>.<base64url signature>, the signature Ed25519 over "morndo-principal:" plus
// the payload's exact bytes as sent. This file is the shapes and the byte moves, pure: the hub's signer makes the
// signature (apps/hub/src/adapters/principal-signer.ts), the fleet's check verifies it under the key its config pins
// (apps/fleet/src/adapters/principal-check.ts), and both ends meet over exactly these functions — so a payload that
// changed one byte on the way would fail the signature, not the schema. The package runs in the browser too, so the
// base64url codec is written by hand over Uint8Array: no node:*, no Buffer (docs/design/fleet-core/README.md §12).
import * as z from "./z.ts";
import { SEMVER } from "./releases.ts";
import { NODE_NAME } from "./worker-id.ts";

// The header the assertion travels in, and the prefix the signature is computed over — the prefix so a signed
// assertion can never double as a signed document of another format.
export const PRINCIPAL_HEADER = "x-morndo-principal";
export const PRINCIPAL_SIGN_PREFIX = "morndo-principal:";
// How far ahead of the fleet's own clock an exp may sit: enough for a hub and a fleet a little apart, never a shelf
// life (§5.4). The nonce cache keeps each nonce until its exp, so this is also how long that memory holds one entry.
export const PRINCIPAL_MAX_AHEAD_MS = 60_000;
// 16 random bytes as base64url (22 characters, unpadded): the one-use word that makes a replayed proof worthless.
export const PRINCIPAL_NONCE = /^[A-Za-z0-9_-]{22}$/;

export type PrincipalOp = "rollout.resume" | "update.apply";
// What the proof is for: exactly one request. `node` only with update.apply — a resume is the fleet's, not a
// machine's, and a proof for one machine must not open another's door.
export type PrincipalAsk = { op: PrincipalOp; version: string; node?: string };
export type PrincipalAssertion = PrincipalAsk & { exp: number; nonce: string };

export const PrincipalAssertionSchema = z.strictObject({
  op: z.enum(["rollout.resume", "update.apply"]),
  version: z.string().check(z.regex(SEMVER), z.refine(v => !v.includes("+"), "a Release's Version carries no build metadata")),
  node: z.exactOptional(z.string().check(z.regex(NODE_NAME), z.refine(n => n !== "control-plane", "the control plane is the hub's own updater's, not a proof's"))),
  exp: z.int().check(z.gte(0)),
  nonce: z.string().check(z.regex(PRINCIPAL_NONCE)),
}).check(z.refine(a => (a.op === "update.apply") === (a.node !== undefined), "update.apply names a node; a resume names none"));

// ---- base64url (RFC 4648 §5), unpadded, over Uint8Array

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// 6 bits per character; 3 bytes (24 bits) per 4 characters, the tail carrying what is left without padding.
const toBase64url = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2]! + ALPHABET[(b0 & 3) << 4 | (b1 ?? 0) >> 4]!;
    if (b1 === undefined) break;
    out += ALPHABET[(b1 & 15) << 2 | (b2 ?? 0) >> 6]!;
    if (b2 === undefined) break;
    out += ALPHABET[b2 & 63]!;
  }
  return out;
};
// The way back, refusing anything that is not the alphabet and nothing padded: a value that isn't this codec's own
// shape is never decoded on a guess (a "=" is padding, a "+" is another codec's alphabet, both refused).
const fromBase64url = (text: string): Uint8Array | null => {
  if (text.length % 4 === 1) return null;                    // no whole 6-bit group ends in this shape
  const values = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const v = ALPHABET.indexOf(text[i]!);
    if (v === -1) return null;
    values[i] = v;
  }
  const bytes = new Uint8Array(Math.floor(text.length * 3 / 4));
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n = Math.min(4, text.length - i);
    const v0 = values[i]!, v1 = values[i + 1]!, v2 = values[i + 2] ?? 0, v3 = values[i + 3] ?? 0;
    bytes[at++] = v0 << 2 | v1 >> 4;
    if (n >= 3) bytes[at++] = (v1 & 15) << 4 | v2 >> 2;
    if (n === 4) bytes[at++] = (v2 & 3) << 6 | v3;
  }
  return bytes;
};

// The assertion as the signer writes it and the verifier reads it: one canonical spelling (op, version, node only
// with update.apply, exp, nonce), so the bytes the hub signed are the bytes the fleet checks — a payload re-encoded
// differently, however equivalently, would not verify.
export function principalPayloadText(a: PrincipalAssertion): string {
  const fields: [string, string][] = [
    ["op", JSON.stringify(a.op)],
    ["version", JSON.stringify(a.version)],
    ...(a.node === undefined ? [] : [["node", JSON.stringify(a.node)]] as [string, string][]),
    ["exp", String(a.exp)],
    ["nonce", JSON.stringify(a.nonce)],
  ];
  return `{${fields.map(([k, v]) => `${JSON.stringify(k)}:${v}`).join(",")}}`;
}

// UTF-8 with only what ECMAScript itself has: this package also runs in the browser, and its types include
// neither Buffer nor TextEncoder (tsconfig: lib esnext, no types) — fleet.ts's join codec does the same.
const utf8 = (s: string): Uint8Array => {
  const parts = encodeURIComponent(s).match(/%[0-9A-F]{2}|[^%]/g) ?? [];
  const bytes = new Uint8Array(parts.length);
  parts.forEach((p, i) => { bytes[i] = p.length === 3 ? parseInt(p.slice(1), 16) : p.charCodeAt(0); });
  return bytes;
};

// The header's value: the payload and its signature, both base64url, one "." between.
export function encodePrincipalHeader(payloadText: string, signature: Uint8Array): string {
  return `${toBase64url(utf8(payloadText))}.${toBase64url(signature)}`;
}

// The header's value back into its bytes, or null when it is not this shape: exactly one ".", both parts in the
// alphabet, a payload that is not empty and a signature that is exactly Ed25519's 64 bytes.
export function decodePrincipalHeader(value: string): { payload: Uint8Array; signature: Uint8Array } | null {
  const dot = value.indexOf(".");
  if (dot === -1 || value.indexOf(".", dot + 1) !== -1) return null;
  const payload = fromBase64url(value.slice(0, dot));
  const signature = fromBase64url(value.slice(dot + 1));
  if (payload === null || signature === null || payload.length === 0 || signature.length !== 64) return null;
  return { payload, signature };
}

// The payload's text as an assertion, or null: what a verifier parses only after the signature over these exact
// bytes verified, so a field it doesn't know is a refusal, never a guess.
export function parsePrincipalAssertion(payloadText: string): PrincipalAssertion | null {
  let doc: unknown;
  try { doc = JSON.parse(payloadText); } catch { return null; }
  const parsed = PrincipalAssertionSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}
