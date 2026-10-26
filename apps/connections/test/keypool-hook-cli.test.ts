// The StopFailure hook through the real bin (ADR-0037, slice 4): a pooled run's settings carry a hook that reports a refusal of the key the run is on,
// `keypool report <pool> --from-hook` reads the payload on stdin, classifies it, applies a mark and prints words only. The runtime is the fixture
// fake-keyed-runtime.mjs, which runs the hook command from the settings with a saved payload (the real CLI's own, test/fixtures/stopfailure) as
// the agent CLI does. The run's own result is a success in these cases, so only the hook can have marked a member. Every key is synthetic.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
const KEYS: [string, string, string] = ["sk-ant-synthetic-hook-key-0001", "sk-ant-synthetic-hook-key-0002", "sk-ant-synthetic-hook-key-0003"];
const PLANTED = "planted-secret-in-the-hook-payload";
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/fake-keyed-runtime.mjs");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Out = { code: number; stdout: string; stderr: string };
const saved = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/stopfailure", `${name}.json`), "utf8")) as Record<string, unknown>;
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
    child.stdin.on("error", () => { /* the command may exit before it has read all of a large stdin */ });
    child.stdin.end(stdin);
  });
}
async function world(n = 3, pool = true): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-hook-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "home"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath, MORNDO_CLAUDE_BIN: fixture,
    PWD: join(dir, "work"),
  };
  for (let i = 1; i <= n; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  if (pool) {
    const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", ...Array.from({ length: n }, (_, i) => `k${i + 1}`)], env);
    expect(made.code, made.stderr).toBe(0);
  }
  return { dir, env };
}
type Member = { credential: string; state: string };
const states = async (env: NodeJS.ProcessEnv): Promise<string[]> =>
  ((JSON.parse((await cli(["keypool", "list"], env)).stdout.trim().split("\n")[0] ?? "{}") as { members: Member[] }).members).map(m => m.state);
type Answer = { exit: number; hook?: Record<string, unknown> | string; rehelp?: number };
const job = (dir: string, keys: Record<string, Answer>): string => {
  const path = join(dir, "work", `job-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ record: join(dir, "work", "record.jsonl"), keys }));
  return path;
};
type Call = { key: string; code: number; stderr: string; argv: string[] };
const calls = (dir: string): Call[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Call); } catch { return []; }
};
type HookRun = { code: number; stdout: string; stderr: string };
const hookRuns = (dir: string): HookRun[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl.hook"), "utf8").trim().split("\n").map(line => JSON.parse(line) as HookRun); } catch { return []; }
};
const run = (env: NodeJS.ProcessEnv, dir: string, jobPath: string) =>
  cli(["run", "--pool", "p", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", jobPath], env);
const settingsOf = (call: Call): Record<string, unknown> => {
  const at = call.argv.indexOf("--settings");
  return JSON.parse(call.argv[at + 1] ?? "{}") as Record<string, unknown>;
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

describe("the launcher's settings", () => {
  it("a pooled run carries a StopFailure command hook that names the pool and the grant, and no other new key", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0 } }));
    expect(ran.code, ran.stderr).toBe(0);
    const settings = settingsOf(calls(dir)[0] as Call);
    expect(Object.keys(settings).sort()).toEqual(["apiKeyHelper", "hooks", "permissions", "sandbox"]);
    const hooks = settings.hooks as { StopFailure: { hooks: { type: string; command: string; timeout: number }[] }[] };
    expect(Object.keys(hooks)).toEqual(["StopFailure"]);
    expect(hooks.StopFailure).toHaveLength(1);
    expect(hooks.StopFailure[0]?.hooks).toHaveLength(1);
    const entry = hooks.StopFailure[0]?.hooks[0];
    expect(entry?.type).toBe("command");
    expect(entry?.command).toMatch(/ keypool report p --from-hook --grant g\S+$/);
    expect(entry?.timeout).toBeGreaterThan(0);
    expect(entry?.timeout).toBeLessThanOrEqual(30);
  });
  it("the hook command line holds no key", async () => {
    const { env, dir } = await world(2);
    await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0 } }));
    const line = JSON.stringify(settingsOf(calls(dir)[0] as Call).hooks);
    for (const key of KEYS) expect(line).not.toContain(key);
  });
  it("characterisation: a single-connection run carries no hook", async () => {
    const { env, dir } = await world(2, false);
    const ran = await cli(["run", "--connection", "k1", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", job(dir, { [KEYS[0]]: { exit: 0 } })], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(Object.keys(settingsOf(calls(dir)[0] as Call)).sort()).toEqual(["apiKeyHelper", "permissions", "sandbox"]);
  });
});

describe("the hook marks the member the run is on", () => {
  it("a credit refusal reported by the hook, while the run's own result is a success, exhausts the first member and the next helper call hands the run to the second", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {
      [KEYS[0]]: { exit: 0, hook: saved("credit-refusal-400"), rehelp: 1 },
      [KEYS[1]]: { exit: 0 },
    }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(hookRuns(dir)).toEqual([{ code: 0, stdout: `${JSON.stringify({ pool: "p", outcome: "exhausted" })}\n`, stderr: "" }]);
    expect(calls(dir).map(c => c.key)).toEqual([KEYS[0], KEYS[1]]);
    expect(await states(env)).toEqual(["exhausted", "active", "active"]);
  });
  it("a spend-limit refusal exhausts it too, a 401 marks it failing and blocks the pool, and a rate limit or an overload changes nothing", async () => {
    for (const [name, outcome, after] of [
      ["spend-limit-400", "exhausted", ["exhausted", "active"]],
      ["invalid-key-401", "failing", ["failing", "active"]],
      ["rate-limit-429", "limited", ["active", "active"]],
      ["overloaded-529", "ignored", ["active", "active"]],
    ] as const) {
      const { env, dir } = await world(2);
      const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, hook: saved(name) } }));
      expect(ran.code, `${name}: ${ran.stderr}`).toBe(0);
      expect(hookRuns(dir).map(h => [h.code, JSON.parse(h.stdout) as unknown]), name).toEqual([[0, { pool: "p", outcome }]]);
      expect(await states(env), name).toEqual(after);
    }
  });
});

describe("keypool report --from-hook, by hand", () => {
  it("--member marks that member: the form for a hand-written settings file", async () => {
    const { env } = await world(3);
    const out = await cli(["keypool", "report", "p", "--member", "k2", "--from-hook"], env, JSON.stringify(saved("credit-refusal-400")));
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(JSON.parse(out.stdout)).toEqual({ pool: "p", outcome: "exhausted" });
    expect(await states(env)).toEqual(["active", "exhausted", "active"]);
  });
  it("a payload that is no refusal of the key says ignored and exits 0", async () => {
    const { env } = await world(2);
    for (const body of [{ hook_event_name: "Stop" }, { hook_event_name: "StopFailure", error: "server_error", last_assistant_message: "API Error: 500" }]) {
      const out = await cli(["keypool", "report", "p", "--member", "k1", "--from-hook"], env, JSON.stringify(body));
      expect([out.code, JSON.parse(out.stdout)]).toEqual([0, { pool: "p", outcome: "ignored" }]);
    }
    expect(await states(env)).toEqual(["active", "active"]);
  });
  it.each<[string, string[]]>([
    ["with neither a member nor a grant", ["keypool", "report", "p", "--from-hook"]],
    ["with both a member and a grant", ["keypool", "report", "p", "--member", "k1", "--grant", "g1", "--from-hook"]],
    ["with --lease", ["keypool", "report", "p", "--member", "k1", "--lease", "l1", "--from-hook"]],
    ["with --outcome", ["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted", "--from-hook"]],
    ["with --reason", ["keypool", "report", "p", "--member", "k1", "--reason", "credit", "--from-hook"]],
  ])("is refused %s, with the word usage, before stdin is read or anything changes", async (_name, args) => {
    const { env } = await world(2);
    const out = await cli(args, env, JSON.stringify(saved("credit-refusal-400")));
    expect([out.code, out.stdout, out.stderr.trim()]).toEqual([1, "", "usage"]);
    expect(await states(env)).toEqual(["active", "active"]);
  });
  it("stdin that is not JSON exits 1 with the word payload and changes nothing; one over 64 KB says too_big", async () => {
    const { env } = await world(2);
    const bad = await cli(["keypool", "report", "p", "--member", "k1", "--from-hook"], env, `not json ${PLANTED}`);
    expect([bad.code, bad.stdout, bad.stderr.trim()]).toEqual([1, "", "payload"]);
    const big = await cli(["keypool", "report", "p", "--member", "k1", "--from-hook"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "billing_error", last_assistant_message: "x".repeat(70_000) }));
    expect([big.code, big.stdout, big.stderr.trim()]).toEqual([1, "", "too_big"]);
    expect(await states(env)).toEqual(["active", "active"]);
  });
  it("an unknown pool or member says its word", async () => {
    const { env } = await world(2);
    const payload = JSON.stringify(saved("credit-refusal-400"));
    expect((await cli(["keypool", "report", "nope", "--member", "k1", "--from-hook"], env, payload)).stderr.trim()).toBe("missing");
    expect((await cli(["keypool", "report", "p", "--member", "k9", "--from-hook"], env, payload)).stderr.trim()).toBe("missing");
    expect((await cli(["keypool", "report", "p", "--grant", "gnope", "--from-hook"], env, payload)).stderr.trim()).toBe("grant_missing");
  });
});

describe("a planted secret in the hook payload", () => {
  const everywhere = {
    ...saved("credit-refusal-400"), error_details: PLANTED, session_id: PLANTED, transcript_path: `/work/${PLANTED}.jsonl`, cwd: `/work/${PLANTED}`,
    last_assistant_message: `Credit balance is too low ${PLANTED}`, extra: { nested: PLANTED },
  };
  it("by hand, by member: stdout, stderr, every file of the home, the pool's events and the log hold none of it", async () => {
    const { env, dir } = await world(2);
    const out = await cli(["keypool", "report", "p", "--member", "k1", "--from-hook"], env, JSON.stringify(everywhere));
    expect(out.code, out.stderr).toBe(0);
    const unclassified = await cli(["keypool", "report", "p", "--member", "k2", "--from-hook"], env, JSON.stringify({ hook_event_name: "StopFailure", error: "unknown", last_assistant_message: `API Error: 418 ${PLANTED}`, error_details: PLANTED }));
    expect(unclassified.code, unclassified.stderr).toBe(0);
    const all = [out.stdout, out.stderr, unclassified.stdout, unclassified.stderr, (await cli(["keypool", "list"], env)).stdout, (await cli(["log"], env)).stdout, (await cli(["log", "k1"], env)).stdout];
    for (const text of all) expect(text).not.toContain(PLANTED);
    for (const path of homeFiles(dir)) expect(readFileSync(path).toString("latin1"), path).not.toContain(PLANTED);
  });
  it("from a run's own hook: the same, and the key of the member is in none of it either", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, hook: everywhere } }));
    expect(ran.code, ran.stderr).toBe(0);
    const hook = hookRuns(dir);
    expect(hook).toHaveLength(1);
    const all = [ran.stdout, ran.stderr, hook[0]?.stdout ?? "", hook[0]?.stderr ?? "", (await cli(["keypool", "list"], env)).stdout, (await cli(["log"], env)).stdout];
    for (const text of all) { expect(text).not.toContain(PLANTED); for (const key of KEYS) expect(text).not.toContain(key); }
    for (const path of homeFiles(dir)) {
      const body = readFileSync(path).toString("latin1");
      expect(body, path).not.toContain(PLANTED);
      for (const key of KEYS) expect(body, path).not.toContain(key);
    }
  });
});
