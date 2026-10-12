// Plain files at 0600, one per secret ref. The migration adapter (design section 5).
import { existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { assertPrivate, readPrivate, writePrivate } from "./file-mode.ts";
import { NodeKeys } from "./node-keys.ts";
import { MARK_SUFFIX, SEALED_SUFFIX, fingerprintOf, secretPath } from "./secret-ref.ts";
import { SecretMaterial } from "./secret-material.ts";
import type { SealedProblem, SealedStore } from "../application/ports.ts";
import type { Vault } from "./vault.ts";

export class FileVault implements Vault, SealedStore {
  readonly #dir: string;
  readonly #uid: number;
  readonly #keys: NodeKeys;
  // The node's keys sit in the Connections home, the vault directory's parent, beside the identity.
  constructor(dir: string, uid?: number, keys?: NodeKeys) {
    this.#dir = dir;
    this.#uid = uid ?? process.getuid?.() ?? -1;
    this.#keys = keys ?? new NodeKeys(dirname(dir), this.#uid);
  }

  async seal(ref: string, material: SecretMaterial): Promise<void> {
    writePrivate(this.#path(ref), material.bytes(), this.#uid);
  }

  async open(ref: string): Promise<SecretMaterial> {
    return new SecretMaterial(readPrivate(this.#path(ref), this.#uid));
  }

  has(ref: string): boolean {
    const path = this.#path(ref);
    if (!existsSync(path)) return false;
    assertPrivate(this.#dir, "dir", this.#uid);
    assertPrivate(path, "file", this.#uid);
    return true;
  }

  async fingerprint(ref: string): Promise<string | null> {
    if (!this.has(ref)) return null;
    return fingerprintOf((await this.open(ref)).bytes());
  }

  // A sealed value is never written as plaintext at rest: a node on this vault migrates to the age vault first (D1,
  // decided on T-85). Refused before anything is opened or written.
  async storeSealed(_ref: string, _sealed: Uint8Array): Promise<{ ok: true; fingerprint: string } | { ok: false; problem: SealedProblem }> {
    return { ok: false, problem: "plaintext_vault" };
  }

  // The plaintext vault never holds a sealed file (D1), so it lists none: its sweep must never touch the age vault's
  // files, which share the directory (review 1).
  refs(_prefix: string, _writtenBefore: number): readonly string[] {
    return [];
  }

  async keyedFingerprint(ref: string): Promise<string | null> {
    if (!this.has(ref)) return null;
    return this.#keys.fingerprint((await this.open(ref)).bytes());
  }

  // The ref's value, whichever vault wrote it: the plaintext file, or the age vault's sealed file (and its mark), which
  // share this directory, so a revoke or delete run on this vault still destroys a value the age vault holds (round 2,
  // points 2 and 5). A ref with neither is refused, never passed over: the caller must learn that nothing was removed.
  remove(ref: string): void {
    const values = [this.#path(ref), secretPath(this.#dir, ref, SEALED_SUFFIX)].filter(path => existsSync(path));
    if (values.length === 0) throw new Error(`no file of ${ref} in ${this.#dir}, plaintext or sealed: nothing was removed`);
    for (const path of [...values, secretPath(this.#dir, ref, MARK_SUFFIX)]) {
      if (!existsSync(path)) continue;
      assertPrivate(this.#dir, "dir", this.#uid);
      assertPrivate(path, "file", this.#uid);
      unlinkSync(path);
    }
  }

  #path(ref: string): string {
    return secretPath(this.#dir, ref);
  }
}
