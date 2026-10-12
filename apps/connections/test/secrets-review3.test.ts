// Review round 3 of PR #40 (board T-94): one block per point, each written failing before its fix. Real age vault,
// real database and the real commands where the point is about them. Values, References and names are synthetic.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretIndexPath } from "../src/compose.ts";
import { runSecrets, type SecretsIo } from "../src/secrets-cli.ts";

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
