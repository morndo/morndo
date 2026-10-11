// The index writer (ADR-0022; design §8.1): the node's exact filter, as the file every output path reads. A value is
// indexed from its vault file once, before the transaction that records it, and only its keyed hashes are kept; the
// write inside that transaction is synchronous: read the file as `readSecretIndex` does (a file it would refuse is
// refused here too), add, retire, prune, and put it back with a temp file and a rename at 0600.
import {
  indexValue, pruneIndex, readSecretIndex, retireVersion, serializeIndex, withVersion, type IndexEntry, type Keyed,
} from "@morndo/node-ops";
import type { IndexChange, IndexWriter, PreparedIndex } from "../application/ports.ts";
import { writePrivate } from "./file-mode.ts";

// The vault's `open`, structurally: this file must not import the secret material's class (architecture test).
type Opener = { open(ref: string): Promise<{ bytes(): Uint8Array }> };

export class SecretIndexWriter implements IndexWriter {
  readonly #path: string;
  readonly #keyed: Keyed;
  readonly #vault: Opener;
  readonly #uid: number;
  // What each PreparedIndex this writer made stands for: its entries, or null for a short value. Anything else is refused.
  readonly #prepared = new WeakMap<PreparedIndex, readonly IndexEntry[] | null>();
  constructor(path: string, keyed: Keyed, vault: Opener, uid?: number) {
    this.#path = path;
    this.#keyed = keyed;
    this.#vault = vault;
    this.#uid = uid ?? process.getuid?.() ?? -1;
  }

  async prepare(ref: string): Promise<PreparedIndex> {
    const indexed = indexValue((await this.#vault.open(ref)).bytes(), this.#keyed);
    const prepared: PreparedIndex = Object.freeze({ short: indexed.kind === "too_short" });
    this.#prepared.set(prepared, indexed.kind === "indexed" ? indexed.entries : null);
    return prepared;
  }

  write(change: IndexChange): void {
    const entries = change.add ? this.#prepared.get(change.add.prepared) : null;
    if (entries === undefined) throw new Error("the index writer refuses a prepared index it did not make");
    let index = readSecretIndex(this.#path, this.#uid);
    if (change.add && entries !== null) index = withVersion(index, change.add.reference, change.add.version, entries);
    for (const r of change.retire) index = retireVersion(index, r.reference, r.version, change.at);
    index = pruneIndex(index, change.at);
    writePrivate(this.#path, new TextEncoder().encode(serializeIndex(index)), this.#uid);
  }
}
