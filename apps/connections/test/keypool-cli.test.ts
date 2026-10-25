// `morndo-keys keypool …`, `lease --pool` and `run --pool` through the real bin (ADR-0036, slice 1). The runtime is the fixture
// fake-keyed-runtime.mjs: it takes its key from the helper the launcher gave it and answers per key. Every key is synthetic.
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
  const dir = mkdtempSync(join(tmpdir(), "morndo-keypool-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "home"));
  return dir;
};
// HOME is a temporary one: the launcher's helper line is then this build's own bin, never an installed morndo-keys (a build with
// an older catalog schema would refuse the catalog the helper is given).
const envOf = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath, MORNDO_CLAUDE_BIN: fixture,
  PWD: join(dir, "work"), ...extra,
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

// A home with key Connections k1..kN (their terms read) and, unless `pool` is false, the pool "p" over them.
async function world(n = 3, opts: { pool?: boolean; mode?: string } = {}): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = homeDir();
  const env = envOf(dir);
  for (let i = 1; i <= n; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  if (opts.pool !== false) {
    const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", ...(opts.mode ? ["--mode", opts.mode] : []), ...Array.from({ length: n }, (_, i) => `k${i + 1}`)], env);
    expect(made.code, made.stderr).toBe(0);
  }
  return { dir, env };
}
const lease = (env: NodeJS.ProcessEnv, pool = "p", extra: string[] = []) => cli(["lease", "--pool", pool, "--isolation", "rules", ...extra], env);
const pools = async (env: NodeJS.ProcessEnv) => (await cli(["keypool", "list"], env)).stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { name: string; mode: string; standing: string; lastPick: string | null; members: { credential: string; state: string; reason: string | null }[] });
// What the agent CLI prints as the result of a headless run the provider refused (observed 2026-10-25 with 2.1.310): one JSON record.
const refusal = (status: number | null, message: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "result", subtype: "success", is_error: true, api_error_status: status, terminal_reason: "api_error", num_turns: 1,
  total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 }, result: message, ...over,
});
type Answer = { exit: number; say?: string; sayErr?: string; json?: Record<string, unknown>; report?: string[] };
const reportsOf = (dir: string): { code: number; stderr: string }[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl.report"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { code: number; stderr: string }); } catch { return []; }
};
const job = (dir: string, keys: Record<string, Answer>): string => {
  const path = join(dir, "work", `job-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ record: join(dir, "work", "record.jsonl"), keys }));
  return path;
};
const used = (dir: string): string[] => {
  try { return readFileSync(join(dir, "work", "record.jsonl"), "utf8").trim().split("\n").map(line => (JSON.parse(line) as { key: string }).key); } catch { return []; }
};
const run = (env: NodeJS.ProcessEnv, dir: string, jobPath: string, extra: string[] = [], headless = true) =>
  cli(["run", "--pool", "p", "--workspace", join(dir, "work"), "--reserve", "1", ...extra, "--", ...(headless ? ["-p"] : []), "--job", jobPath], env);
// Every file of the home a secret could have been written to: the database and its journal, the alert log, the pin files. Not the vault
// (it holds the keys, by design) and not the fixture's own record.
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

describe("keypool create, list and the terms", () => {
  it("shows the terms line and needs --by, and makes nothing without it", async () => {
    const { env } = await world(2, { pool: false });
    const refused = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--confirm-own-account", "k1", "k2"], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/ack_needed/);
    expect(refused.stderr).toMatch(/spend limit/);
    expect((await pools(env))).toEqual([]);
  });

  it("review F4: a blank --by is no acknowledgement either", async () => {
    const { env } = await world(2, { pool: false });
    for (const by of ["", " ", "   "]) {
      const refused = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", by, "--confirm-own-account", "k1", "k2"], env);
      expect(refused.code, by).toBe(1);
      expect(refused.stderr).toMatch(/ack_needed/);
    }
    expect(await pools(env)).toEqual([]);
  });

  it("re-check NEW 2: --by needs a real value: the literal true (what a bare flag would store) is no name, and a bare --by is refused with its word", async () => {
    const { env } = await world(2, { pool: false });
    const literal = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "true", "--confirm-own-account", "k1", "k2"], env);
    expect(literal.code).toBe(1);
    expect(literal.stderr).toMatch(/ack_needed/);
    for (const args of [["--by", "--confirm-own-account", "k1"], ["--confirm-own-account", "k1", "--by"]]) {
      const bare = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", ...args], env);
      expect(bare.code, args.join(" ")).toBe(1);
      expect(bare.stderr).toMatch(/missing by/);
      expect(bare.stderr).not.toMatch(/Node\.js v|\n\s+at /);                 // a refusal, not a stack trace
    }
    expect(await pools(env)).toEqual([]);
  });

  it("refuses a member until --confirm-own-account (the organization cannot be read yet), and says why", async () => {
    const { env } = await world(2, { pool: false });
    const refused = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "k1", "k2"], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/foreign_organization/);
    expect(await pools(env)).toEqual([]);
  });

  it("creates the pool and lists it in ring order with health words, no ref, no fingerprint, no key", async () => {
    const { env, dir } = await world(3);
    const [listed] = await pools(env);
    expect(listed).toMatchObject({ name: "p", mode: "round-robin", standing: "ok", lastPick: null });
    expect(listed?.members.map(m => [m.credential, m.state])).toEqual([["k1", "active"], ["k2", "active"], ["k3", "active"]]);
    const raw = (await cli(["keypool", "list"], env)).stdout;
    for (const secret of KEYS) expect(raw).not.toContain(secret);
    expect(raw).not.toMatch(/fingerprint|"ref"/);
    expect(homeFiles(dir).length).toBeGreaterThan(0);
  });

  it("takes --mode and --recheck, refuses a bad one, and refuses a name a Connection holds, and a member of another pool", async () => {
    const { env } = await world(3, { pool: false });
    const bad = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "--recheck", "5m", "k1"], env);
    expect(bad.code).toBe(1);
    expect((await cli(["keypool", "create", "k3", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1"], env)).stderr).toMatch(/taken/);
    expect((await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "--mode", "drain", "--recheck", "6h", "k1", "k2"], env)).code).toBe(0);
    expect((await pools(env))[0]).toMatchObject({ mode: "drain" });
    const again = await cli(["keypool", "create", "q", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k2"], env);
    expect(again.stderr).toMatch(/in_pool/);
  });

  it("a vendor that names no key-pool data is refused with no_classifier", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    expect((await cli(["add", "z1", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[0])).code).toBe(0);
    const refused = await cli(["keypool", "create", "p", "--vendor", "zai", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "z1"], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/no_classifier/);
  });

  it("add, remove, move, policy, revive and delete change the pool; delete leaves the keys as plain Connections and the name taken", async () => {
    const { env } = await world(3);
    expect((await cli(["keypool", "move", "p", "k3", "--to", "0"], env)).code).toBe(0);
    expect((await pools(env))[0]?.members.map(m => m.credential)).toEqual(["k3", "k1", "k2"]);
    expect((await cli(["keypool", "policy", "p", "--mode", "drain"], env)).code).toBe(0);
    expect((await pools(env))[0]?.mode).toBe("drain");
    expect((await cli(["keypool", "remove", "p", "k1"], env)).code).toBe(0);
    const noFlag = await cli(["keypool", "add", "p", "k1"], env);
    expect(noFlag.code).toBe(1);
    expect(noFlag.stderr).toMatch(/foreign_organization/);
    expect((await cli(["keypool", "add", "p", "k1", "--confirm-own-account"], env)).code).toBe(0);
    expect((await pools(env))[0]?.members.map(m => m.credential)).toEqual(["k3", "k2", "k1"]);
    expect((await cli(["keypool", "revive", "p", "k1"], env)).stderr).toMatch(/active/);
    expect((await cli(["keypool", "delete", "p"], env)).code).toBe(0);
    expect(await pools(env)).toEqual([]);
    expect((await cli(["list"], env)).stdout.trim().split("\n")).toHaveLength(3);
    expect((await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1"], env)).stderr).toMatch(/taken/);
  });

  it("an unknown subcommand is refused, and help names the commands", async () => {
    const { env } = await world(1, { pool: false });
    expect((await cli(["keypool", "frobnicate"], env)).code).toBe(1);
    expect((await cli(["help"], env)).stdout).toMatch(/keypool create/);
    expect((await cli(["help"], env)).stdout).toMatch(/lease --pool/);
  });
});

describe("lease --pool", () => {
  it("serves k1, k2, k3, k1: the key and a newline on stdout, nothing on stderr", async () => {
    const { env } = await world(3);
    for (const key of [KEYS[0], KEYS[1], KEYS[2], KEYS[0]]) {
      const got = await lease(env);
      expect(got.code, got.stderr).toBe(0);
      expect(got.stdout).toBe(`${key}\n`);
      expect(got.stderr).toBe("");
    }
    expect((await pools(env))[0]?.lastPick).toBe("k1");
  });

  it("writes the Connection's own audit for the member it served: one KeyServed, closed after", async () => {
    const { env } = await world(2);
    await lease(env);
    const events = (await cli(["log", "k1"], env)).stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string });
    expect(events.map(e => e.type).slice(-3)).toEqual(["LeaseGranted", "KeyServed", "LeaseClosed"]);
    expect((await cli(["log", "k2"], env)).stdout).not.toContain("KeyServed");
  });

  it("skips a member reported exhausted, across separate processes, and shows it", async () => {
    const { env } = await world(3);
    expect((await lease(env)).stdout).toBe(`${KEYS[0]}\n`);
    expect((await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "exhausted"], env)).code).toBe(0);
    expect((await lease(env)).stdout).toBe(`${KEYS[2]}\n`);
    expect((await lease(env)).stdout).toBe(`${KEYS[0]}\n`);
    const [listed] = await pools(env);
    expect(listed?.members.find(m => m.credential === "k2")).toMatchObject({ state: "exhausted", reason: "credit" });
  });

  it("drain stays on one member until it is reported dry", async () => {
    const { env } = await world(2, { mode: "drain" });
    expect([(await lease(env)).stdout, (await lease(env)).stdout]).toEqual([`${KEYS[0]}\n`, `${KEYS[0]}\n`]);
    await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted"], env);
    expect([(await lease(env)).stdout, (await lease(env)).stdout]).toEqual([`${KEYS[1]}\n`, `${KEYS[1]}\n`]);
  });

  it("a pool of one equals lease --connection byte for byte and writes the same audit", async () => {
    const { env } = await world(1, { pool: false });
    expect((await cli(["keypool", "create", "solo", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1"], env)).code).toBe(0);
    const viaConnection = await cli(["lease", "--connection", "k1", "--isolation", "rules"], env);
    const viaPool = await lease(env, "solo");
    expect(viaPool).toEqual(viaConnection);
    const events = (await cli(["log", "k1"], env)).stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string; caller?: { isolation: string; proof: string; lane: string | null } });
    const served = events.filter(e => e.type === "KeyServed");
    expect(served).toHaveLength(2);
    expect(served[0]?.caller?.isolation).toBe(served[1]?.caller?.isolation);
    expect(served[0]?.caller?.proof).toBe(served[1]?.caller?.proof);
    expect(events.map(e => e.type).filter(t => t === "LeaseGranted" || t === "LeaseClosed")).toEqual(["LeaseGranted", "LeaseClosed", "LeaseGranted", "LeaseClosed"]);
  });

  it("refuses with a word and exit 75 when the pool is empty, blocked, or its terms are not current, and exit 1 for a bad call", async () => {
    const { env, dir } = await world(2);
    expect((await lease(env, "nope")).stderr).toMatch(/missing/);
    expect((await cli(["lease", "--pool", "p", "--connection", "k1"], env)).code).toBe(1);
    expect((await cli(["lease", "--pool", "p", "--member", "k1"], env)).code).toBe(1);
    await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted"], env);
    await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "exhausted"], env);
    const empty = await lease(env);
    expect(empty).toMatchObject({ code: 75, stdout: "" });
    expect(empty.stderr).toMatch(/pool_empty/);
    await cli(["keypool", "revive", "p", "k1"], env);
    await cli(["keypool", "revive", "p", "k2"], env);
    await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "failing", "--reason", "denied"], env);
    const blocked = await lease(env);
    expect(blocked).toMatchObject({ code: 75, stdout: "" });
    expect(blocked.stderr).toMatch(/pool_blocked/);
    await cli(["keypool", "revive", "p", "k2"], env);
    // The key-pool terms are their own file beside the catalog (review F7): a copy of both, with the revision moved on.
    const copy = join(dir, "changed");
    mkdirSync(copy);
    writeFileSync(join(copy, "vendors.json"), readFileSync(catalogPath));
    const entries = JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/catalog/key-pools.json"), "utf8")) as { termsRevision: string }[];
    for (const entry of entries) entry.termsRevision = "2099-01-01";
    writeFileSync(join(copy, "key-pools.json"), JSON.stringify(entries));
    const changed = join(copy, "vendors.json");
    const moved = await lease({ ...env, MORNDO_CATALOG: changed });
    expect(moved).toMatchObject({ code: 75, stdout: "" });
    expect(moved.stderr).toMatch(/terms/);
  });
});

describe("keypool report", () => {
  it("shows in list, in the page message and in the alert file as a reason word only", async () => {
    const { env, dir } = await world(2);
    expect((await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "exhausted", "--reason", "spend-limit"], env)).code).toBe(0);
    expect((await pools(env))[0]?.members[1]).toMatchObject({ credential: "k2", state: "exhausted", reason: "spend-limit" });
    const alertLog = readFileSync(join(dir, "alerts.log"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, string>);
    expect(alertLog).toEqual([{ kind: "key-exhausted", name: "k2", detail: "spend-limit" }]);
    const page = JSON.parse((await cli(["page"], env)).stdout) as { alerts: { kind: string; name: string; detail: string }[] };
    expect(page.alerts).toEqual([{ kind: "connection", name: "k2", detail: "A pooled key ran out of credit or reached its spend limit" }]);
  });

  it("a rate limit is recorded and changes nothing; a failing report blocks the pool and raises two alerts", async () => {
    const { env, dir } = await world(2);
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "limited"], env)).code).toBe(0);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active"]);
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "failing", "--reason", "held"], env)).code).toBe(0);
    expect((await pools(env))[0]).toMatchObject({ standing: "blocked" });
    const kinds = readFileSync(join(dir, "alerts.log"), "utf8").trim().split("\n").map(line => (JSON.parse(line) as { kind: string }).kind);
    expect(kinds).toEqual(["key-failing", "pool-blocked"]);
  });

  it("refuses an unknown member, an unknown outcome and a reason that does not fit", async () => {
    const { env } = await world(2);
    expect((await cli(["keypool", "report", "p", "--member", "nope", "--outcome", "exhausted"], env)).code).toBe(1);
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "melted"], env)).code).toBe(1);
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted", "--reason", "denied"], env)).code).toBe(1);
  });

  it("revive brings an exhausted member back; ok is refused, a recovery is a revive or a real request (review F2)", async () => {
    const { env } = await world(2);
    await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted"], env);
    expect((await cli(["keypool", "revive", "p", "k1"], env)).code).toBe(0);
    expect((await pools(env))[0]?.members[0]?.state).toBe("active");
    await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "exhausted"], env);
    const ok = await cli(["keypool", "report", "p", "--member", "k2", "--outcome", "ok"], env);
    expect(ok.code).toBe(1);
    expect(ok.stderr).toMatch(/not_allowed/);
    expect((await pools(env))[0]?.members[1]?.state).toBe("exhausted");
  });
});

describe("review F2: a lane reports only for the member of its own run", () => {
  // The fixture runtime runs `keypool report … --grant <the grant its helper line names>` as a child of the run, as a lane's tool would
  // (slice 2: a pooled run's helper is bound to a grant, not to one lease). The member is never named by the lane: the grant knows it.
  it("a lane reports its own member exhausted", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--outcome", "exhausted"] } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(reportsOf(dir)).toEqual([{ code: 0, stderr: "" }]);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["exhausted", "active", "active"]);
  });
  it("a lane cannot name a member (the grant's is the one), nor report ok", async () => {
    const { env, dir } = await world(3);
    const other = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, report: ["p", "--member", "k2", "--outcome", "exhausted"] } }));
    expect(other.code, other.stderr).toBe(0);
    expect(reportsOf(dir)[0]?.code).toBe(1);
    expect(reportsOf(dir)[0]?.stderr).toMatch(/usage/);
    const ok = await run(env, dir, job(dir, { [KEYS[1]]: { exit: 0, report: ["p", "--outcome", "ok"] } }));
    expect(ok.code, ok.stderr).toBe(0);
    expect(reportsOf(dir)[1]?.code).toBe(1);
    expect(reportsOf(dir)[1]?.stderr).toMatch(/not_allowed/);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active", "active"]);
  });
  it("a report naming a lease that is not open is refused", async () => {
    const { env } = await world(2);
    const gone = await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted", "--lease", "l99"], env);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toMatch(/lease_missing/);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active"]);
  });
});

describe("run --pool", () => {
  it("first pick: runs on k1 and leaves the pool healthy, closing the lease as run does", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, {}));
    expect(ran.code, ran.stderr).toBe(0);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]).toMatchObject({ lastPick: "k1", standing: "ok" });
    expect((await cli(["log", "k1"], env)).stdout).toMatch(/LeaseClosed/);
  });

  it("the next run takes the next member: round-robin across runs", async () => {
    const { env, dir } = await world(3);
    await run(env, dir, job(dir, {}));
    await run(env, dir, job(dir, {}));
    expect(used(dir)).toEqual([KEYS[0], KEYS[1]]);
  });

  it("a headless run that is refused for credit reports the key exhausted and continues once on the next member", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 1, json: refusal(400, "Credit balance is too low") } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(used(dir)).toEqual([KEYS[0], KEYS[1]]);
    const [listed] = await pools(env);
    expect(listed?.members.map(m => m.state)).toEqual(["exhausted", "active", "active"]);
    expect(listed?.lastPick).toBe("k2");
  });

  it("an interactive run (no -p) that is refused reports the key and does not retry: the session is the owner's", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 1, json: refusal(400, "Credit balance is too low") } }), [], false);
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["exhausted", "active", "active"]);
  });

  it("retries once only: a second refusal is reported too, a third member is not tried, and the run fails", async () => {
    const { env, dir } = await world(3);
    const dry = { exit: 1, json: refusal(400, "Credit balance is too low") };
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: dry, [KEYS[1]]: dry }));
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0], KEYS[1]]);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["exhausted", "exhausted", "active"]);
  });

  it("a refused key (401) blocks the pool: reported failing, no retry, and the next lease says pool_blocked", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 1, json: refusal(401, "Invalid API key") } }));
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]).toMatchObject({ standing: "blocked" });
    const next = await lease(env);
    expect(next.code).toBe(75);
    expect(next.stderr).toMatch(/pool_blocked/);
  });

  it("a failure that says nothing about the key changes nothing and is not retried", async () => {
    const { env, dir } = await world(3);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 1, say: "tests failed: 3 of 40" } }));
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active", "active"]);
  });

  // Review F1: the model's and the tools' words are in a failed run's output. Only the CLI's structured result counts.
  const PROBES = [
    "authentication_failed",
    "API Error: 403 forbidden",
    "account_on_hold",
    "Credit balance is too low",
    "You have reached your specified API usage limits. You will regain access on 9999-12-31 at 00:00 UTC.",
  ];
  it("review F1: a failed run whose output merely says a refusal word, as text or inside the model's result, changes nothing and is not retried", async () => {
    const { env, dir } = await world(3);
    let runs = 0;
    for (const probe of PROBES) {
      const asText: Answer = { exit: 1, say: `tests failed\n${probe}\nexit 1` };
      const inResult: Answer = { exit: 1, json: refusal(null, probe, { terminal_reason: "completed", total_cost_usd: 0.3, num_turns: 4 }) };
      for (const answer of [asText, inResult]) {
        const ran = await run(env, dir, job(dir, { [KEYS[0]]: answer, [KEYS[1]]: answer, [KEYS[2]]: answer }));
        expect(ran.code, probe).toBe(1);
        runs += 1;
      }
    }
    expect(used(dir)).toHaveLength(runs);                      // one key each time: never a retry
    const [listed] = await pools(env);
    expect(listed?.members.map(m => m.state)).toEqual(["active", "active", "active"]);
    expect(listed?.standing).toBe("ok");
  });

  it("review F1: a run whose caller chose another output format is never read, even when its output is exactly a refusal record", async () => {
    const { env, dir } = await world(3);
    const record = job(dir, { [KEYS[0]]: { exit: 1, json: refusal(401, "Invalid API key") } });
    const ran = await cli(["run", "--pool", "p", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--output-format", "text", "--job", record], env);
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]).toMatchObject({ standing: "ok" });
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active", "active"]);
  });

  it("review F3: a run that was refused after it had done work (it cost something) is reported and stopped, not run again on the next key", async () => {
    const { env, dir } = await world(3);
    const spent = { exit: 1, json: refusal(400, "Credit balance is too low", { total_cost_usd: 0.12, num_turns: 4, modelUsage: { "model-a": { inputTokens: 900 } } }) };
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: spent }));
    expect(ran.code).toBe(1);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["exhausted", "active", "active"]);
  });

  it("review F3: the retry goes on another member, never back to the one that was refused", async () => {
    const { env, dir } = await world(2);
    const dry = { exit: 1, json: refusal(400, "Credit balance is too low") };
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: dry }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(used(dir)).toEqual([KEYS[0], KEYS[1]]);
    const again = await run(env, dir, job(dir, { [KEYS[0]]: dry }));          // k1 is out: the next run does not even try it
    expect(again.code, again.stderr).toBe(0);
    expect(used(dir)).toEqual([KEYS[0], KEYS[1], KEYS[1]]);
  });

  it("a run that succeeds is never read for a refusal, even when its output talks about one", async () => {
    const { env, dir } = await world(2);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 0, say: `Summary: the log said "Credit balance is too low" and account_on_hold, but this run worked.` } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(used(dir)).toEqual([KEYS[0]]);
    expect((await pools(env))[0]).toMatchObject({ standing: "ok" });
    expect((await pools(env))[0]?.members.map(m => m.state)).toEqual(["active", "active"]);
  });

  it("with every member dry, a run is refused with pool_empty and exit 75 before any runtime starts", async () => {
    const { env, dir } = await world(2);
    for (const k of ["k1", "k2"]) await cli(["keypool", "report", "p", "--member", k, "--outcome", "exhausted"], env);
    const ran = await run(env, dir, job(dir, {}));
    expect(ran.code).toBe(75);
    expect(ran.stderr).toMatch(/pool_empty/);
    expect(used(dir)).toEqual([]);
  });

  it("run takes --pool or --connection, not both", async () => {
    const { env, dir } = await world(2);
    const both = await cli(["run", "--pool", "p", "--connection", "k1", "--", "--job", job(dir, {})], env);
    expect(both.code).toBe(1);
    expect(used(dir)).toEqual([]);
  });
});

describe("the planted secret", () => {
  it("a refusal whose text carries the key and a planted token leaves neither in the database, the alert log, the listing or the page", async () => {
    const { env, dir } = await world(3);
    const PLANTED = "planted-refusal-detail-9f3a7c";
    const leak = refusal(400, `Credit balance is too low ${PLANTED} key=${KEYS[0]}`);
    const ran = await run(env, dir, job(dir, { [KEYS[0]]: { exit: 1, json: leak, sayErr: `${PLANTED} ${KEYS[0]}` } }));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).not.toContain(KEYS[0]);                      // the relay filters the exact key
    expect(ran.stderr).not.toContain(KEYS[0]);
    const outputs = [
      (await cli(["keypool", "list"], env)).stdout, (await cli(["log"], env)).stdout, (await cli(["page"], env)).stdout,
    ];
    for (const text of outputs) for (const secret of [PLANTED, ...KEYS]) expect(text).not.toContain(secret);
    for (const path of homeFiles(dir)) {
      const bytes = readFileSync(path);
      for (const secret of [PLANTED, ...KEYS]) expect(bytes.includes(secret), `${path} holds ${secret}`).toBe(false);
    }
  });
});
