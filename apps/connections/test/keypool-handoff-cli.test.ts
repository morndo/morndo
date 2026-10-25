// The pooled helper hand-off through the real bin (ADR-0037, slice 2): `run --pool` binds its child's helper to a grant, the helper moves
// the run to the next member once the first is reported dry, and the cap of the helper window survives the move. The runtime is the
// fixture fake-keyed-runtime.mjs, which asks the helper as often as the job says. Every key is synthetic.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const KEYS: [string, string, string] = ["sk-ant-synthetic-pool-key-0001", "sk-ant-synthetic-pool-key-0002", "sk-ant-synthetic-pool-key-0003"];
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/fake-keyed-runtime.mjs");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Out = { code: number; stdout: string; stderr: string };
const homeDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "morndo-handoff-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "home"));
  return dir;
};
const envOf = (dir: string): NodeJS.ProcessEnv => ({
  ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath, MORNDO_CLAUDE_BIN: fixture,
  PWD: join(dir, "work"),
});
function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<Out> {
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

async function world(n = 3, opts: { pool?: boolean; models?: boolean } = {}): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = homeDir();
  const env = envOf(dir);
  for (let i = 1; i <= n; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  // The engine layer registers a provider only for a vendor whose models are listed; the list is fetched from the network, so it is written here.
  if (opts.models) {
    mkdirSync(join(dir, "models"));
    writeFileSync(join(dir, "models", "anthropic.json"), JSON.stringify({ ids: ["sonnet-5.5"] }));
  }
  if (opts.pool !== false) {
    const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", ...Array.from({ length: n }, (_, i) => `k${i + 1}`)], env);
    expect(made.code, made.stderr).toBe(0);
  }
  return { dir, env };
}
type Member = { credential: string; state: string; reason: string | null };
const pools = async (env: NodeJS.ProcessEnv) => (await cli(["keypool", "list"], env)).stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { name: string; standing: string; lastPick: string | null; members: Member[] });
const states = async (env: NodeJS.ProcessEnv) => (await pools(env))[0]?.members.map(m => m.state);
type Answer = { exit: number; report?: string[]; rehelp?: number };
const job = (dir: string, keys: Record<string, Answer>): string => {
  const path = join(dir, "work", `job-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ record: join(dir, "work", "record.jsonl"), keys }));
  return path;
};
type Call = { key: string; code: number; stderr: string; argv: string[]; again: boolean };
const calls = (dir: string): Call[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Call); } catch { return []; }
};
const reportsOf = (dir: string): { code: number; stderr: string }[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl.report"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { code: number; stderr: string }); } catch { return []; }
};
const run = (env: NodeJS.ProcessEnv, dir: string, jobPath: string, extra: string[] = []) =>
  cli(["run", "--pool", "p", "--workspace", join(dir, "work"), "--reserve", "1", ...extra, "--", "-p", "--job", jobPath], env);
type Event = { type: string; name?: string; lease?: string; outcome?: string };
const events = async (env: NodeJS.ProcessEnv, name?: string): Promise<Event[]> =>
  (await cli(["log", ...(name ? [name] : [])], env)).stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event);
const helperOf = (call: Call): string => {
  const at = call.argv.indexOf("--settings");
  return String((JSON.parse(call.argv[at + 1] ?? "{}") as { apiKeyHelper?: string }).apiKeyHelper);
};
function homeFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (path === join(dir, "vault") || path === join(dir, "work")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(dir);
  return found;
}

describe("run --pool binds its child's helper to a grant", () => {
  it("the helper line names the pool and a grant, not a lease", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0 } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(helperOf(calls(dir)[0] as Call)).toMatch(/ helper --pool p --grant g\S+$/);
  });
  it("characterisation: run --connection keeps helper --lease", async () => {
    const { env, dir } = await world(2, { pool: false });
    const ran = await cli(["run", "--connection", "k1", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", job(dir, { [KEYS[0]]: { exit: 0 } })], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(helperOf(calls(dir)[0] as Call)).toMatch(/ helper --lease l\d+$/);
  });
});

describe("the hand-off: a session whose key is reported dry gets the next key from the helper", () => {
  it("the next helper call prints the next member's key; the first member is exhausted, the run ends on the second", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 0 },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1]]);
    expect(reportsOf(dir)).toEqual([{ code: 0, stderr: "" }]);
    expect(await states(env)).toEqual(["exhausted", "active", "active"]);
  });
  it("closes the first lease as a hand-off, writes one KeyServed per printed key, and closes the second lease at the run's end", async () => {
    const { env, dir } = await world(3);
    await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 }, [KEYS[1]]: { exit: 0 } }));
    const k1 = await events(env, "k1");
    const k2 = await events(env, "k2");
    expect(k1.filter(e => e.type === "KeyServed")).toHaveLength(1);
    expect(k2.filter(e => e.type === "KeyServed")).toHaveLength(1);
    expect(k1.find(e => e.type === "LeaseClosed")?.outcome).toBe("handoff");
    expect(k2.find(e => e.type === "LeaseClosed")?.outcome).toBe("done");
    expect((await events(env)).filter(e => e.type === "LeaseGranted")).toHaveLength(2);
  });
  it("a pooled helper cannot reset the call cap by handing off: the fifth call in the window gets nothing and says authority", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 4 }, [KEYS[1]]: { exit: 0 } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1], KEYS[1], KEYS[1], ""]);
    expect(calls(dir)[4]?.code).toBe(1);
    expect(calls(dir)[4]?.stderr).toMatch(/authority/);
    expect((await events(env)).filter(e => e.type === "LeaseGranted")).toHaveLength(2);
  });
  it("a failing member stops the pool: the next helper call prints nothing and says pool_blocked", async () => {
    const { env, dir } = await world(3);
    await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "failing", "--reason", "rejected"], rehelp: 1 } }));
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], ""]);
    expect(calls(dir)[1]?.code).toBe(1);
    expect(calls(dir)[1]?.stderr).toMatch(/pool_blocked/);
    expect((await pools(env))[0]?.standing).toBe("blocked");
  });
  it("kp18: a refusal reported right after the hand-off is the first key's, and the second member stays active", async () => {
    const { env, dir } = await world(3);
    await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 0, report: ["p", "--outcome", "exhausted"] },
    }));
    expect(reportsOf(dir)).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
    expect(await states(env)).toEqual(["exhausted", "active", "active"]);
  });
});

describe("kp12 the keys reach nothing but the helper's stdout", () => {
  it("after a hand-off no key is in the run's output, the helper's words, the database, the alert log or the engine file", async () => {
    const { env, dir } = await world(3, { models: true });
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 }, [KEYS[1]]: { exit: 0 } }));
    const said = JSON.stringify([ran.stdout, ran.stderr, calls(dir).map(c => c.stderr), reportsOf(dir), await events(env), await pools(env)]);
    for (const key of KEYS) expect(said).not.toContain(key);
    for (const file of homeFiles(dir)) {
      const bytes = readFileSync(file).toString("latin1");
      for (const key of KEYS) expect(bytes.includes(key), `${key} in ${file}`).toBe(false);
    }
  });
});

describe("helper --pool and keypool report --grant: refusals", () => {
  it("a helper call with no such grant prints nothing, exits 1 and says grant_missing", async () => {
    const { env } = await world(2);
    const out = await cli(["helper", "--pool", "p", "--grant", "gnope"], env);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/grant_missing/);
  });
  it("a report by grant names no member and no lease, and the grant must exist", async () => {
    const { env } = await world(2);
    const gone = await cli(["keypool", "report", "p", "--outcome", "exhausted", "--grant", "gnope"], env);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toMatch(/grant_missing/);
    const both = await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted", "--grant", "gnope"], env);
    expect(both.stderr).toMatch(/usage/);
    const lease = await cli(["keypool", "report", "p", "--outcome", "exhausted", "--grant", "gnope", "--lease", "l1"], env);
    expect(lease.stderr).toMatch(/usage/);
    expect(await states(env)).toEqual(["active", "active"]);
  });
});

describe("check --pool: could some member serve now", () => {
  it("exits 0 for a pool that can, moves no ring position, and exits 75 with pool_empty when every member is dry", async () => {
    const { env } = await world(2);
    expect((await cli(["lease", "--pool", "p", "--isolation", "rules"], env)).code).toBe(0);
    expect((await pools(env))[0]?.lastPick).toBe("k1");
    const ok = await cli(["check", "--pool", "p"], env);
    expect(ok.code, ok.stderr).toBe(0);
    expect((await pools(env))[0]?.lastPick).toBe("k1");
    await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted"], env);
    await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "exhausted"], env);
    const dry = await cli(["check", "--pool", "p"], env);
    expect(dry.code).toBe(75);
    expect(dry.stderr).toMatch(/pool_empty/);
    expect((await cli(["check", "--pool", "nope"], env)).code).toBe(1);
  });
});

describe("the pool in the Priority and the engine layer", () => {
  const engines = (dir: string) => JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { providers: { name: string; enabled: boolean; bin?: string[]; probe?: string[] }[] };
  const order = async (env: NodeJS.ProcessEnv) => (JSON.parse((await cli(["page"], env)).stdout) as { order: string[] }).order;
  it("create registers the pool as a provider that runs and checks through the pool, turns its members off and takes their place in the order", async () => {
    const { env, dir } = await world(3, { models: true });
    const pool = engines(dir).providers.find(p => p.name === "p");
    expect(pool).toMatchObject({ enabled: true, bin: ["morndo-keys", "run", "--pool", "p", "--"], probe: ["morndo-keys", "check", "--pool", "p"] });
    for (const name of ["k1", "k2", "k3"]) expect(engines(dir).providers.find(p => p.name === name)?.enabled).toBe(false);
    expect(await order(env)).toEqual(["p"]);
  });
  it("remove gives the member back, delete gives them all back and takes the pool's provider out", async () => {
    const { env, dir } = await world(3, { models: true });
    expect((await cli(["keypool", "remove", "p", "k2"], env)).code).toBe(0);
    expect(engines(dir).providers.find(p => p.name === "k2")?.enabled).toBe(true);
    expect(await order(env)).toEqual(["p", "k2"]);
    expect((await cli(["keypool", "delete", "p"], env)).code).toBe(0);
    expect(engines(dir).providers.find(p => p.name === "p")).toBeUndefined();
    for (const name of ["k1", "k2", "k3"]) expect(engines(dir).providers.find(p => p.name === name)?.enabled).toBe(true);
    expect(await order(env)).toEqual(["k1", "k3", "k2"]);
  });
  it("keypool sync is the retry and changes nothing when nothing is out of step", async () => {
    const { env, dir } = await world(2, { models: true });
    const before = readFileSync(join(dir, "engines.json"), "utf8");
    expect((await cli(["keypool", "sync"], env)).code).toBe(0);
    expect(readFileSync(join(dir, "engines.json"), "utf8")).toBe(before);
  });
});
