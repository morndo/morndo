// Review round 2 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real commands where the point is about them. Values, References and names are synthetic.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretIndexPath } from "../src/compose.ts";
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
