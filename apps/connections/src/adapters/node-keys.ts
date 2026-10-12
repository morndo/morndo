// The node's two keys besides its age identity (ADR-0022; design §6): the fingerprint key and the index key, 32 random
// bytes each, 0600, in the identity's directory. Each is made on first use with writeNew, which links the file into
// place and fails on one that exists, so two processes creating it at once end up with one key: the one that lost reads
// the winner's. createHmac and randomBytes: https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-12.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "@morndo/domain";
import { readSecretIndex } from "@morndo/node-ops";
import { readPrivate, writeNew } from "./file-mode.ts";
import { secretIndexPath } from "./secret-index-writer.ts";
import { SqliteSecrets } from "./secrets-sqlite.ts";

const KEY_BYTES = 32;

export type NodeKey = "fingerprint.key" | "index.key";
// A key file this node can't use: gone while hashes made with it are on record, or not a key. A file to restore, so the
// command exits as for any file problem (70), not as a refusal (round 2, point 8).
export class NodeKeyRefused extends Error {
  readonly problem: "missing" | "length";
  constructor(problem: "missing" | "length", message: string) {
    super(message);
    this.name = "NodeKeyRefused";
    this.problem = problem;
  }
}
// Whether anything made with a key is on record: then a missing key file must be restored, never made anew (review 6).
// One answer per key, as each has its own records (round 2, point 1).
export type KeyRecords = (key: NodeKey) => boolean;

// The records of a Connections home. The fingerprint key: any ledger entry, as every one holds a fingerprint made with it.
// The index key: a current version in the ledger, or hashes in the index file, either alone (round 3, point 3), so losing
// the index file with the key never lets a new key in. The index writer makes the index key at the first store whatever
// the value's length, so a short first value doesn't stop later puts (round 2, point 1): a missing key is a lost one. An
// index file it can't read is refused (IndexFileRefused), never taken as empty.
export function homeRecords(dir: string, ledger: () => readonly LedgerEntry[], uid?: number): KeyRecords {
  return key => key === "fingerprint.key" ? ledger().length > 0
    : ledger().some(e => e.state === "current") || readSecretIndex(secretIndexPath(dir), uid).versions.some(v => v.entries.length > 0);
}

// Whether the home's Connections database holds a ledger entry: opened only when a key is missing, then closed. With no
// database, nothing is on record yet.
function ledgerIn(dir: string, uid: number): readonly LedgerEntry[] {
  const path = join(dir, "connections.db");
  if (!existsSync(path)) return [];
  const secrets = new SqliteSecrets(path, uid);
  try { return secrets.load().directory.ledger; } finally { secrets.close(); }
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
        throw new NodeKeyRefused("missing", `${path} is missing while hashes made with it are on record: restore it from where the identity is kept; a new key would let a revoked value in again and blind the output filter`);
      }
      writeNew(path, new Uint8Array(randomBytes(KEY_BYTES)), this.#uid);
    }
    const key = readPrivate(path, this.#uid);
    if (key.length !== KEY_BYTES) throw new NodeKeyRefused("length", `${path} is not a ${KEY_BYTES}-byte key`);
    return key;
  }
}
