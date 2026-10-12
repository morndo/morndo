// Review round 2 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real commands where the point is about them. Values, References and names are synthetic.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Decrypter, Encrypter } from "age-encryption";
import type { Actor, SecretGrant } from "@morndo/domain";
import { FileRefused } from "../src/adapters/file-mode.ts";
import { SecretIndexWriter } from "../src/adapters/secret-index-writer.ts";
import { CountingIds, ManualClock, MemoryIndex, MemoryRoots, MemorySecrets } from "../src/application/fakes.ts";
import { SecretsService, type StoreRequest } from "../src/application/secrets-service.ts";
import { MemorySealedStore } from "./sealed-store-fake.ts";
import { NodeKeys } from "../src/adapters/node-keys.ts";
import { AgeVault } from "../src/adapters/vault-age.ts";
import { FileVault } from "../src/adapters/vault-file.ts";
import { openHome, secretIndexPath } from "../src/compose.ts";
import { IndexFileRefused, readSecretIndex } from "@morndo/node-ops";
import { runSecrets, stdinValue, type SecretsIo } from "../src/secrets-cli.ts";

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

describe("round 2, point 11: a failure in a store's cleanup never hides the store's own error", () => {
  const T = 1_700_000_000_000;
  const principal: Actor = { kind: "principal", command: "c1" };
  const nodeGrant: SecretGrant = { subject: { kind: "node" }, modes: ["exec"], until: { kind: "open" } };
  function world() {
    const clock = new ManualClock(T);
    const vault = new MemorySealedStore("fake1-node", undefined, () => clock.at);
    const index = new MemoryIndex();
    const service = new SecretsService({ clock, ids: new CountingIds(), vault, index, secrets: new MemorySecrets(), roots: new MemoryRoots() });
    const request = (value: string): StoreRequest => ({
      reference: REF, sealed: MemorySealedStore.seal(["fake1-node"], new TextEncoder().encode(value)), shape: null, grants: [nodeGrant],
      expiry: null, destinations: [], renew: false,
    });
    return { vault, index, service, request };
  }
  it("the index write fails, then removing the new file fails: the error names both, and the index's stays its cause", async () => {
    const w = world();
    const original = new IndexFileRefused("mode", "/synthetic/secret-index.json");
    w.index.write = () => { throw original; };
    w.vault.remove = () => { throw new FileRefused("mode", "/synthetic/vault"); };
    const error = await w.service.store(w.request("synthetic-value-one"), principal).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/secret-index\.json: mode/);
    expect((error as Error).message).toMatch(/\/synthetic\/vault is looser/);
    expect((error as Error).cause).toBe(original);
  });
  it("a refused store whose new file can't be removed returns the refusal, and names the file left", async () => {
    const w = world();
    expect((await w.service.store(w.request("synthetic-value-one"), principal)).ok).toBe(true);
    w.vault.remove = () => { throw new FileRefused("mode", "/synthetic/vault"); };
    const again = await w.service.store(w.request("synthetic-value-one"), principal);
    expect(again).toEqual({ ok: false, error: { problem: "earlier", left: [expect.stringMatching(/vault: .*s-0002.*looser/)] } });
  });
  it("the command prints the store's own error, then the file left, and exits by the store's error (70: the index)", async () => {
    const h = home();
    const write = vi.spyOn(SecretIndexWriter.prototype, "write").mockImplementation(() => { throw new IndexFileRefused("mode", secretIndexPath(h.dir)); });
    const remove = vi.spyOn(AgeVault.prototype, "remove").mockImplementation(() => { throw new FileRefused("mode", h.vault); });
    try {
      const r = await put(h.env, "synthetic-value-one");
      expect(r.code).toBe(70);
      expect(r.stderr).toMatch(/secret-index\.json: mode/);
      expect(r.stderr).toMatch(/left to clean: vault: .*s-[0-9a-f]{16}.*looser/);
    } finally {
      write.mockRestore();
      remove.mockRestore();
    }
  });
  it("a refused put whose new file can't be removed prints the refusal and the file left (exit 1)", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    const remove = vi.spyOn(AgeVault.prototype, "remove").mockImplementation(() => { throw new FileRefused("mode", h.vault); });
    try {
      const r = await put(h.env, "synthetic-value-one");
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/refused: earlier/);
      expect(r.stderr).toMatch(/left to clean: vault: .*s-[0-9a-f]{16}.*looser/);
    } finally {
      remove.mockRestore();
    }
  });
});

describe("round 2, point 8: a node key missing or malformed is a file problem: exit 70, not a refusal", () => {
  for (const name of ["fingerprint.key", "index.key"]) {
    it(`${name} gone while hashes made with it are on record: put exits 70 and names the file`, async () => {
      const h = home();
      expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
      rmSync(join(h.dir, name));
      const r = await put(h.env, "synthetic-value-two", OTHER);
      expect(r.code).toBe(70);
      expect(r.stderr).toMatch(new RegExp(`${name.replace(".", "\\.")} is missing`));
    });
  }
  it("a fingerprint key of the wrong length: put exits 70", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    writeFileSync(join(h.dir, "fingerprint.key"), new Uint8Array(16), { mode: 0o600 });
    const r = await put(h.env, "synthetic-value-two", OTHER);
    expect(r.code).toBe(70);
    expect(r.stderr).toMatch(/fingerprint\.key is not a 32-byte key/);
  });
});

describe("round 2, points 3, 4 and 7: no copy of the value this code makes outlives its zeroing", () => {
  const find = (haystack: Uint8Array, needle: Uint8Array) => {
    for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((b, j) => haystack[i + j] === b)) return i;
    return -1;
  };
  it("point 3: stdin's bytes leave no copy in Node's shared buffer pool once the value is zeroed", async () => {
    const value = new TextEncoder().encode(`synthetic-${randomBytes(12).toString("hex")}`);
    const handed: Buffer[] = [];
    async function* chunks() {
      for (const part of [value.subarray(0, 10), value.subarray(10)]) {
        const chunk = Buffer.alloc(part.length);
        chunk.set(part);
        handed.push(chunk);
        yield chunk;
      }
    }
    const bytes = await stdinValue(chunks());
    expect(bytes).toEqual(value);
    bytes.fill(0);
    expect(handed.every(c => c.every(b => b === 0))).toBe(true);
    // The pool small Buffers are cut from (Buffer.allocUnsafe and Buffer.concat take from it under 4 KiB).
    expect(find(new Uint8Array(Buffer.allocUnsafe(1).buffer), value)).toBe(-1);
  });
  it("point 4: AgeVault.open zeroes what the library decrypted, so the index writer and keyedFingerprint leave none behind", async () => {
    const h = home();
    const vault = new AgeVault(h.vault, join(h.dir, "identity"));
    const e = new Encrypter();
    e.addRecipient(await vault.recipient());
    expect((await vault.storeSealed("s-00000000000000a4", await e.encrypt(new TextEncoder().encode("synthetic-value-four")))).ok).toBe(true);
    const outputs: Uint8Array[] = [];
    const real = Decrypter.prototype.decrypt;
    const spy = vi.spyOn(Decrypter.prototype, "decrypt").mockImplementation(async function (this: Decrypter, ...args: unknown[]) {
      const out: unknown = await (real as (...a: unknown[]) => Promise<unknown>).apply(this, args);
      if (out instanceof Uint8Array) outputs.push(out);
      return out as never;
    });
    try {
      const keys = new NodeKeys(h.dir);
      await new SecretIndexWriter(secretIndexPath(h.dir), b => keys.index(b), vault).prepare("s-00000000000000a4");
      expect(await vault.keyedFingerprint("s-00000000000000a4")).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      spy.mockRestore();
    }
    expect(outputs).toHaveLength(2);
    for (const out of outputs) expect(out.every(b => b === 0)).toBe(true);
  });
  it("point 7: a put that fails before it runs (a usage error) zeroes the stdin buffer", async () => {
    const h = home();
    const stdin = new TextEncoder().encode("synthetic-value-to-zero\n");
    expect(await runSecrets(["put", REF, "--yes"], h.env, { stdout: () => {}, stderr: () => {}, stdin, confirm: async () => REF })).toBe(64);
    expect(stdin.every(b => b === 0)).toBe(true);
  });
  it("point 7: a put whose home won't open (a loose directory) zeroes the stdin buffer", async () => {
    const h = home();
    mkdirSync(h.dir);
    chmodSync(h.dir, 0o755);
    const stdin = new TextEncoder().encode("synthetic-value-to-zero\n");
    expect(await runSecrets(["put", REF], h.env, { stdout: () => {}, stderr: () => {}, stdin, confirm: async () => REF })).toBe(70);
    expect(stdin.every(b => b === 0)).toBe(true);
  });
});

describe("round 2, point 12: a sweep that changes nothing in the index doesn't rewrite it", () => {
  it("after a rotation, list and log leave the index file as it is; the next store still writes it", async () => {
    const h = home();
    expect((await put(h.env, "synthetic-value-one")).code).toBe(0);
    expect((await put(h.env, "synthetic-value-two")).code).toBe(0);
    const before = statSync(secretIndexPath(h.dir), { bigint: true });
    for (const args of [["list"], ["log"]]) expect((await cli(h.env, args)).code).toBe(0);
    const after = statSync(secretIndexPath(h.dir), { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
    expect((await put(h.env, "synthetic-value-three", OTHER)).code).toBe(0);
    // A rename can reuse the freed inode number, so the time tells the write apart.
    expect(statSync(secretIndexPath(h.dir), { bigint: true }).mtimeNs).not.toBe(before.mtimeNs);
  });
});
