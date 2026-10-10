// Plain files at 0600, one per secret ref. The migration adapter (design section 5).
import { existsSync, unlinkSync } from "node:fs";
import { assertPrivate, readPrivate, writePrivate } from "./file-mode.ts";
import { fingerprintOf, secretPath } from "./secret-ref.ts";
import { SecretMaterial } from "./secret-material.ts";
import type { Vault } from "./vault.ts";

export class FileVault implements Vault {
  readonly #dir: string;
  readonly #uid: number;
  constructor(dir: string, uid?: number) {
    this.#dir = dir;
    this.#uid = uid ?? process.getuid?.() ?? -1;
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
