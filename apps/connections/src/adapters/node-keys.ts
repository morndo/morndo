// The node's two keys besides its age identity (ADR-0022; design §6): the fingerprint key and the index key, 32 random
// bytes each, 0600, in the identity's directory. Each is made on first use with writeNew, which links the file into
// place and fails on one that exists, so two processes creating it at once end up with one key: the one that lost reads
// the winner's. createHmac and randomBytes: https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-12.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readSecretIndex } from "@morndo/node-ops";
import { readPrivate, writeNew } from "./file-mode.ts";
import { secretIndexPath } from "./secret-index-writer.ts";
import { SqliteSecrets } from "./secrets-sqlite.ts";

const KEY_BYTES = 32;

export type NodeKey = "fingerprint.key" | "index.key";
// Whether anything made with a key is on record: then a missing key file must be restored, never made anew (review 6).
// One answer per key, as each has its own records (round 2, point 1).
export type KeyRecords = (key: NodeKey) => boolean;

// The records of a Connections home: the ledger's keyed fingerprints for the fingerprint key, and for the index key the
// index file's hashes, which only a value of 8 bytes or more makes; so a node whose first value was shorter still makes
// its index key on the first value that is indexed. An index file it can't read is refused (IndexFileRefused), never taken
// as empty.
export function homeRecords(dir: string, ledger: () => boolean, uid?: number): KeyRecords {
  return key => key === "fingerprint.key" ? ledger() : readSecretIndex(secretIndexPath(dir), uid).versions.some(v => v.entries.length > 0);
}

// Whether the home's Connections database holds a ledger entry: opened only when a key is missing, then closed. With no
// database, nothing is on record yet.
function ledgerIn(dir: string, uid: number): boolean {
  const path = join(dir, "connections.db");
  if (!existsSync(path)) return false;
  const secrets = new SqliteSecrets(path, uid);
  try { return secrets.load().directory.ledger.length > 0; } finally { secrets.close(); }
}

export class NodeKeys {
  readonly #dir: string;
  readonly #uid: number;
  readonly #onRecord: KeyRecords;
  // A missing key is made only while nothing made with it is on record (review 6): a new key would let a revoked value in
  // again under a new fingerprint and blind the output filter to every indexed value. Without `onRecord`, the records are
  // those of the home `dir` itself, so every composition root is guarded, not only the one that passes them (round 2,
  // point 9); one that holds the database open already passes its own.
  constructor(dir: string, uid?: number, onRecord?: KeyRecords) {
    this.#dir = dir;
    this.#uid = uid ?? process.getuid?.() ?? -1;
    const owner = this.#uid;
    this.#onRecord = onRecord ?? homeRecords(dir, () => ledgerIn(dir, owner), owner);
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
  #key(name: NodeKey): Uint8Array {
    const path = join(this.#dir, name);
    if (!existsSync(path)) {
      if (this.#onRecord(name)) {
        throw new Error(`${path} is missing while hashes made with it are on record: restore it from where the identity is kept; a new key would let a revoked value in again and blind the output filter`);
      }
      writeNew(path, new Uint8Array(randomBytes(KEY_BYTES)), this.#uid);
    }
    const key = readPrivate(path, this.#uid);
    if (key.length !== KEY_BYTES) throw new Error(`${path} is not a ${KEY_BYTES}-byte key`);
    return key;
  }
}
