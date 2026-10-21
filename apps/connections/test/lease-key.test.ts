// `morndo-keys lease --connection <name>` as an apiKeyHelper (T-340): one call is one lease — the gate runs, the key is
// printed once on stdout, a KeyServed audit line lands, the lease closes. The key never reaches argv, env, stderr or a
// file outside the vault. The `run` path that serves `helper --lease <id>` stays e2e.test.ts's
// "sends the key only as the helper header and keeps it out of env".
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { selfHolder } from "../src/adapters/processes.ts";
import { openHome } from "../src/compose.ts";
import { afterEach, describe, expect, it } from "vitest";

const KEY = "sk-ant-synthetic-test-key-0001";
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-lease-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  return dir;
}

// No key variable in this env: a lane that samples the child's environ must find the key nowhere it was put.
function envOf(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath,
    PWD: join(dir, "work"), ...extra,
  };
}

function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-strip-types", main, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function zaiReady(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const added = await cli(["add", "zai", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEY);
  expect(added.code, added.stderr).toBe(0);
  expect((await cli(["ack", "zai", "--by", "owner"], env)).code).toBe(0);
}

async function events(env: NodeJS.ProcessEnv, name?: string): Promise<Record<string, unknown>[]> {
  const log = await cli(name ? ["log", name] : ["log"], env);
  return log.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function storedLeases(dir: string): unknown[] {
  const db = new Database(join(dir, "connections.db"), { readonly: true, fileMustExist: true });
  const stored = db.prepare("SELECT body FROM directory WHERE id = 1").get() as { body: string };
  db.close();
  return (JSON.parse(stored.body) as { connections: { leases: unknown[] }[] }).connections.flatMap(c => c.leases);
}

describe("keys lease", () => {
  it("lease prints the key and only the key, takes one lease and closes it", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    const ran = await cli(["lease", "--connection", "zai", "--isolation", "os"], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(`${KEY}\n`);
    expect(ran.stderr).toBe("");
    const rows = await events(env, "zai");
    const granted = rows.find(e => e.type === "LeaseGranted");
    const served = rows.filter(e => e.type === "KeyServed");
    const closed = rows.filter(e => e.type === "LeaseClosed");
    expect(served).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(served[0]?.lease).toBe(granted?.lease);
    expect(closed[0]?.lease).toBe(granted?.lease);
    expect(storedLeases(dir)).toEqual([]);
  }, 20_000);

  it("a planted key never appears in argv, env, the audit log, the registry or stderr", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    // Claude Code runs an apiKeyHelper through the system shell; the sample of /proc catches a key put in argv or env.
    const samples: Buffer[] = [];
    const ran = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const child = spawn("sh", ["-c", `${process.execPath} --experimental-strip-types ${main} lease --connection zai --isolation os`], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const read = (pid: number) => {
        for (const file of ["cmdline", "environ"]) {
          try { samples.push(readFileSync(`/proc/${pid}/${file}`)); } catch { /* gone */ }
        }
      };
      const timer = setInterval(() => {
        read(child.pid ?? -1);
        try {  // sh -c execs one command, but a forked child is sampled too
          const kids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
          for (const kid of kids) read(Number(kid));
        } catch { /* none */ }
      }, 4);
      child.on("close", code => { clearInterval(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(`${KEY}\n`);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) expect(sample.includes(Buffer.from(KEY)), "a /proc sample holds the key").toBe(false);
    expect(ran.stderr).not.toContain(KEY);
    expect((await cli(["log", "zai"], env)).stdout).not.toContain(KEY);
    const needle = Buffer.from(KEY);
    const vault = join(dir, "vault");
    const planted: string[] = [];
    const scan = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) { if (path !== vault) scan(path); continue; }
        if (readFileSync(path).includes(needle)) planted.push(path);
      }
    };
    scan(dir);
    expect(planted, "files outside the vault hold the key").toEqual([]);
    const held = readdirSync(vault).find(name => name.startsWith("key-"));
    expect(held && readFileSync(join(vault, held)).includes(needle), "the vault no longer holds the key: the scan proved nothing").toBe(true);
  }, 20_000);

  it("refusals print nothing on stdout and the reason word on stderr", async () => {
    // One home per row: a row that ends the connection (revoke) must not speak for the next.
    const cases: { what: string; connection: string; args?: string[]; prepare?: (env: NodeJS.ProcessEnv) => Promise<void>; exit: number; word: string }[] = [
      { what: "missing", connection: "nope", exit: 1, word: "missing" },
      { what: "revoked", connection: "zai", prepare: async env => { expect((await cli(["revoke", "zai"], env)).code).toBe(0); }, exit: 1, word: "revoked" },
      { what: "off", connection: "zai", prepare: async env => { expect((await cli(["off", "zai"], env)).code).toBe(0); }, exit: 75, word: "off" },
      { what: "expired", connection: "zai", prepare: async env => { expect((await cli(["expiry", "zai", "1"], env)).code).toBe(0); }, exit: 75, word: "expired" },
      { what: "isolation: nothing vouched, zai's floor is os", connection: "zai", args: [], exit: 75, word: "isolation" },
      { what: "isolation: rules vouched", connection: "zai", args: ["--isolation", "rules"], exit: 75, word: "isolation" },
      {
        what: "not_leasable", connection: "credit", exit: 1, word: "not_leasable",
        // Its own key text: a second copy of zai's key would be refused for its fingerprint, not its runtime.
        prepare: async env => { expect((await cli(["add", "credit", "--vendor", "deepseek", "--runtime", "codex", "--billing", "metered", "--budget", "10"], env, "sk-deepseek-synthetic-test-key-0002")).code).toBe(0); },
      },
      {
        what: "subscription", connection: "sub", exit: 1, word: "not_leasable",
        prepare: async env => { expect((await cli(["add", "sub", "--vendor", "claude", "--runtime", "claude", "--subscription", "true"], env)).code).toBe(0); },
      },
    ];
    for (const row of cases) {
      const dir = homeDir();
      const env = envOf(dir);
      await zaiReady(dir, env);
      await row.prepare?.(env);
      const ran = await cli(["lease", "--connection", row.connection, ...(row.args ?? ["--isolation", "os"])], env);
      expect(ran.stdout, row.what).toBe("");
      expect(ran.stderr, row.what).toContain(row.word);
      expect(ran.stderr, row.what).not.toContain(KEY);
      expect(ran.code, row.what).toBe(row.exit);
      expect((await events(env)).some(e => e.type === "KeyServed"), row.what).toBe(false);
    }
  }, 20_000);

  it("a vault that fails says only failed, never its message", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    const secret = readdirSync(join(dir, "vault")).find(name => name.startsWith("key-"));
    expect(secret).toBeTruthy();
    rmSync(join(dir, "vault", secret ?? ""));
    const ran = await cli(["lease", "--connection", "zai", "--isolation", "os"], env);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("failed\n");
  }, 20_000);

  it("one KeyServed per call, with the caller and the lane", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    for (let i = 0; i < 2; i++) {
      const ran = await cli(["lease", "--connection", "zai", "--lane", "builder", "--isolation", "os"], env);
      expect(ran.code, ran.stderr).toBe(0);
    }
    const rows = await events(env, "zai");
    const served = rows.filter(e => e.type === "KeyServed");
    expect(served).toHaveLength(2);
    expect(new Set(served.map(e => e.lease)).size).toBe(2);
    for (const event of served) {
      const caller = event.caller as { pid: number; lane: string | null; isolation: string };
      expect(caller.lane).toBe("builder");
      expect(caller.isolation).toBe("os");                       // what the caller vouched for is in the record
      expect(typeof caller.pid).toBe("number");
    }
    expect(rows.some(e => JSON.stringify(e).includes(KEY))).toBe(false);
    expect(storedLeases(dir)).toEqual([]);
  }, 20_000);

  it("helper --lease serves a lease's key as an apiKeyHelper reads it: the key and a newline, nothing else", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    // A lease held by this process (as `run` holds its own); the helper is its child, so the ancestry check admits it.
    const home = openHome(env);
    let id = "";
    try {
      home.runtime.current = { isolation: () => "os" as const, dialects: () => ["anthropic"], loginStatus: () => Promise.resolve("unknown" as const), launch: () => Promise.resolve({ id: "" }) };
      const holder = selfHolder(null);
      if (!holder) throw new Error("no holder");
      const granted = home.leases.lease("zai", { role: "run", entry: "default", holder, workspacePath: join(dir, "work"), limit: 8, reserve: 1, margin: 0, probe: false });
      if (!granted.ok) throw new Error(granted.error.problem);
      id = granted.value.id;
    } finally { home.close(); }
    const served = await cli(["helper", "--lease", id], env);
    expect(served.code).toBe(0);
    expect(served.stdout.split("\n")).toEqual([KEY, ""]);
    expect(served.stderr).toBe("");
    // Closed, the lease serves nothing: no key on stdout and a failing exit, which Claude Code reports as a failed helper.
    const again = openHome(env);
    try { expect(again.leases.close("zai", id, "done", null).ok).toBe(true); } finally { again.close(); }
    const closed = await cli(["helper", "--lease", id], env);
    expect(closed.code).toBe(1);
    expect(closed.stdout).toBe("");
  }, 20_000);

  it("lease as a helper: a refused call prints nothing on stdout", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    const refused = await cli(["lease", "--connection", "nope"], env);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
  }, 20_000);
});
