// age files and one machine identity (design section 5). Synthetic bytes only.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRefused } from "../src/adapters/file-mode.ts";
import { SecretMaterial } from "../src/adapters/secret-material.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";

const secret = new TextEncoder().encode("synthetic-key-0123456789ab");
const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 12);

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(path);
  }
  return found;
}

describe("vault-age", () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function paths() {
    root = mkdtempSync(join(tmpdir(), "morndo-vault-age-"));
    return { vault: join(root, "vault"), identity: join(root, "config", "identity") };
  }

  it("round-trips a secret as an age file, and the identity stays in its file", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    await vault.seal("ref-a", new SecretMaterial(secret));
    expect(await vault.fingerprint("ref-a")).toBe(fingerprint);
    const opened = await vault.open("ref-a");
    expect(opened.bytes()).toEqual(secret);
    expect(String(opened)).toBe("[secret]");
    const stored = readFileSync(join(dir, "ref-a.age"));
    expect(stored.subarray(0, 22).toString("utf8")).toBe("age-encryption.org/v1\n");
    expect(statSync(join(dir, "ref-a.age")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(identity).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "config")).mode & 0o777).toBe(0o700);
    const identityText = readFileSync(identity, "utf8");
    expect(identityText.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    const copies = filesUnder(root).filter(path => readFileSync(path).includes(Buffer.from(identityText.trim())));
    expect(copies).toEqual([identity]);
    expect(stored.includes(Buffer.from("AGE-SECRET-KEY-1"))).toBe(false);
  });

  it("refuses a 0644 identity and a 0644 ciphertext before reading them", async () => {
    const { vault: dir, identity } = paths();
    mkdirSync(join(root, "config"), { mode: 0o700 });
    writeFileSync(identity, "not-an-identity\n", { mode: 0o644 });
    const vault = new AgeVault(dir, identity);
    await expect(vault.seal("ref-a", new SecretMaterial(secret))).rejects.toBeInstanceOf(FileRefused);
    try { await vault.seal("ref-a", new SecretMaterial(secret)); } catch (error) {
      expect((error as FileRefused).reason).toBe("mode");
    }
    rmSync(identity);
    await vault.seal("ref-a", new SecretMaterial(secret));
    chmodSync(join(dir, "ref-a.age"), 0o644);
    let reason = "";
    try { await vault.open("ref-a"); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("mode");
  });

  it("uses one identity when two processes create it together", async () => {
    const { vault: dir, identity } = paths();
    const fixture = join(import.meta.dirname, "fixtures/seal-identity.ts");
    const run = (ref: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", fixture, dir, identity, ref]);
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.on("data", chunk => { err += chunk; });
      child.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)));
    });
    const [first, second] = await Promise.all([run("ref-a"), run("ref-b")]);
    expect(first).toBe(second);
    expect(readFileSync(identity, "utf8")).toBe(first);
    const vault = new AgeVault(dir, identity);
    expect((await vault.open("ref-a")).bytes()).toEqual(secret);
    expect((await vault.open("ref-b")).bytes()).toEqual(secret);
  });

  it("refuses an identity directly under the home directory or ~/.config", async () => {
    const { vault: dir } = paths();
    mkdirSync(join(root, ".config"));
    chmodSync(join(root, ".config"), 0o755);
    const previous = process.env.HOME;
    process.env.HOME = root;
    try {
      let bare = "";
      try { await new AgeVault(dir, join(root, "identity")).seal("ref-a", new SecretMaterial(secret)); } catch (error) {
        bare = error instanceof Error ? error.message : "";
      }
      expect(bare).toContain("home directory");
      let nested = "";
      try { await new AgeVault(dir, join(root, ".config", "identity")).seal("ref-a", new SecretMaterial(secret)); } catch (error) {
        nested = error instanceof Error ? error.message : "";
      }
      expect(nested).toContain(".config");
      expect(statSync(join(root, ".config")).mode & 0o777).toBe(0o755);
    } finally { process.env.HOME = previous; }
  });

  it("reports no fingerprint when the ciphertext is not the one that was sealed", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    const other = new TextEncoder().encode("synthetic-key-ffffffffffffffff");
    await vault.seal("ref-a", new SecretMaterial(secret));
    await vault.seal("ref-b", new SecretMaterial(other));
    writeFileSync(join(dir, "ref-a.age"), readFileSync(join(dir, "ref-b.age")));
    chmodSync(join(dir, "ref-a.age"), 0o600);
    expect(await vault.fingerprint("ref-a")).toBeNull();
    expect(vault.has("ref-a")).toBe(true);
  });

  it("fingerprints a secret it can no longer decrypt, and reuses the recipient", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    await vault.seal("ref-a", new SecretMaterial(secret));
    writeFileSync(join(dir, "ref-a.age"), Buffer.from("not-ciphertext"), { mode: 0o600 });
    expect(await vault.fingerprint("ref-a")).toBeNull();
    expect(await new AgeVault(dir, identity).fingerprint("ref-a")).toBeNull();
    await expect(vault.open("ref-a")).rejects.toThrow();
    chmodSync(identity, 0o000);
    await expect(vault.seal("ref-b", new SecretMaterial(secret))).rejects.toThrow();
    chmodSync(identity, 0o600);
    await vault.seal("ref-b", new SecretMaterial(secret));
    expect((await vault.open("ref-b")).bytes()).toEqual(secret);
  });

  it("seals two secrets at once without a shared worker", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    const other = new TextEncoder().encode("synthetic-key-ffffffffffffffff");
    await Promise.all([
      vault.seal("ref-a", new SecretMaterial(secret)),
      vault.seal("ref-b", new SecretMaterial(other)),
    ]);
    expect((await vault.open("ref-a")).bytes()).toEqual(secret);
    expect((await vault.open("ref-b")).bytes()).toEqual(other);
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/vault-age.ts"), "utf8");
    expect(source).not.toMatch(/Atomics\.(wait|store|notify)|new Worker/);
    expect(source).toContain("https://github.com/FiloSottile/typage#readme");
  });

  it("remembers a fingerprint for a secret sealed before the mark existed", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    await vault.seal("ref-a", new SecretMaterial(secret));
    const mark = join(dir, "ref-a.age.fingerprint");
    rmSync(mark);
    expect(vault.has("ref-a")).toBe(true);
    expect(await vault.fingerprint("ref-a")).toBe(fingerprint);
    expect(statSync(mark).isFile()).toBe(true);
    writeFileSync(identity, "AGE-SECRET-KEY-1not-the-original\n", { mode: 0o600 });
    expect(await new AgeVault(dir, identity).fingerprint("ref-a")).toBe(fingerprint);
  });

  it("rechecks the identity file on every open and seal", async () => {
    const { vault: dir, identity } = paths();
    const vault = new AgeVault(dir, identity);
    await vault.seal("ref-a", new SecretMaterial(secret));
    chmodSync(identity, 0o644);
    await expect(vault.open("ref-a")).rejects.toBeInstanceOf(FileRefused);
    await expect(vault.seal("ref-b", new SecretMaterial(secret))).rejects.toBeInstanceOf(FileRefused);
    chmodSync(identity, 0o600);
    expect((await vault.open("ref-a")).bytes()).toEqual(secret);
    writeFileSync(identity, "AGE-SECRET-KEY-1replaced\n", { mode: 0o600 });
    await expect(vault.open("ref-a")).rejects.toThrow();
  });

  it("refuses an identity owned by someone else", async () => {
    const { vault: dir, identity } = paths();
    await new AgeVault(dir, identity).seal("ref-a", new SecretMaterial(secret));
    let reason = "";
    try { await new AgeVault(dir, identity, 0).open("ref-a"); } catch (error) {
      reason = error instanceof FileRefused ? error.reason : "other";
    }
    expect(reason).toBe("owner");
  });
});
