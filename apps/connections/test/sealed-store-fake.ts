// An in-memory SealedStore for the contract suite and the service tests. Its "sealed value" is JSON naming its recipients
// and carrying the value in base64, so the checks the real vault makes (one recipient stanza, this node's own) can be
// made the same way. The keyed fingerprint is HMAC-SHA-256 under a key of this fake node.
import { createHmac } from "node:crypto";
import { VALUE_MAX_BYTES } from "@morndo/node-ops";
import { RefNotRemoved, type SealedProblem, type SealedStore } from "../src/application/ports.ts";

export class MemorySealedStore implements SealedStore {
  readonly files = new Map<string, Uint8Array>();
  readonly writtenAt = new Map<string, number>();
  readonly #recipient: string;
  readonly #key: Uint8Array;
  readonly #now: () => number;
  constructor(recipient = "fake1-node-a", key = new Uint8Array(32).fill(9), now: () => number = () => Date.now()) {
    this.#recipient = recipient;
    this.#key = key;
    this.#now = now;
  }

  recipient(): string { return this.#recipient; }

  static seal(recipients: readonly string[], value: Uint8Array): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ to: recipients, value: Buffer.from(value).toString("base64") }));
  }

  async storeSealed(ref: string, sealed: Uint8Array): Promise<{ ok: true; fingerprint: string } | { ok: false; problem: SealedProblem }> {
    const doc = this.#parse(sealed);
    if (!doc) return { ok: false, problem: "not_age" };
    if (doc.to.length !== 1) return { ok: false, problem: "stanzas" };
    if (doc.to[0] !== this.#recipient) return { ok: false, problem: "foreign" };
    if (doc.value.length > VALUE_MAX_BYTES) return { ok: false, problem: "too_large" };
    this.files.set(ref, new Uint8Array(sealed));
    this.writtenAt.set(ref, this.#now());
    return { ok: true, fingerprint: this.#fingerprint(doc.value) };
  }

  has(ref: string): boolean { return this.files.has(ref); }

  async keyedFingerprint(ref: string): Promise<string | null> {
    const file = this.files.get(ref);
    const doc = file ? this.#parse(file) : null;
    return doc ? this.#fingerprint(doc.value) : null;
  }

  // As the vaults do: a ref with no file is reported, never passed over (round 3, point 5).
  remove(ref: string): void { if (!this.files.delete(ref)) throw new RefNotRemoved(ref, [], [], true); }

  refs(prefix: string, writtenBefore: number): readonly string[] {
    return [...this.files.keys()].filter(r => r.startsWith(prefix) && (this.writtenAt.get(r) ?? 0) < writtenBefore).sort();
  }

  async open(ref: string): Promise<{ bytes(): Uint8Array }> {
    const file = this.files.get(ref);
    const doc = file ? this.#parse(file) : null;
    if (!doc) throw new Error(`no such ref: ${ref}`);
    return { bytes: () => doc.value };
  }

  #fingerprint(value: Uint8Array): string {
    return createHmac("sha256", this.#key).update(value).digest("hex").slice(0, 12);
  }

  #parse(sealed: Uint8Array): { to: string[]; value: Uint8Array } | null {
    try {
      const doc = JSON.parse(new TextDecoder().decode(sealed)) as { to?: unknown; value?: unknown };
      if (!Array.isArray(doc.to) || !doc.to.every(t => typeof t === "string") || typeof doc.value !== "string") return null;
      return { to: doc.to as string[], value: new Uint8Array(Buffer.from(doc.value, "base64")) };
    } catch { return null; }
  }
}
