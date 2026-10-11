// The index writer (ADR-0022; design §8.1).
import type { Keyed } from "@morndo/node-ops";
import type { IndexChange, IndexWriter, PreparedIndex } from "../application/ports.ts";

type Opener = { open(ref: string): Promise<{ bytes(): Uint8Array }> };

export class SecretIndexWriter implements IndexWriter {
  readonly #path: string;
  readonly #keyed: Keyed;
  readonly #vault: Opener;
  readonly #uid: number;
  constructor(path: string, keyed: Keyed, vault: Opener, uid?: number) {
    this.#path = path;
    this.#keyed = keyed;
    this.#vault = vault;
    this.#uid = uid ?? process.getuid?.() ?? -1;
  }

  async prepare(ref: string): Promise<PreparedIndex> {
    void [ref, this.#keyed, this.#vault];
    return { short: false };
  }

  write(change: IndexChange): void {
    void [change, this.#path, this.#uid];
  }
}
