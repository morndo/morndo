// Plain files at 0600, one per secret ref. The migration adapter (design section 5).
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { assertPrivate, readPrivate, writePrivate } from "./file-mode.ts";
import { NodeKeys } from "./node-keys.ts";
import { fingerprintOf, refsIn, secretPath } from "./secret-ref.ts";
import { SecretMaterial } from "./secret-material.ts";
import type { SealedProblem, SealedStore } from "../application/ports.ts";
import type { Vault } from "./vault.ts";

const SUFFIX = "";

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

  // The refs of the files in the vault directory that start with `prefix`, for the startup sweep.
  refs(prefix: string): readonly string[] {
    if (!existsSync(this.#dir)) return [];
    assertPrivate(this.#dir, "dir", this.#uid);
    return refsIn(readdirSync(this.#dir), prefix, SUFFIX);
  }

  async keyedFingerprint(ref: string): Promise<string | null> {
    if (!this.has(ref)) return null;
    return this.#keys.fingerprint((await this.open(ref)).bytes());
  }

  remove(ref: string): void {
    const path = this.#path(ref);
    if (!existsSync(path)) return;
    assertPrivate(this.#dir, "dir", this.#uid);
    assertPrivate(path, "file", this.#uid);
    unlinkSync(path);
  }

  #path(ref: string): string {
    return secretPath(this.#dir, ref);
  }
}
