// The node's two keys besides its age identity (ADR-0022; design §6): the fingerprint key and the index key, 32 random
// bytes each, 0600, in the identity's directory. Each is made on first use with writeNew, which links the file into
// place and fails on one that exists, so two processes creating it at once end up with one key: the one that lost reads
// the winner's. createHmac and randomBytes: https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-12.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPrivate, writeNew } from "./file-mode.ts";

const KEY_BYTES = 32;

export class NodeKeys {
  readonly #dir: string;
  readonly #uid: number;
  constructor(dir: string, uid?: number, _mayCreate?: () => boolean) {
    this.#dir = dir;
    this.#uid = uid ?? process.getuid?.() ?? -1;
  }

  // The keyed fingerprint (SC2): the first 12 hex characters of HMAC-SHA-256 under the fingerprint key.
  fingerprint(value: Uint8Array): string {
    return createHmac("sha256", this.#key("fingerprint.key")).update(value).digest("hex").slice(0, 12);
  }

  // HMAC-SHA-256 under the index key: the scanner's Keyed (packages/node-ops secret-scan.ts).
  index(bytes: Uint8Array): Uint8Array {
    return new Uint8Array(createHmac("sha256", this.#key("index.key")).update(bytes).digest());
  }

  // Read each time, so a key file loosened or swapped since is refused, not used from memory.
  #key(name: string): Uint8Array {
    const path = join(this.#dir, name);
    if (!existsSync(path)) writeNew(path, new Uint8Array(randomBytes(KEY_BYTES)), this.#uid);
    const key = readPrivate(path, this.#uid);
    if (key.length !== KEY_BYTES) throw new Error(`${path} is not a ${KEY_BYTES}-byte key`);
    return key;
  }
}
