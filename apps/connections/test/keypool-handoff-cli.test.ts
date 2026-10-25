// The pooled helper hand-off through the real bin (ADR-0037, slice 2): `run --pool` binds its child's helper to a grant, the helper moves
// the run to the next member once the first is reported dry, and the cap of the helper window survives the move. The runtime is the
// fixture fake-keyed-runtime.mjs, which asks the helper as often as the job says. Every key is synthetic.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every case here starts the bin several times (a run is a launcher, an agent and a helper per call): on a busy box that is over the 20 s default.
vi.setConfig({ testTimeout: 60_000 });
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
type Answer = { exit: number; bypass?: ({ filter: string } | { loosen: true } | { junk: number })[]; cmdsAfter?: { args: string[]; input?: string }[]; report?: string[]; rehelp?: number; killParent?: boolean; json?: Record<string, unknown>; say?: string; cmds?: { args: string[]; input?: string }[] };
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
    expect(helperOf(calls(dir)[0] as Call)).toMatch(/ helper --filter \S+ --pool p --grant g\S+$/);
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
  it("kp18 fix round 1: a refusal reported by the session that was served the new key is the new key's, even inside the window", async () => {
    const { env, dir } = await world(3);
    await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 0, report: ["p", "--outcome", "exhausted"] },
    }));
    expect(reportsOf(dir)).toEqual([{ code: 0, stderr: "" }, { code: 0, stderr: "" }]);
    expect(await states(env)).toEqual(["exhausted", "exhausted", "active"]);
  });
  it("kp18 fix round 1: the run wrapper blames the key its child was last served, so a new key that is already dry is marked and the run goes on", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 1, json: { type: "result", subtype: "success", is_error: true, api_error_status: 400, terminal_reason: "api_error", num_turns: 1, total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 }, result: "Credit balance is too low" } },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(await states(env)).toEqual(["exhausted", "exhausted", "active"]);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1], KEYS[2]]);
  });
});

// The grants a pool holds, read from the database the way a later command sees it.
const grantsOf = (dir: string): string[] => {
  const db = new Database(join(dir, "connections.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT body FROM key_pool WHERE name = ?").get("p") as { body: string };
    return (JSON.parse(row.body) as { grants: { id: string }[] }).grants.map(g => g.id);
  } finally { db.close(); }
};

describe("a grant outlives a run that was killed, until the next lease, run or check sweeps it", () => {
  it("leaves the grant and its lease behind, and check --pool ends both", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, killParent: true } }));
    expect(ran.code).not.toBe(0);
    expect(grantsOf(dir)).toHaveLength(1);
    const swept = await cli(["check", "--pool", "p"], env);
    expect(swept.code, swept.stderr).toBe(0);
    expect(grantsOf(dir)).toEqual([]);
    const lost = (await events(env, "k1")).filter(e => e.type === "LeaseLost");
    expect(lost).toHaveLength(1);
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

describe("kp12 fix round 1: the output filter knows every key the run may be moved to, not only the first", () => {
  it("a key the child prints after a hand-off is redacted from the run's output (the second member's, here)", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 0, say: `my key is ${KEYS[1]}` },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(`${ran.stdout}${ran.stderr}`).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
});

describe("kp12 fix round 2: the output filter learns the key of a member the run is handed to, whenever it joined or was rotated", () => {
  const NEW_KEY = "sk-ant-synthetic-pool-key-0009";
  const cmdsOf = (dir: string): { args: string[]; code: number; stderr: string }[] => {
    try { return readFileSync(join(dir, "work", "record.jsonl.cmds"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; code: number; stderr: string }); } catch { return []; }
  };
  const dry = (member: string) => ({ args: ["keypool", "report", "p", "--member", member, "--outcome", "exhausted"] });
  const quiet = (out: Out) => `${out.stdout}${out.stderr}`;
  it("a member that joined the pool after the run started: its key, printed after the hand-off, is redacted", async () => {
    const { env, dir } = await world(3, { pool: false });
    expect((await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1", "k2"], env)).code).toBe(0);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, cmds: [{ args: ["keypool", "add", "p", "k3", "--confirm-own-account"] }, dry("k1"), dry("k2")], rehelp: 1 },
      [KEYS[2]]: { exit: 0, say: `my key is ${KEYS[2]}` },
    }));
    expect(cmdsOf(dir).map(c => c.code)).toEqual([0, 0, 0]);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[2]]);
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(quiet(ran)).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
  it("a member whose key was rotated after the run started: the new key, printed after the hand-off, is redacted", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, cmds: [{ args: ["rotate", "k2"], input: NEW_KEY }, dry("k1")], rehelp: 1 },
      [NEW_KEY]: { exit: 0, say: `my key is ${NEW_KEY}` },
    }));
    expect(cmdsOf(dir).map(c => c.code)).toEqual([0, 0]);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], NEW_KEY]);
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of [...KEYS, NEW_KEY]) expect(quiet(ran)).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
});

describe("kp12 fix round 3: a key handed to the run is redacted even when its member is gone or its key rotated before the key is printed", () => {
  const dry = (member: string) => ({ args: ["keypool", "report", "p", "--member", member, "--outcome", "exhausted"] });
  const joinThenMove = (after: { args: string[]; input?: string }) => ({
    [KEYS[0]]: { exit: 0, cmds: [{ args: ["keypool", "add", "p", "k3", "--confirm-own-account"] }, dry("k1"), dry("k2")], rehelp: 1 },
    [KEYS[2]]: { exit: 0, cmdsAfter: [after], say: `my key is ${KEYS[2]}` },
  });
  const setup = async () => {
    const { env, dir } = await world(3, { pool: false });
    expect((await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1", "k2"], env)).code).toBe(0);
    return { env, dir };
  };
  it("the member was removed from the pool after the hand-off", async () => {
    const { env, dir } = await setup();
    const ran = await run(env, dir, job(dir, joinThenMove({ args: ["keypool", "remove", "p", "k3"] })));
    expect(ran.code, ran.stderr).toBe(0);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[2]]);
    for (const key of KEYS) expect(`${ran.stdout}${ran.stderr}`).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
  it("the member's key was rotated after the hand-off (the old file is gone before the key is printed)", async () => {
    const { env, dir } = await setup();
    const ran = await run(env, dir, job(dir, joinThenMove({ args: ["rotate", "k3"], input: "sk-ant-synthetic-pool-key-0008" })));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(`${ran.stdout}${ran.stderr}`).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
});

describe("kp12 fix round 5: the key reaches the output filter from the hand-out itself, not from a later read of the store", () => {
  // MORNDO_FILTER_WATCH=off switches the store watch (and its poll) off, so only the helper's hand-over to the run can have taught the filter the key.
  const dry = (member: string) => ({ args: ["keypool", "report", "p", "--member", member, "--outcome", "exhausted"] });
  const NEW_KEY = "sk-ant-synthetic-pool-key-0008";
  const quiet = (out: Out) => `${out.stdout}${out.stderr}`;
  const setup = async () => {
    const { env, dir } = await world(3, { pool: false });
    expect((await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1", "k2"], env)).code).toBe(0);
    return { env: { ...env, MORNDO_FILTER_WATCH: "off" }, dir };
  };
  const moved = (after: { args: string[]; input?: string }) => ({
    [KEYS[0]]: { exit: 0, cmds: [{ args: ["keypool", "add", "p", "k3", "--confirm-own-account"] }, dry("k1"), dry("k2")], rehelp: 1 },
    [KEYS[2]]: { exit: 0, cmdsAfter: [after], say: `my key is ${KEYS[2]}` },
  });
  it("a member that joined mid-run and was removed again", async () => {
    const { env, dir } = await setup();
    const ran = await run(env, dir, job(dir, moved({ args: ["keypool", "remove", "p", "k3"] })));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(quiet(ran)).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
  it("a member that joined mid-run and whose key was rotated at once (no read can find the old key any more)", async () => {
    const { env, dir } = await setup();
    const ran = await run(env, dir, job(dir, moved({ args: ["rotate", "k3"], input: NEW_KEY })));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of [...KEYS, NEW_KEY]) expect(quiet(ran)).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
  it("a member that joined mid-run and whose pool was deleted before the next read", async () => {
    const { env, dir } = await setup();
    const ran = await run(env, dir, job(dir, moved({ args: ["keypool", "delete", "p"] })));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(quiet(ran)).not.toContain(key);
    expect(ran.stdout).toContain("[redacted]");
  });
});

describe("kp12 fix round 5: a model id from the output is written into an engine mark only if it is one", () => {
  const marks = (dir: string): string => {
    try { return JSON.stringify((JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { marks?: unknown }).marks ?? []); } catch { return "[]"; }
  };
  it("a key printed as the model is not in the engine file", async () => {
    const { env, dir } = await world(2, { models: true });
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, say: `{"model":"${KEYS[0]}","type":"result"}` } }));
    expect(ran.code, ran.stderr).toBe(0);
    for (const key of KEYS) expect(marks(dir)).not.toContain(key);
    for (const file of homeFiles(dir)) {
      if (!file.endsWith("engines.json")) continue;
      for (const key of KEYS) expect(readFileSync(file, "utf8")).not.toContain(key);
    }
  });
  it("a model id the run was not asked for is still marked", async () => {
    const { env, dir } = await world(2, { models: true });
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, say: `{"model":"other-model-9","type":"result"}` } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(marks(dir)).toContain("other-model-9");
  });
});

describe("kp8 fix round 2: a member removed while the run is on it does not end the run's keys", () => {
  it("the next helper call hands the run to another member, and every lease the run took is closed at its end", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, cmds: [{ args: ["keypool", "remove", "p", "k1"] }], rehelp: 1 },
      [KEYS[1]]: { exit: 0 },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1]]);
    const all = await events(env);
    expect(all.filter(e => e.type === "LeaseGranted")).toHaveLength(2);
    expect(all.filter(e => e.type === "LeaseClosed" || e.type === "LeaseLost")).toHaveLength(2);
    expect(await states(env)).toEqual(["active", "active"]);
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
  it("fix round 1: a priority, picks or role change from the CLI keeps the members off and the pool on", async () => {
    const { env, dir } = await world(3, { models: true });
    const off = () => ["k1", "k2", "k3"].map(name => engines(dir).providers.find(p => p.name === name)?.enabled);
    expect(off()).toEqual([false, false, false]);
    expect((await cli(["priority", "set", "keys-first"], env)).code).toBe(0);
    expect(off()).toEqual([false, false, false]);
    const added = await cli(["picks", "implement", "add", "p:sonnet-5.5"], env);
    expect(added.code, added.stderr).toBe(0);
    expect(off()).toEqual([false, false, false]);
    expect((await cli(["role", "implement", "follow"], env)).code).toBe(0);
    expect(off()).toEqual([false, false, false]);
    expect(engines(dir).providers.find(p => p.name === "p")?.enabled).toBe(true);
  });
  it("keypool sync is the retry and changes nothing when nothing is out of step", async () => {
    const { env, dir } = await world(2, { models: true });
    const before = readFileSync(join(dir, "engines.json"), "utf8");
    expect((await cli(["keypool", "sync"], env)).code).toBe(0);
    expect(readFileSync(join(dir, "engines.json"), "utf8")).toBe(before);
  });
});

describe("fix round 6: a helper call under a grant hands its key to that grant's own run filter, or prints nothing", () => {
  const bypassOf = (dir: string): { filter: string; key: string; code: number; stderr: string }[] => {
    try { return readFileSync(join(dir, "work", "record.jsonl.bypass"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { filter: string; key: string; code: number; stderr: string }); } catch { return []; }
  };
  it("a tool that runs the helper line without --filter gets no key, only a word", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, bypass: [{ filter: "drop" }] } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0]]);
    const tried = bypassOf(dir);
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatchObject({ key: "", code: 1 });
    expect(tried[0]?.stderr.trim()).toBe("filter");
  });
  it("a tool that points --filter at a listener of its own gets no key, and the listener is sent nothing", async () => {
    const { env, dir } = await world(2);
    const own = join(dir, "own.sock");
    const received: string[] = [];
    const server = createServer(socket => { socket.on("data", chunk => { received.push(String(chunk)); socket.end("ok\n"); }); });
    await new Promise<void>(resolve => { server.listen(own, resolve); });
    chmodSync(own, 0o600);
    try {
      const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, bypass: [{ filter: own }] } }));
      expect(ran.code, ran.stderr).toBe(0);
      const tried = bypassOf(dir);
      expect(tried[0]).toMatchObject({ key: "", code: 1 });
      expect(tried[0]?.stderr.trim()).toBe("filter");
      expect(received).toEqual([]);
    } finally { await new Promise<void>(resolve => { server.close(() => { resolve(); }); }); }
  });
  it("the run's own socket with its mode loosened is not trusted: the helper prints nothing and says so, and the next call works again", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, bypass: [{ loosen: true }], rehelp: 1 } }));
    expect(ran.code, ran.stderr).toBe(0);
    const tried = bypassOf(dir);
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatchObject({ filter: "loosened", key: "", code: 1 });
    expect(tried[0]?.stderr.trim()).toBe("filter_untrusted");
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[0]]);
  });
  it("seventy keys nobody holds, sent to the run's own socket, are all refused, and the run's next real hand-off still gets its key", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, bypass: [{ junk: 70 }], report: ["p", "--outcome", "exhausted"], rehelp: 1 },
      [KEYS[1]]: { exit: 0 },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    const tried = bypassOf(dir) as { answers?: Record<string, number> }[];
    expect(tried[0]?.answers).toEqual({ no: 70 });
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1]]);
    expect(await states(env)).toEqual(["exhausted", "active", "active"]);
  });
  it("no key reaches the run's output or the helper's words through either bypass", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, bypass: [{ filter: "drop" }, { filter: join(dir, "nowhere.sock") }] } }));
    const said = JSON.stringify([ran.stdout, ran.stderr, bypassOf(dir)]);
    for (const key of KEYS) expect(said).not.toContain(key);
    expect(bypassOf(dir).map(item => item.code)).toEqual([1, 1]);
  });
});

describe("fix round 6: a launcher killed outright leaves a socket directory the next start sweeps", () => {
  const runtimeDir = (dir: string): string => {
    const root = join(dir, "rt");
    mkdirSync(root, { mode: 0o700 });
    return root;
  };
  const left = (root: string): string[] => readdirSync(root).filter(name => name.startsWith("mf-"));
  it("one directory is left by the kill and none after the next run", async () => {
    const { env, dir } = await world(2);
    const root = runtimeDir(dir);
    const scoped = { ...env, XDG_RUNTIME_DIR: root };
    const killed = await run(scoped, dir, job(dir, { [KEYS[0]]: { exit: 0, killParent: true } }));
    expect(killed.code).not.toBe(0);
    expect(left(root)).toHaveLength(1);
    const next = await run(scoped, dir, job(dir, { [KEYS[0]]: { exit: 0 }, [KEYS[1]]: { exit: 0 } }));
    expect(next.code, next.stderr).toBe(0);
    expect(left(root)).toEqual([]);
  });
});

describe("fix round 6: a temp directory too long for a socket path fails closed and says so", () => {
  it("no child is started, no key is shown, and the error names the cause", async () => {
    const { env, dir } = await world(2);
    const long = join(dir, "t".repeat(60), "u".repeat(60));
    mkdirSync(long, { recursive: true });
    const ran = await run({ ...env, XDG_RUNTIME_DIR: "", TMPDIR: long }, dir, job(dir, { [KEYS[0]]: { exit: 0 } }));
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toMatch(/socket path is too long/);
    expect(calls(dir)).toEqual([]);
    for (const key of KEYS) expect(`${ran.stdout}${ran.stderr}`).not.toContain(key);
  });
});
