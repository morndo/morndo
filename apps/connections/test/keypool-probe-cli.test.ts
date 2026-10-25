// Probes through the real bin (ADR-0037, slice 3): `keypool recheck`, and the inline probe of `lease --pool` and `run --pool` on an empty pool with a
// due member. A local server stands in for the Messages API and answers per key; a temporary catalog points the first-party runtime at it. No real
// key, nothing leaves the machine. Every key is synthetic, and the planted secrets must reach nothing.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
const KEYS: [string, string, string] = ["sk-ant-synthetic-probe-key-0001", "sk-ant-synthetic-probe-key-0002", "sk-ant-synthetic-probe-key-0003"];
const PLANTED = "planted-secret-in-the-provider-body";
const catalogDir = join(import.meta.dirname, "../../../packages/protocol/catalog");
const fixture = join(import.meta.dirname, "fixtures/fake-keyed-runtime.mjs");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string };
type Seen = { method: string; path: string; key: string; body: string };
type Answer = { status: number; body?: string };
const creditBody = (extra = ""): string => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Your credit balance is too low to access the Anthropic API. ${extra}` }, request_id: "req_synthetic" });

// A stand-in API: it answers by the key it was given (200 unless the test says otherwise) and records every request.
async function api(): Promise<{ url: string; seen: Seen[]; answers: Record<string, Answer>; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const answers: Record<string, Answer> = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const key = String(req.headers["x-api-key"] ?? "");
      seen.push({ method: req.method ?? "", path: req.url ?? "", key, body });
      const answer = answers[key] ?? { status: 200 };
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body ?? JSON.stringify({ id: "msg_synthetic", type: "message", role: "assistant", content: [{ type: "text", text: "." }] }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, answers, close: () => new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); }) };
}

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

// A home with keys k1..k3, the pool "p" over them, and a catalog whose first-party runtime is the stand-in API.
async function world(base: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-probe-cli-"));
  dirs.push(dir);
  for (const name of ["work", "home", "cat"]) mkdirSync(join(dir, name));
  cpSync(catalogDir, join(dir, "cat"), { recursive: true });
  const vendors = JSON.parse(readFileSync(join(dir, "cat", "vendors.json"), "utf8")) as { id: string; runtimes: { baseUrl: string | null }[] }[];
  const first = vendors.find(row => row.id === "anthropic");
  if (!first?.runtimes[0]) throw new Error("no first-party preset");
  first.runtimes[0].baseUrl = base;
  writeFileSync(join(dir, "cat", "vendors.json"), JSON.stringify(vendors));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: join(dir, "cat", "vendors.json"),
    MORNDO_CLAUDE_BIN: fixture, PWD: join(dir, "work"),
  };
  for (let i = 1; i <= 3; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1", "k2", "k3"], env);
  expect(made.code, made.stderr).toBe(0);
  return { dir, env };
}
type Member = { credential: string; state: string; nextCheck: number | null };
type View = { name: string; standing: string; members: Member[]; probe: { costUsd: number; last24h: number } };
const view = async (env: NodeJS.ProcessEnv): Promise<View> => JSON.parse((await cli(["keypool", "list"], env)).stdout.trim().split("\n")[0] ?? "{}") as View;
const dry = async (env: NodeJS.ProcessEnv, member: string) => {
  const out = await cli(["keypool", "report", "p", "--member", member, "--outcome", "exhausted"], env);
  expect(out.code, out.stderr).toBe(0);
};
// The clock is the machine's: a member is made due by moving its next check into the past in the pool's own row.
function makeDue(dir: string, ...members: string[]): void {
  const db = new Database(join(dir, "connections.db"));
  const row = db.prepare("SELECT version, body FROM key_pool WHERE name = 'p'").get() as { version: number; body: string };
  const body = JSON.parse(row.body) as { members: { credential: string; nextCheck: number | null; lastProbe: number | null }[] };
  for (const m of body.members) if (members.includes(m.credential)) { m.nextCheck = Date.now() - 1000; m.lastProbe = null; }
  db.prepare("UPDATE key_pool SET body = ?, version = version + 1 WHERE name = 'p'").run(JSON.stringify(body));
  db.close();
}
const lines = (out: Out): Record<string, unknown>[] => out.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
function homeFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (path === join(dir, "vault") || path === join(dir, "work") || path === join(dir, "cat")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(dir);
  return found;
}

describe("keypool recheck", () => {
  it("with nothing due it prints nothing, exits 0 and sends nothing", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await dry(env, "k1");
    const out = await cli(["keypool", "recheck"], env);
    expect([out.code, out.stdout, out.stderr]).toEqual([0, "", ""]);
    expect(fake.seen).toEqual([]);
  });
  it("--member probes that member now: a topped-up key comes back, through one POST to /v1/messages with max_tokens 1 and the probe model", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await dry(env, "k1");
    const out = await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    expect(out.code, out.stderr).toBe(0);
    expect(lines(out)).toEqual([{ pool: "p", member: "k1", outcome: "recovered" }]);
    expect(fake.seen).toHaveLength(1);
    const call = fake.seen[0]!;
    expect([call.method, call.path, call.key]).toEqual(["POST", "/v1/messages", KEYS[0]]);
    expect(JSON.parse(call.body)).toEqual({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "." }] });
    expect((await view(env)).members.map(m => m.state)).toEqual(["active", "active", "active"]);
  });
  it("a key that is still dry stays exhausted and its next check moves out", async () => {
    const fake = await api();
    fake.answers[KEYS[0]] = { status: 400, body: creditBody() };
    const { dir, env } = await world(fake.url);
    await dry(env, "k1");
    makeDue(dir, "k1");
    const before = (await view(env)).members[0]!.nextCheck as number;
    const out = await cli(["keypool", "recheck"], env);
    expect(lines(out)).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    const after = (await view(env)).members[0]!;
    expect(after.state).toBe("exhausted");
    expect(after.nextCheck as number).toBeGreaterThan(before);
    // A manual probe of the same key does not move the schedule again.
    const manual = await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    expect(lines(manual)).toEqual([{ pool: "p", member: "k1", outcome: "skipped", word: "claimed" }]);
  });
  it("a plain recheck probes the members that are due and no other", async () => {
    const fake = await api();
    const { dir, env } = await world(fake.url);
    await dry(env, "k1");
    await dry(env, "k2");
    makeDue(dir, "k1");
    const out = await cli(["keypool", "recheck"], env);
    expect(out.code, out.stderr).toBe(0);
    expect(lines(out)).toEqual([{ pool: "p", member: "k1", outcome: "recovered" }]);
    expect(fake.seen.map(call => call.key)).toEqual([KEYS[0]]);
  });
  it("a second --member within thirty seconds finds the claim and sends nothing", async () => {
    const fake = await api();
    fake.answers[KEYS[0]] = { status: 400, body: creditBody() };
    const { env } = await world(fake.url);
    await dry(env, "k1");
    await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    const again = await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    expect(lines(again)).toEqual([{ pool: "p", member: "k1", outcome: "skipped", word: "claimed" }]);
    expect(fake.seen).toHaveLength(1);
  });
  it("a provider that cannot be reached changes nothing and says so", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await dry(env, "k1");
    await fake.close();
    const out = await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    expect(out.code, out.stderr).toBe(0);
    expect(lines(out)).toEqual([{ pool: "p", member: "k1", outcome: "unreachable" }]);
    expect((await view(env)).members[0]!.state).toBe("exhausted");
  });
  it("--member without a pool is a usage error, exit 1, and sends nothing", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await dry(env, "k1");
    const out = await cli(["keypool", "recheck", "--member", "k1"], env);
    expect([out.code, out.stderr.trim()]).toEqual([1, "usage"]);
    expect(fake.seen).toEqual([]);
  });
  it("an unknown pool or member is refused with its word and exit 1", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    const out = await cli(["keypool", "recheck", "nope"], env);
    expect(out.code).toBe(1);
    expect(out.stderr.trim()).toBe("missing");
    expect(fake.seen).toEqual([]);
  });
  it("list shows what a probe costs and how many were claimed in the last day", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await dry(env, "k1");
    expect((await view(env)).probe).toEqual({ costUsd: 0.00002, last24h: 0 });
    await cli(["keypool", "recheck", "p", "--member", "k1"], env);
    expect((await view(env)).probe).toEqual({ costUsd: 0.00002, last24h: 1 });
  });
});

describe("an empty pool probes inline, once", () => {
  const allDry = async (env: NodeJS.ProcessEnv) => { for (const name of ["k1", "k2", "k3"]) await dry(env, name); };
  it("lease --pool: every member dry and one due, the probe finds that key topped up and the lease serves it (stdout is the key and a newline only)", async () => {
    const fake = await api();
    fake.answers[KEYS[0]] = { status: 400, body: creditBody() };
    const { dir, env } = await world(fake.url);
    await allDry(env);
    makeDue(dir, "k2");
    const out = await cli(["lease", "--pool", "p", "--isolation", "rules"], env);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toBe(`${KEYS[1]}\n`);
    expect(fake.seen.map(call => call.key)).toEqual([KEYS[1]]);
  });
  it("lease --pool with nothing due is refused with pool_empty, exit 75, and sends nothing", async () => {
    const fake = await api();
    const { env } = await world(fake.url);
    await allDry(env);
    const out = await cli(["lease", "--pool", "p", "--isolation", "rules"], env);
    expect([out.code, out.stderr.trim()]).toEqual([75, "pool_empty"]);
    expect(fake.seen).toEqual([]);
  });
  it("four lease --pool at once on an empty pool with one due member: exactly one request reaches the API", async () => {
    const fake = await api();
    const { dir, env } = await world(fake.url);
    await allDry(env);
    makeDue(dir, "k1");
    const outs = await Promise.all(Array.from({ length: 4 }, () => cli(["lease", "--pool", "p", "--isolation", "rules"], env)));
    expect(fake.seen).toHaveLength(1);
    expect(outs.filter(out => out.code === 0).length).toBeGreaterThanOrEqual(1);
    for (const out of outs) if (out.code !== 0) expect([out.code, out.stderr.trim()]).toEqual([75, "pool_empty"]);
  });
  it("run --pool on an empty pool with one due member probes once and runs on the recovered key", async () => {
    const fake = await api();
    const { dir, env } = await world(fake.url);
    await allDry(env);
    makeDue(dir, "k3");
    const path = join(dir, "work", "job.json");
    writeFileSync(path, JSON.stringify({ record: join(dir, "work", "record.jsonl"), keys: { [KEYS[2]]: { exit: 0 } } }));
    const ran = await cli(["run", "--pool", "p", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", path], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(fake.seen.map(call => call.key)).toEqual([KEYS[2]]);
    const record = readFileSync(join(dir, "work", "record.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { key: string });
    expect(record.map(row => row.key)).toEqual([KEYS[2]]);
  });
});

describe("kp12 the probe path leaves no secret anywhere", () => {
  it("a provider body with a planted secret and the key echoed in its message reaches no output, file, event or alert", async () => {
    const fake = await api();
    fake.answers[KEYS[0]] = { status: 400, body: creditBody(`${PLANTED} ${KEYS[0]}`) };
    fake.answers[KEYS[1]] = { status: 418, body: JSON.stringify({ type: "error", error: { type: "teapot_error", message: `${PLANTED} ${KEYS[1]}` } }) };
    const { dir, env } = await world(fake.url);
    await dry(env, "k1");
    await dry(env, "k2");
    const outs = [
      await cli(["keypool", "recheck", "p", "--member", "k1"], env),
      await cli(["keypool", "recheck", "p", "--member", "k2"], env),
      await cli(["keypool", "list"], env),
      await cli(["log", "k1"], env),
      await cli(["log", "k2"], env),
    ];
    const said = JSON.stringify(outs);
    for (const secret of [PLANTED, ...KEYS]) expect(said).not.toContain(secret);
    for (const file of homeFiles(dir)) {
      const bytes = readFileSync(file).toString("latin1");
      for (const secret of [PLANTED, ...KEYS]) expect(bytes.includes(secret), `${secret} in ${file}`).toBe(false);
    }
  });
});

describe("the recheck timer", () => {
  const unit = (name: string): string => readFileSync(join(import.meta.dirname, "../units", name), "utf8");
  it("the service is a oneshot that runs keypool recheck from the user's bin, with no Install section", () => {
    const service = unit("morndo-keys-recheck.service").split("\n").filter(line => !line.startsWith("#")).join("\n");
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^ExecStart=%h\/\.local\/bin\/morndo-keys keypool recheck$/m);
    expect(service).not.toMatch(/\[Install\]/);
  });
  it("the timer is a calendar timer, on the hour and spread: Persistent=true only has an effect on OnCalendar (systemd.timer(5)), and no monotonic line is left that it would not touch", () => {
    const timer = unit("morndo-keys-recheck.timer");
    for (const line of ["OnCalendar=hourly", "RandomizedDelaySec=5min", "Persistent=true", "WantedBy=timers.target"]) {
      expect(timer).toMatch(new RegExp(`^${line}$`, "m"));
    }
    expect(timer).not.toMatch(/^OnBootSec=/m);
    expect(timer).not.toMatch(/^OnUnitActiveSec=/m);
  });
});
