// Review round 2 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real commands where the point is about them. Values, References and names are synthetic.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Encrypter } from "age-encryption";
import { NodeKeys } from "../src/adapters/node-keys.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";
import { FileVault } from "../src/adapters/vault-file.ts";
import { openHome, secretIndexPath } from "../src/compose.ts";
import { readSecretIndex } from "@morndo/node-ops";
import { runSecrets, type SecretsIo } from "../src/secrets-cli.ts";

// Several real commands per test (age, SQLite, the index): seconds alone, more under load, as in round 1.
vi.setConfig({ testTimeout: 60_000 });

const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const THIRD = "secret://example-app/third-token";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-review2-"));
  dirs.push(root);
  const dir = join(root, "connections");
  const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir };
  delete env.MORNDO_VAULT;
  return { root, dir, vault: join(dir, "vault"), env };
}

async function cli(env: NodeJS.ProcessEnv, args: string[], opts: { stdin?: string | null; typed?: string | null } = {}) {
  let stdout = "";
  let stderr = "";
  const io: SecretsIo = {
    stdout: t => { stdout += t; },
    stderr: t => { stderr += t; },
    stdin: opts.stdin === undefined || opts.stdin === null ? null : new TextEncoder().encode(opts.stdin),
    confirm: async () => (opts.typed === undefined ? null : opts.typed),
  };
  const code = await runSecrets(args, env, io);
  return { code, stdout, stderr };
}
const put = (env: NodeJS.ProcessEnv, value: string, ref = REF) => cli(env, ["put", ref], { stdin: `${value}\n`, typed: ref });
const sealed = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith(".age")).sort() : []);

describe("round 2, point 1: a first value under 8 bytes never stops a later put", () => {
  it("put of a 4-byte value, then of a normal one: both are stored, and the index key is made for the second", async () => {
    const h = home();
    const short = await put(h.env, "1234");
    expect(short.code, short.stderr).toBe(0);
    expect(existsSync(join(h.dir, "index.key"))).toBe(false);
    const normal = await put(h.env, "synthetic-long-value-two", OTHER);
    expect(normal.code, normal.stderr).toBe(0);
    expect(existsSync(join(h.dir, "index.key"))).toBe(true);
    expect(readSecretIndex(secretIndexPath(h.dir)).versions.map(v => v.reference)).toEqual([OTHER]);
    expect(sealed(h.vault)).toHaveLength(2);
  });
  it("index.key deleted while the index holds hashes made with it still stops the command, and makes no key", async () => {
    const h = home();
    expect((await put(h.env, "1234")).code).toBe(0);
    expect((await put(h.env, "synthetic-long-value-two", OTHER)).code).toBe(0);
    rmSync(join(h.dir, "index.key"));
    const r = await put(h.env, "synthetic-long-value-three", THIRD);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/index\.key is missing/);
    expect(existsSync(join(h.dir, "index.key"))).toBe(false);
    expect(sealed(h.vault)).toHaveLength(2);
  });
});

describe("round 2, points 2 and 5: revoke and delete on the plaintext vault destroy the age vault's file, or say what is left", () => {
  for (const verb of ["revoke", "delete"]) {
    it(`${verb} run with MORNDO_VAULT=file removes the sealed file the age vault wrote`, async () => {
      const h = home();
      expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
      expect(sealed(h.vault)).toHaveLength(1);
      const r = await cli({ ...h.env, MORNDO_VAULT: "file" }, [verb, REF], { typed: REF });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`${verb}d ${REF}`);
      expect(readdirSync(h.vault)).toEqual([]);
    });
  }
  it("a version whose file is in neither form is named as left to clean (exit 3), never passed over", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    for (const name of sealed(h.vault)) rmSync(join(h.vault, name));
    const r = await cli({ ...h.env, MORNDO_VAULT: "file" }, ["revoke", REF], { typed: REF });
    expect(r.code, r.stderr).toBe(3);
    expect(r.stdout).toContain(`revoked ${REF}`);
    expect(r.stderr).toMatch(/left to clean: vault: .*s-[0-9a-f]{16}/);
  });
  it("FileVault.remove refuses a ref it finds no file of, in either form", () => {
    const h = home();
    expect(() => new FileVault(h.vault).remove("s-00000000000000e1")).toThrow(/s-00000000000000e1/);
  });
});

describe("round 2, point 9: the node keys refuse to remake a key while hashes made with it are on record, on every composition root", () => {
  it("openHome's vault, built with no keys of its own, refuses to make a new fingerprint key while the ledger holds fingerprints", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    rmSync(join(h.dir, "fingerprint.key"));
    const ref = (sealed(h.vault)[0] ?? "").replace(/\.age$/, "");
    const opened = openHome(h.env);
    try {
      await expect(opened.vault.keyedFingerprint(ref)).rejects.toThrow(/fingerprint\.key is missing/);
      const e = new Encrypter();
      e.addRecipient(await new AgeVault(h.vault, join(h.dir, "identity")).recipient());
      await expect(opened.vault.storeSealed("s-00000000000000f1", await e.encrypt(new TextEncoder().encode("synthetic-value-two"))))
        .rejects.toThrow(/fingerprint\.key is missing/);
    } finally {
      opened.close();
    }
    expect(existsSync(join(h.dir, "fingerprint.key"))).toBe(false);
    expect(existsSync(join(h.vault, "s-00000000000000f1.age"))).toBe(false);
  });
  it("NodeKeys given no records reads the home's: the index key is refused while the index holds hashes made with it", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    rmSync(join(h.dir, "index.key"));
    expect(() => new NodeKeys(h.dir).index(new TextEncoder().encode("synthetic"))).toThrow(/index\.key is missing/);
    expect(existsSync(join(h.dir, "index.key"))).toBe(false);
  });
});
