// Every text the hub sends the app (ADR-0018 §6.2): API-key shapes are blanked at the output boundary. Logs already
// go through the full redactor. These views keep emails and paths, which the principal is reading on purpose, and
// blank only key material. The live terminal is not one of these views.
//
// Deny by default: every string in a frame or a REST body is visited. A frame type this hub does not know is redacted
// the same way, never passed through.
import { redactKeyMaterial } from "@morndo/protocol";

const blank = (v: unknown): unknown => (typeof v === "string" ? redactKeyMaterial(v) : v);
const OPAQUE = new Set(["publicKey", "signature", "challenge"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function walk(v: unknown): unknown {
  if (Array.isArray(v)) {
    let same = true;
    const next = v.map(item => {
      const n = walk(item);
      if (n !== item) same = false;
      return n;
    });
    return same ? v : next;
  }
  if (isRecord(v)) {
    let same = true;
    const next: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(v)) {
      // A WebAuthn options object is opaque. A question's options are an array, and those descriptions still blank.
      if ((OPAQUE.has(name) && typeof val === "string") || (name === "options" && isRecord(val) && !Array.isArray(val))) {
        next[name] = val;
        continue;
      }
      const n = walk(val);
      if (n !== val) same = false;
      next[name] = n;
    }
    return same ? v : next;
  }
  return blank(v);
}

export function redactFeed(frame: unknown): unknown {
  return walk(frame);
}

// Identity, pairing, login, step-up and the push key are ceremonies the client must receive unchanged. Every other
// JSON body still blanks key material.
export function redactResponse(path: string, body: unknown): unknown {
  if (path === "/api/identity" || path === "/api/identity/prove" || path === "/api/push/key"
    || path.startsWith("/api/pair/") || path.startsWith("/api/login/") || path.startsWith("/api/stepup/")) return body;
  return redactFeed(body);
}
