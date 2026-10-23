// The SSH-signature verifier (design §4.6 Verifier, §9.6, §10.2): node:crypto only, no dependency, so the first
// install and the updater agree with the same tool the release pipeline signs with. What it reads:
// PROTOCOL.sshsig, https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig (read 2026-10-21);
// ssh-keygen(1) `-Y sign`/`-Y verify`, OpenSSH 9.6p1, the local man page; Node 24 crypto.verify, which wants the
// algorithm null or undefined for Ed25519, https://nodejs.org/docs/latest-v24.x/api/crypto.html (read 2026-10-21);
// RFC 8709 for the ssh-ed25519 key and signature encodings. The exact signed bytes — "SSHSIG", then namespace,
// reserved, hash algorithm and the message's SHA-512, each as an SSH string, and no version field — were also
// checked live against `ssh-keygen -Y sign` output (apps/updater/test/verifier-sshsig.test.ts).
import { createHash, createPublicKey, verify, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { SignatureFact, Verifier } from "../application/ports.ts";

const BEGIN = "-----BEGIN SSH SIGNATURE-----";
const END = "-----END SSH SIGNATURE-----";
// Strict base64: ssh-keygen writes canonical armor, and Buffer.from would silently skip anything else.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const decoder = new TextDecoder();
const asText = (bytes: Uint8Array) => decoder.decode(bytes);
// An SSH string: uint32 big-endian length, then that many bytes (PROTOCOL.sshsig's "string").
const string = (bytes: Uint8Array) => {
  const head = new Uint8Array(4 + bytes.length);
  new DataView(head.buffer).setUint32(0, bytes.length);
  head.set(bytes, 4);
  return head;
};

// Reads SSH wire values from a blob; every read past the end is a malformed blob, never an exception.
class Reader {
  private at = 0;
  private readonly blob: Uint8Array;
  constructor(blob: Uint8Array) { this.blob = blob; }
  raw(n: number): Uint8Array | null {
    if (this.at + n > this.blob.length) return null;
    const part = this.blob.subarray(this.at, this.at + n);
    this.at += n;
    return part;
  }
  u32(): number | null {
    const b = this.raw(4);
    return b === null ? null : (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0);
  }
  str(): Uint8Array | null {
    const n = this.u32();
    return n === null ? null : this.raw(n);
  }
  get done() { return this.at === this.blob.length; }
}

const fingerprintOf = (blob: Uint8Array) =>
  `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

// ssh-ed25519 only: string "ssh-ed25519" + the raw key or signature bytes (32 for a key, 64 for a signature,
// RFC 8709). Anything else is another algorithm or a malformed blob.
function sshEd25519(blob: Uint8Array, bytes: number): { raw: Uint8Array; ok: boolean } {
  const r = new Reader(blob);
  const type = r.str();
  const raw = r.str();
  return { raw: raw ?? new Uint8Array(0), ok: type !== null && raw !== null && r.done && asText(type) === "ssh-ed25519" && raw.length === bytes };
}

export class SshSigVerifier implements Verifier {
  signatures(message: Uint8Array, sigFile: Uint8Array): SignatureFact[] {
    // The armor may hold several blocks, one per signer. Everything between the markers is base64; everything
    // outside them must be whitespace, so nothing can smuggle a second reading of the file past the caller.
    const text = asText(sigFile);
    const blocks: (Uint8Array | null)[] = [];
    let outside = "";
    for (let pos = 0, at = text.indexOf(BEGIN); at !== -1;) {
      const end = text.indexOf(END, at + BEGIN.length);
      if (end === -1) { outside += text.slice(pos); break; }
      outside += text.slice(pos, at);
      const body = text.slice(at + BEGIN.length, end).replace(/\s+/g, "");
      blocks.push(BASE64.test(body) ? Buffer.from(body, "base64") : null);
      pos = end + END.length;
      at = text.indexOf(BEGIN, pos);
      if (at === -1) outside += text.slice(pos);
    }
    if (blocks.length === 0) return [{ valid: false, fingerprint: "", namespace: "", reason: "no signature" }];
    if (outside.trim() !== "") return [{ valid: false, fingerprint: "", namespace: "", reason: "malformed armor" }];
    return blocks.map(block => block === null
      ? { valid: false, fingerprint: "", namespace: "", reason: "malformed armor" }
      : this.fact(message, block));
  }

  // One armored block: parse the blob strictly, then check it under node:crypto. Never throws.
  private fact(message: Uint8Array, blob: Uint8Array): SignatureFact {
    const bad = (reason: string, fingerprint = "", namespace = ""): SignatureFact => ({ valid: false, fingerprint, namespace, reason });
    try {
      const r = new Reader(blob);
      if (asText(r.raw(6) ?? new Uint8Array(0)) !== "SSHSIG" || r.u32() !== 1) return bad("malformed blob");
      const publickey = r.str();
      const namespace = r.str();
      const reserved = r.str();
      const hashAlgorithm = r.str();
      const signature = r.str();
      if (publickey === null || namespace === null || reserved === null || hashAlgorithm === null || signature === null || !r.done) {
        return bad("malformed blob");
      }
      const namespaceText = asText(namespace);
      if (namespaceText === "") return bad("malformed blob", fingerprintOf(publickey));
      // The fingerprint is ssh-keygen's own (the second field of `ssh-keygen -lf key.pub`), so a caller can tell
      // "a key we don't trust" from "the key we trust, bad signature" — set whichever way the checks below go.
      const fingerprint = fingerprintOf(publickey);
      const key = sshEd25519(publickey, 32);
      if (!key.ok) return bad("unsupported key", fingerprint, namespaceText);
      if (asText(hashAlgorithm) !== "sha512") return bad("unsupported hash", fingerprint, namespaceText);
      const sig = sshEd25519(signature, 64);
      if (!sig.ok) return bad("malformed blob", fingerprint, namespaceText);
      // What was signed: the magic, the namespace, reserved, the hash algorithm and H(message), each an SSH
      // string — the blob's own version field is not part of it (PROTOCOL.sshsig, checked live).
      const digest = createHash("sha512").update(message).digest();
      const signed = Buffer.concat([Buffer.from("SSHSIG", "latin1"), string(namespace), string(reserved), string(hashAlgorithm), string(digest)]);
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key.raw).toString("base64url") }, format: "jwk" });
      return verify(null, signed, publicKey, sig.raw)
        ? { valid: true, fingerprint, namespace: namespaceText, reason: "ok" }
        : bad("bad signature", fingerprint, namespaceText);
    } catch {
      return bad("malformed blob");
    }
  }

  sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  sha256File(path: string): Promise<string> {
    // Streamed: a files.json or a Manifest-sized document never has to sit in memory whole.
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(path);
      stream.on("data", chunk => hash.update(chunk));
      stream.on("error", error => { stream.destroy(); reject(error); });
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }
}

// An OpenSSH .pub line ("ssh-ed25519 AAAA… comment"): the base64 field is the key blob whose SHA-256, base64
// without padding, is the fingerprint ssh-keygen prints — the doctor and the tests use this to read the trust
// material exactly as the machine's own tools would.
export function fingerprintOfPublicKeyLine(line: string): string {
  const field = line.trim().split(/\s+/)[1] ?? "";
  if (field === "" || !BASE64.test(field)) throw new Error("not an OpenSSH public key line");
  return fingerprintOf(Buffer.from(field, "base64"));
}

// The control plane's own attempt id (updates §5.4, PR 6b): 16 random bytes, base64url, the fleet's own shape. Here
// because this module is the updater's one door to node:crypto (architecture test, §4.7).
export const randomAttemptId = (): string => randomBytes(16).toString("base64url");
