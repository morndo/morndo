// Review round 1 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real bin where the point is about them. Values, References and names are synthetic.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@morndo/domain";
import { NodeKeys } from "../src/adapters/node-keys.ts";
import { SecretIndexWriter } from "../src/adapters/secret-index-writer.ts";
import { SecretMaterial } from "../src/adapters/secret-material.ts";
import { SqliteSecrets } from "../src/adapters/secrets-sqlite.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";
import { GitWorkspaceRoots } from "../src/adapters/git-workspaces.ts";
import { SecretsService } from "../src/application/secrets-service.ts";
import { secretIndexPath } from "../src/compose.ts";
import { VALUE_MAX_BYTES, readSecretIndex } from "@morndo/node-ops";
import { runSecrets, type SecretsIo } from "../src/secrets-cli.ts";

const REF = "secret://example-app/payments-test";
const OTHER = "secret://example-app/other-token";
const BIN = join(import.meta.dirname, "../src/secrets-main.ts");
const principal: Actor = { kind: "principal", command: "c1" };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), "morndo-secrets-review1-"));
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
const sealed = (dir: string) => readdirSync(dir).filter(n => n.endsWith(".age")).sort();

describe("review point 1 (data loss): a command on the plaintext vault never sweeps the age vault's files", () => {
  it("a Secret stored with the age vault, and a Connections key beside it, survive a command run with MORNDO_VAULT=file", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    await new AgeVault(h.vault, join(h.dir, "identity")).seal("key-example-1-aa", new SecretMaterial(new TextEncoder().encode("synthetic-connection-key")));
    const before = sealed(h.vault);
    expect(before).toHaveLength(2);
    for (const args of [["list"], ["log"], ["recipient"]]) await cli({ ...h.env, MORNDO_VAULT: "file" }, args);
    expect(sealed(h.vault)).toEqual(before);
    expect((await cli(h.env, ["list"])).stdout).toContain("\"status\":\"active\"");
  });
});

describe("review point 5 (data loss): the sweep never removes the file of a store in progress in another process", () => {
  it("another process's command runs its sweep between this store's vault write and its commit, and the store still lands", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    const keys = new NodeKeys(h.dir);
    const vault = new AgeVault(h.vault, join(h.dir, "identity"), undefined, keys);
    const secrets = new SqliteSecrets(join(h.dir, "connections.db"));
    const writer = new SecretIndexWriter(secretIndexPath(h.dir), b => keys.index(b), vault);
    const other: { status: number | null; stderr: string }[] = [];
    // The second process: the real bin, whose every command sweeps first.
    const index = {
      prepare: async (ref: string) => {
        const p = await writer.prepare(ref);
        const r = spawnSync(process.execPath, [BIN, "list"], { env: h.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
        other.push({ status: r.status, stderr: r.stderr });
        return p;
      },
      write: writer.write.bind(writer),
    };
    let n = 0;
    const service = new SecretsService({
      clock: { now: () => Date.now() }, ids: { next: prefix => `${prefix}00000000000000a${++n}` }, vault, index, secrets, roots: new GitWorkspaceRoots(),
    });
    const { Encrypter } = await import("age-encryption");
    const e = new Encrypter();
    e.addRecipient(await vault.recipient());
    const r = await service.store({
      reference: OTHER, sealed: await e.encrypt(new TextEncoder().encode("synthetic-value-two")), shape: null, grants: [], expiry: null,
      destinations: [], renew: false,
    }, principal).catch((error: unknown) => ({ ok: false, error: String(error) }));
    secrets.close();
    expect(other).toEqual([{ status: 0, stderr: "" }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(existsSync(join(h.vault, "s-00000000000000a1.age"))).toBe(true);
  });
  it("a file no version refers to is removed once it is older than the grace period, not before", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    const vault = new AgeVault(h.vault, join(h.dir, "identity"));
    const { Encrypter } = await import("age-encryption");
    const e = new Encrypter();
    e.addRecipient(await vault.recipient());
    const orphan = await e.encrypt(new TextEncoder().encode("synthetic-left-over"));
    await vault.storeSealed("s-00000000000000b1", orphan);
    await vault.storeSealed("s-00000000000000b2", orphan);
    const old = (Date.now() - 2 * 60 * 60_000) / 1000;
    utimesSync(join(h.vault, "s-00000000000000b2.age"), old, old);
    await cli(h.env, ["list"]);
    expect(existsSync(join(h.vault, "s-00000000000000b1.age"))).toBe(true);
    expect(existsSync(join(h.vault, "s-00000000000000b2.age"))).toBe(false);
  });
});

describe("review point 6 (fail-open): a missing node key, while hashes made with it are on record, stops the command", () => {
  for (const name of ["fingerprint.key", "index.key"]) {
    it(`${name} gone after a store: put refuses with a clear message and makes no new key`, async () => {
      const h = home();
      expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
      rmSync(join(h.dir, name));
      const r = await put(h.env, "synthetic-value-two", OTHER);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(new RegExp(`${name.replace(".", "\\.")} is missing`));
      expect(existsSync(join(h.dir, name))).toBe(false);
      expect(sealed(h.vault)).toHaveLength(1);
    });
  }
  it("on a node with nothing on record, the keys are made on first use", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    for (const name of ["fingerprint.key", "index.key"]) expect(existsSync(join(h.dir, name)), name).toBe(true);
  });
  it("NodeKeys refuses to make a key when told hashes made with it are on record", () => {
    const h = home();
    const keys = new NodeKeys(h.dir, undefined, () => false);
    expect(() => keys.fingerprint(new TextEncoder().encode("synthetic"))).toThrow(/fingerprint\.key is missing/);
    expect(existsSync(join(h.dir, "fingerprint.key"))).toBe(false);
  });
});

describe("review point 2: a value too large for the index is refused at put, before anything is stored", () => {
  it("VALUE_MAX_BYTES + 1 bytes is refused and leaves no vault file; VALUE_MAX_BYTES is stored and the index still reads", async () => {
    const h = home();
    const worst = (n: number) => "\u0001".repeat(n);
    const big = await cli(h.env, ["put", REF, "--raw"], { stdin: worst(VALUE_MAX_BYTES + 1), typed: REF });
    expect(big.code).toBe(1);
    expect(big.stderr).toContain("too_large");
    expect(existsSync(h.vault) ? sealed(h.vault) : []).toEqual([]);
    const max = await cli(h.env, ["put", REF, "--raw"], { stdin: worst(VALUE_MAX_BYTES), typed: REF });
    expect(max.code, max.stderr).toBe(0);
    expect(readSecretIndex(secretIndexPath(h.dir)).versions).toHaveLength(1);
    expect((await put(h.env, "synthetic-value-two", OTHER)).code).toBe(0);
  });
});


describe("review point 3: disable and revoke work while the index file is unreadable, and say so", () => {
  const unreadable = async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    expect((await put(h.env, "synthetic-value-two")).code).toBe(0);
    chmodSync(secretIndexPath(h.dir), 0o644);
    return h;
  };
  it("disable narrows at once; the sweep's index problem is a warning", async () => {
    const h = await unreadable();
    const r = await cli(h.env, ["disable", REF]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/warning: .*sweep.*mode/);
    expect((await cli(h.env, ["list"])).stdout).toContain("\"status\":\"disabled\"");
  });
  it("revoke narrows and destroys the value, then reports the index left to fix (exit 3)", async () => {
    const h = await unreadable();
    const r = await cli(h.env, ["revoke", REF], { typed: REF });
    expect(r.code, r.stderr).toBe(3);
    expect(r.stdout).toContain("revoked");
    expect(r.stderr).toMatch(/left to clean: .*index/);
    expect(sealed(h.vault)).toEqual([]);
    expect((await cli(h.env, ["list"])).stdout).toContain("\"status\":\"revoked\"");
  });
  it("a store with the index unreadable is refused as a file problem (exit 70) and stores nothing", async () => {
    const h = await unreadable();
    const r = await put(h.env, "synthetic-value-three", OTHER);
    expect(r.code).toBe(70);
    expect(sealed(h.vault)).toHaveLength(1);
  });
});

describe("review point 9: a save never clears a vault ref the change didn't name", () => {
  it("a change that leaves the vault rows out keeps every stored ref; one that names a row with none clears it", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    const secrets = new SqliteSecrets(join(h.dir, "connections.db"));
    try {
      const stored = secrets.load().vaults;
      expect(stored.map(v => v.ref?.slice(0, 2))).toEqual(["s-"]);
      secrets.write(state => ({ next: { ...state, vaults: [] }, result: null }));
      expect(secrets.load().vaults).toEqual(stored);
      secrets.write(state => ({ next: { ...state, vaults: stored.map(v => ({ ...v, ref: null })) }, result: null }));
      expect(secrets.load().vaults.map(v => v.ref)).toEqual([null]);
    } finally {
      secrets.close();
    }
  });
});
