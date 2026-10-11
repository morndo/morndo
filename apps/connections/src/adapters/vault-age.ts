// One age file per secret, encrypted to the X25519 identity at identityPath (design section 5).
// age-encryption 0.3.1 exposes only promises: generateX25519Identity, identityToRecipient,
// Encrypter.encrypt and Decrypter.decrypt. The readme's example awaits every one of them.
// https://www.npmjs.com/package/age-encryption and https://github.com/FiloSottile/typage#readme
// checked 2026-10-10. There is no synchronous call, so this awaits the library. Each call is
// its own promise: a failure cannot wake or stall the next one, and no worker is left behind.
import { createHash } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { assertPrivate, readPrivate, refuseBareHome, writeNew, writePrivate, writePrivatePair } from "./file-mode.ts";
import { fingerprintOf, secretPath } from "./secret-ref.ts";
import { SecretMaterial } from "./secret-material.ts";
import type { SealedProblem, SealedStore } from "../application/ports.ts";
import type { Vault } from "./vault.ts";

export class AgeVault implements Vault, SealedStore {
  readonly #dir: string;
  readonly #identityPath: string;
  readonly #uid: number;
  #cached: { secret: string; ino: bigint; mtimeNs: bigint; mode: number; uid: number } | null = null;
  #recipient: string | null = null;
  #recipientFor: string | null = null;
  constructor(dir: string, identityPath: string, uid?: number) {
    this.#dir = dir;
    this.#identityPath = identityPath;
    this.#uid = uid ?? process.getuid?.() ?? -1;
  }

  async seal(ref: string, material: SecretMaterial): Promise<void> {
    const encrypter = new Encrypter();
    encrypter.addRecipient(await this.#recipientOf());
    const plain = material.bytes();
    const cipher = await encrypter.encrypt(plain);
    writePrivatePair(this.#file(ref), cipher, this.#mark(ref), markOf(plain, cipher), this.#uid);
  }

  async open(ref: string): Promise<SecretMaterial> {
    const decrypter = new Decrypter();
    decrypter.addIdentity(await this.#identity());
    const plain = await decrypter.decrypt(readPrivate(this.#file(ref), this.#uid), "uint8array");
    return new SecretMaterial(new Uint8Array(plain));
  }

  has(ref: string): boolean {
    const path = this.#file(ref);
    if (!existsSync(path)) return false;
    assertPrivate(this.#dir, "dir", this.#uid);
    assertPrivate(path, "file", this.#uid);
    return true;
  }

  async fingerprint(ref: string): Promise<string | null> {
    if (!this.has(ref)) return null;
    const cipher = readPrivate(this.#file(ref), this.#uid);
    const bound = boundFingerprint(cipher, this.#mark(ref), this.#uid);
    if (bound) return bound;
    if (existsSync(this.#mark(ref))) return null;
    const plain = (await this.open(ref)).bytes();
    writePrivate(this.#mark(ref), markOf(plain, cipher), this.#uid);
    return fingerprintOf(plain);
  }

  remove(ref: string): void {
    for (const path of [this.#file(ref), this.#mark(ref)]) {
      if (!existsSync(path)) continue;
      assertPrivate(this.#dir, "dir", this.#uid);
      assertPrivate(path, "file", this.#uid);
      unlinkSync(path);
    }
  }

  // The node's age recipient (age1…), from its identity, made on first use.
  async recipient(): Promise<string> {
    return this.#recipientOf();
  }

  async storeSealed(_ref: string, _sealed: Uint8Array): Promise<{ ok: true; fingerprint: string } | { ok: false; problem: SealedProblem }> {
    return { ok: false, problem: "not_age" };
  }

  async keyedFingerprint(_ref: string): Promise<string | null> {
    return null;
  }

  async #recipientOf(): Promise<string> {
    const identity = await this.#identity();
    if (this.#recipientFor !== identity || !this.#recipient) {
      this.#recipient = await identityToRecipient(identity);
      this.#recipientFor = identity;
    }
    return this.#recipient;
  }

  async #identity(): Promise<string> {
    refuseBareHome(this.#identityPath);
    if (!existsSync(this.#identityPath)) {
      const created = await generateX25519Identity();
      if (!created.startsWith("AGE-SECRET-KEY-1")) throw new Error("age failed");
      const text = created.endsWith("\n") ? created : `${created}\n`;
      writeNew(this.#identityPath, new TextEncoder().encode(text), this.#uid);
    }
    assertPrivate(dirname(this.#identityPath), "dir", this.#uid);
    assertPrivate(this.#identityPath, "file", this.#uid);
    const st = statSync(this.#identityPath, { bigint: true });
    const mode = Number(st.mode & 0o777n);
    const owner = Number(st.uid);
    if (this.#cached && this.#cached.ino === st.ino && this.#cached.mtimeNs === st.mtimeNs && this.#cached.mode === mode && this.#cached.uid === owner) {
      return this.#cached.secret;
    }
    const text = new TextDecoder().decode(readPrivate(this.#identityPath, this.#uid)).trim();
    if (!text.startsWith("AGE-SECRET-KEY-1")) throw new Error("age failed");
    this.#cached = { secret: text, ino: st.ino, mtimeNs: st.mtimeNs, mode, uid: owner };
    return text;
  }

  #file(ref: string): string {
    return secretPath(this.#dir, ref, ".age");
  }

  #mark(ref: string): string {
    return `${this.#file(ref)}.fingerprint`;
  }
}

function markOf(plain: Uint8Array, cipher: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(cipher).digest("hex");
  return new TextEncoder().encode(`${fingerprintOf(plain)} ${digest}\n`);
}

function boundFingerprint(cipher: Uint8Array, mark: string, uid: number): string | null {
  if (!existsSync(mark)) return null;
  const text = new TextDecoder().decode(readPrivate(mark, uid)).trim();
  const [fingerprint, digest] = text.split(" ");
  if (!fingerprint || !/^[0-9a-f]{12}$/.test(fingerprint) || !digest) return null;
  const actual = createHash("sha256").update(cipher).digest("hex");
  return digest === actual ? fingerprint : null;
}
