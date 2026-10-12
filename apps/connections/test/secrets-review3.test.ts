// Review round 3 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real commands where the point is about them. Values, References and names are synthetic.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretMaterial } from "../src/adapters/secret-material.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";
import { FileVault } from "../src/adapters/vault-file.ts";
import { run } from "../src/cli.ts";
import { secretIndexPath } from "../src/compose.ts";
import { runSecrets, stdinValue, type SecretsIo } from "../src/secrets-cli.ts";

// Several real commands per test (age, SQLite, the index): seconds alone, more under load, as in rounds 1 and 2.
vi.setConfig({ testTimeout: 60_000 });

const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-review3-"));
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

describe("round 3, point 3: a lost index key is refused while the ledger holds a current value, the index file lost too", () => {
  it("index.key and secret-index.json both gone, a 32-byte value current: put refuses (70) and makes no key", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-of-32-bytes-0001")).code).toBe(0);
    rmSync(join(h.dir, "index.key"));
    rmSync(secretIndexPath(h.dir));
    const r = await put(h.env, "synthetic-long-value-two", OTHER);
    expect(r.code, r.stderr).toBe(70);
    expect(r.stderr).toMatch(/index\.key is missing/);
    expect(existsSync(join(h.dir, "index.key"))).toBe(false);
    expect(sealed(h.vault)).toHaveLength(1);
  });
});

// The Connections CLI (morndo-keys) on the same home, for the points about its vault/ directory.
const CATALOG = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const KEY = "sk-ant-synthetic-test-key-0001";
async function keys(env: NodeJS.ProcessEnv, args: string[], stdin = "") {
  let stdout = "";
  let stderr = "";
  const code = await run(args, { ...env, MORNDO_CATALOG: CATALOG }, { stdin, stdout: t => { stdout += t; }, stderr: t => { stderr += t; } });
  return { code, stdout, stderr };
}
const ADD = ["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "prepaid", "--budget", "10", "--expires", "1893456000000"];
const plainKeys = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(n => n.startsWith("key-")).sort() : []);

describe("round 3, point 6: removal works both ways in the shared vault directory", () => {
  it("AgeVault.remove removes a plaintext file the plaintext vault wrote under the ref", async () => {
    const h = home();
    await new FileVault(h.vault).seal("key-example-1-aa", new SecretMaterial(new TextEncoder().encode("synthetic-connection-key")));
    new AgeVault(h.vault, join(h.dir, "identity")).remove("key-example-1-aa");
    expect(readdirSync(h.vault)).toEqual([]);
  });
  it("a key added on the plaintext vault, then rotated on the age vault: the old plaintext file is gone", async () => {
    const h = home();
    expect((await keys({ ...h.env, MORNDO_VAULT: "file" }, ADD, KEY)).code).toBe(0);
    const before = plainKeys(h.vault);
    expect(before).toHaveLength(1);
    const r = await keys(h.env, ["rotate", "credit"], "sk-ant-synthetic-test-key-0003");
    expect(r.code, r.stderr).toBe(0);
    expect(plainKeys(h.vault).filter(n => !n.endsWith(".age") && !n.endsWith(".fingerprint"))).toEqual([]);
    expect(existsSync(join(h.vault, before[0] ?? ""))).toBe(false);
  });
});

describe("round 3, point 5: removal reports exactly what it removed and what is left, and leaves no orphan mark", () => {
  const REF5 = "s-00000000000000f5";
  it("both forms there, the sealed one loosened: the plaintext one goes, and the error says so and names the one left", async () => {
    const h = home();
    const vault = new FileVault(h.vault);
    await vault.seal(REF5, new SecretMaterial(new TextEncoder().encode("synthetic-value-five")));
    writeFileSync(join(h.vault, `${REF5}.age`), "synthetic", { mode: 0o600 });
    chmodSync(join(h.vault, `${REF5}.age`), 0o644);
    let message = "";
    try { vault.remove(REF5); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(existsSync(join(h.vault, REF5))).toBe(false);
    expect(existsSync(join(h.vault, `${REF5}.age`))).toBe(true);
    expect(message).toMatch(new RegExp(`removed ${REF5}(?![.\\w])`));
    expect(message).toMatch(new RegExp(`left ${REF5}\\.age`));
    expect(message).not.toMatch(/nothing was removed|was not removed/);
  });
  it("only a stray mark there: it is removed, and the error says no value file was there, not that nothing was removed", () => {
    const h = home();
    mkdirSync(h.vault, { recursive: true, mode: 0o700 });
    chmodSync(h.vault, 0o700);
    writeFileSync(join(h.vault, `${REF5}.age.fingerprint`), "synthetic", { mode: 0o600 });
    let message = "";
    try { new FileVault(h.vault).remove(REF5); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(existsSync(join(h.vault, `${REF5}.age.fingerprint`))).toBe(false);
    expect(message).toMatch(new RegExp(`no file of ${REF5}`));
    expect(message).toMatch(new RegExp(`removed ${REF5}\\.age\\.fingerprint`));
  });
  it("a revoke on the plaintext vault whose sealed file won't go names that file and why, not that the file was not removed", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-of-32-bytes-0005")).code).toBe(0);
    const [file] = sealed(h.vault);
    chmodSync(join(h.vault, file ?? ""), 0o644);
    const r = await cli({ ...h.env, MORNDO_VAULT: "file" }, ["revoke", REF], { typed: REF });
    expect(r.code, r.stderr).toBe(3);
    // Nothing went, so the report is the refusal of the file itself.
    expect(r.stderr).toMatch(new RegExp(`left to clean: vault: s-[0-9a-f]{16}: .*${(file ?? "").replace(".", "\\.")} is looser than a private file`));
    expect(r.stderr).not.toMatch(/was not removed/);
  });
});

describe("round 3, point 1: a committed rotation is never reported as failed when its old file can't be removed", () => {
  it("plaintext vault, the old file gone: rotate prints the new fingerprint, names the old file left to clean, exit 3", async () => {
    const h = home();
    const env = { ...h.env, MORNDO_VAULT: "file" };
    expect((await keys(env, ADD, KEY)).code).toBe(0);
    const [old] = plainKeys(h.vault);
    rmSync(join(h.vault, old ?? ""));
    const r = await keys(env, ["rotate", "credit"], "sk-ant-synthetic-test-key-0003");
    expect(r.code, r.stderr).toBe(3);
    expect((JSON.parse(r.stdout) as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(r.stderr).toMatch(new RegExp(`left to clean: vault: no file of ${old}`));
    const now = plainKeys(h.vault);
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(old);
    expect((await keys(env, ["rotate", "credit"], "sk-ant-synthetic-test-key-0004")).code).toBe(0);
  });
});

describe("round 3, point 4: stdin's chunks are zeroed when the stream fails midway", () => {
  it("two chunks read, then the stream errors: the read fails and both chunks are zeroed", async () => {
    const handed: Uint8Array[] = [];
    async function* failing() {
      for (const text of ["synthetic-", "value-four"]) {
        const chunk = new TextEncoder().encode(text);
        handed.push(chunk);
        yield chunk;
      }
      throw new Error("EIO: the pipe failed");
    }
    await expect(stdinValue(failing())).rejects.toThrow(/EIO/);
    expect(handed).toHaveLength(2);
    expect(handed.every(c => c.every(b => b === 0))).toBe(true);
  });
});
