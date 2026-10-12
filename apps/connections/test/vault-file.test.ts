// Plain 0600 files, the migration vault (design section 5). Synthetic bytes only.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRefused } from "../src/adapters/file-mode.ts";
import { SecretMaterial } from "../src/adapters/secret-material.ts";
import type { Vault } from "../src/adapters/vault.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";
import { FileVault } from "../src/adapters/vault-file.ts";
import { keysBeside } from "./fixtures/keys.ts";

const secret = new TextEncoder().encode("synthetic-key-0123456789ab");
const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 12);

describe("vault-file", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a secret and reports the sha-256 prefix", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    const vault: Vault = new FileVault(dir, keysBeside(dir));
    expect(vault.has("ref-a")).toBe(false);
    const sealed = vault.seal("ref-a", new SecretMaterial(secret));
    expect(sealed).toBeInstanceOf(Promise);
    await sealed;
    expect(vault.has("ref-a")).toBe(true);
    expect(await vault.fingerprint("ref-a")).toBe(fingerprint);
    expect((await vault.open("ref-a")).bytes()).toEqual(secret);
    expect(String(await vault.open("ref-a"))).toBe("[secret]");
    const file = statSync(join(dir, "ref-a"));
    expect(file.mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    vault.remove("ref-a");
    expect(vault.has("ref-a")).toBe(false);
    expect(await vault.fingerprint("ref-a")).toBeNull();
  });

  it("uses the same async calls as the age vault", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    const vaults: Vault[] = [new FileVault(join(dir, "files"), keysBeside(join(dir, "files"))), new AgeVault(join(dir, "age"), join(dir, "identity"), keysBeside(join(dir, "identity")))];
    for (const vault of vaults) {
      const sealed = vault.seal("ref-a", new SecretMaterial(secret));
      expect(sealed).toBeInstanceOf(Promise);
      await sealed;
      expect(await vault.fingerprint("ref-a")).toBe(fingerprint);
      expect((await vault.open("ref-a")).bytes()).toEqual(secret);
    }
  });

  it("refuses a 0644 file without reading it", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    const vault = new FileVault(dir, keysBeside(dir));
    await vault.seal("ref-a", new SecretMaterial(secret));
    chmodSync(join(dir, "ref-a"), 0o644);
    let reason = "";
    try { await vault.open("ref-a"); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("mode");
    await expect(vault.fingerprint("ref-a")).rejects.toThrow(FileRefused);
    expect(() => vault.remove("ref-a")).toThrow(FileRefused);
    expect(statSync(join(dir, "ref-a")).isFile()).toBe(true);
  });

  it("does not tighten a directory it did not create", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    const vaultDir = join(dir, "vault");
    mkdirSync(vaultDir);
    chmodSync(vaultDir, 0o755);
    let reason = "";
    try { await new FileVault(vaultDir, keysBeside(vaultDir)).seal("ref-a", new SecretMaterial(secret)); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("mode");
    expect(statSync(vaultDir).mode & 0o777).toBe(0o755);
  });

  it("refuses a foreign owner before changing the directory", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    chmodSync(dir, 0o755);
    let reason = "";
    try { await new FileVault(dir, keysBeside(dir, 0), 0).seal("ref-a", new SecretMaterial(secret)); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("owner");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("refuses a vault directly in the home directory or ~/.config", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    chmodSync(dir, 0o700);
    const config = join(dir, ".config");
    mkdirSync(config);
    chmodSync(config, 0o700);
    const previous = process.env.HOME;
    process.env.HOME = dir;
    try {
      await expect(new FileVault(dir, keysBeside(dir)).seal("ref-a", new SecretMaterial(secret))).rejects.toThrow(/home directory/);
      await expect(new FileVault(config, keysBeside(config)).seal("ref-a", new SecretMaterial(secret))).rejects.toThrow(/\.config/);
      expect(readdirSync(dir)).toEqual([".config"]);
      expect(readdirSync(config)).toEqual([]);
    } finally { process.env.HOME = previous; }
  });

  it("refuses a file owned by someone else", async () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-vault-file-"));
    await new FileVault(dir, keysBeside(dir)).seal("ref-a", new SecretMaterial(secret));
    const other = new FileVault(dir, keysBeside(dir, 0), 0);
    let reason = "";
    try { await other.open("ref-a"); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("owner");
  });
});
