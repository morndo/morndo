// `keypool watch` through the real bin (ADR-0037, slice 4; plan 3.6): for a server that cannot report a dry key itself, the command reads its log, and on the
// two exhausted phrases of the classifier PROBES the member it blames: a log holds anyone's words, so a line is a reason to ask the provider, never a verdict
// (one token, the smallest model, at most one per member per spacing). The matched line is never echoed. With --sink the member is the key the SERVER loaded:
// the server's start time (--server-pid, or a pid file re-read at each phrase) says which write of the sink it read; unknown, or a server that is gone, blames no one. A local stand-in API
// answers per key; a temporary catalog points the first-party runtime at it. Every key is synthetic.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });
const KEYS: [string, string, string] = ["sk-ant-synthetic-log-key-0001", "sk-ant-synthetic-log-key-0002", "sk-ant-synthetic-log-key-0003"];
const PLANTED = "planted-secret-in-the-log-line";
const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const SPEND = "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const catalogDir = join(import.meta.dirname, "../../../packages/protocol/catalog");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => { resolve(); }); server.closeAllConnections(); });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string };
type Seen = { method: string; path: string; key: string; body: string };
type Answer = { status: number; body?: string };
const refusal = (status: number, type: string, message: string): Answer => ({ status, body: JSON.stringify({ type: "error", error: { type, message }, request_id: "req_synthetic" }) });
const dryKey = refusal(400, "invalid_request_error", CREDIT);
const spentKey = refusal(400, "invalid_request_error", SPEND);
// A stand-in API: it answers by the key it was given (200 unless the test says otherwise) and records every request. Nothing leaves the machine.
async function api(): Promise<{ url: string; seen: Seen[]; answers: Record<string, Answer> }> {
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
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, answers };
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
type World = { dir: string; env: NodeJS.ProcessEnv; sinks: string; log: string; file: string; fake: Awaited<ReturnType<typeof api>> };
async function world(): Promise<World> {
  const fake = await api();
  const dir = mkdtempSync(join(tmpdir(), "morndo-watch-"));
  const sinks = mkdtempSync(join(tmpdir(), "morndo-watchfiles-"));
  dirs.push(dir, sinks);
  for (const name of ["work", "home", "cat"]) mkdirSync(join(dir, name));
  cpSync(catalogDir, join(dir, "cat"), { recursive: true });
  const vendors = JSON.parse(readFileSync(join(dir, "cat", "vendors.json"), "utf8")) as { id: string; runtimes: { baseUrl: string | null }[] }[];
  const first = vendors.find(row => row.id === "anthropic");
  if (!first?.runtimes[0]) throw new Error("no first-party preset");
  first.runtimes[0].baseUrl = fake.url;
  writeFileSync(join(dir, "cat", "vendors.json"), JSON.stringify(vendors));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: join(dir, "cat", "vendors.json"), PWD: join(dir, "work"),
  };
  for (let i = 1; i <= 3; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "k1", "k2", "k3"], env);
  expect(made.code, made.stderr).toBe(0);
  const file = join(sinks, "app.env");
  expect((await cli(["keypool", "sink", "add", "p", file], env)).code).toBe(0);
  return { dir, env, sinks, log: join(sinks, "server.log"), file, fake };
}
type View = { members: { credential: string; state: string; reason: string | null }[] };
const view = async (w: World): Promise<View> => JSON.parse((await cli(["keypool", "list"], w.env)).stdout.trim().split("\n")[0] ?? "{}") as View;
const states = async (w: World): Promise<string[]> => (await view(w)).members.map(m => m.state);
const watch = (w: World, ...more: string[]) => cli(["keypool", "watch", "p", "--log", w.log, ...more], w.env);
const writeEnv = (w: World, ...more: string[]) => cli(["keypool", "write-env", "p", "--file", w.file, "--var", "ANTHROPIC_API_KEY", "--isolation", "rules", ...more], w.env);
const lines = (out: Out): unknown[] => out.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}
// The command in follow mode, as a child that is killed when the test is over; its output is collected.
function follow(w: World, ...more: string[]): { out: () => string; err: () => string } {
  const child = spawn(process.execPath, ["--experimental-strip-types", main, "keypool", "watch", "p", "--log", w.log, ...more], { env: w.env });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end();
  return { out: () => stdout, err: () => stderr };
}
// A stand-in for the server that reads the sink: a process of its own, whose start time is what watch is told. Killed when the test is over.
async function server(): Promise<number> {
  const child = spawn("sleep", ["120"]);
  children.push(child);
  await new Promise<void>(resolve => { child.on("spawn", () => { resolve(); }); });
  return child.pid ?? 0;
}
function homeFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (path === join(dir, "vault")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(dir);
  return found;
}

describe("--once: a phrase in the log is a reason to ask the provider about the member", () => {
  it("a credit line is probed; the key is dry, so it is exhausted, and one line of words is printed; the matched line is never echoed", async () => {
    const w = await world();
    w.fake.answers[KEYS[1]] = dryKey;
    writeFileSync(w.log, `start\n${CREDIT} ${PLANTED} ${KEYS[1]}\nend\n`);
    const out = await watch(w, "--member", "k2", "--once");
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(lines(out)).toEqual([{ pool: "p", member: "k2", outcome: "exhausted" }]);
    expect(await states(w)).toEqual(["active", "exhausted", "active"]);
    expect(w.fake.seen.map(row => [row.method, row.path, row.key])).toEqual([["POST", "/v1/messages", KEYS[1]]]);
    for (const text of [out.stdout, out.stderr, (await cli(["keypool", "list"], w.env)).stdout, (await cli(["log"], w.env)).stdout]) {
      expect(text).not.toContain(PLANTED);
      for (const key of KEYS) expect(text).not.toContain(key);
    }
    for (const path of homeFiles(w.dir)) { const body = readFileSync(path).toString("latin1"); expect(body, path).not.toContain(PLANTED); for (const key of KEYS) expect(body, path).not.toContain(key); }
  });
  it("a line that only says so does not make a healthy key dry: the probe is answered, the member is healthy and stays active", async () => {
    const w = await world();
    writeFileSync(w.log, `user said: ${CREDIT}\n`);
    const out = await watch(w, "--member", "k1", "--once");
    expect(lines(out)).toEqual([{ pool: "p", member: "k1", outcome: "healthy" }]);
    expect(await states(w)).toEqual(["active", "active", "active"]);
    expect(w.fake.seen).toHaveLength(1);
  });
  it("a spend-limit line is probed too, and a key at its limit is exhausted for the spend limit", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = spentKey;
    writeFileSync(w.log, `${SPEND}\n`);
    expect(lines(await watch(w, "--member", "k1", "--once"))).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect((await view(w)).members[0]).toMatchObject({ state: "exhausted", reason: "spend-limit" });
  });
  it("lines that are not those two phrases change nothing, print nothing and send nothing: a rate limit, a hold, a refused key, ordinary traffic", async () => {
    const w = await world();
    writeFileSync(w.log, ["GET / 200", "429 rate_limit_error: per-minute rate limit", "403 account_on_hold", "401 authentication_error invalid x-api-key", "authentication_failed"].join("\n") + "\n");
    const out = await watch(w, "--member", "k1", "--once");
    expect([out.code, out.stdout, out.stderr]).toEqual([0, "", ""]);
    expect(await states(w)).toEqual(["active", "active", "active"]);
    expect(w.fake.seen).toEqual([]);
  });
  it("three matches in a row cause one probe and one line (a member is acted on at most once in ten seconds)", async () => {
    const w = await world();
    writeFileSync(w.log, `${CREDIT}\n${CREDIT}\n${SPEND}\n`);
    expect(lines(await watch(w, "--member", "k1", "--once"))).toHaveLength(1);
    expect(w.fake.seen).toHaveLength(1);
  });
  it("another run inside the probe's spacing is skipped: the provider is not asked again, however often the log says it", async () => {
    const w = await world();
    writeFileSync(w.log, `${CREDIT}\n`);
    await watch(w, "--member", "k1", "--once");
    const again = await watch(w, "--member", "k1", "--once");
    expect(lines(again)).toEqual([{ pool: "p", member: "k1", outcome: "skipped" }]);
    expect(w.fake.seen).toHaveLength(1);
  });
  it("a member that is already exhausted is not probed", async () => {
    const w = await world();
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "exhausted"], w.env)).code).toBe(0);
    writeFileSync(w.log, `${CREDIT}\n`);
    const out = await watch(w, "--member", "k1", "--once");
    expect([out.code, out.stdout]).toEqual([0, ""]);
    expect(w.fake.seen).toEqual([]);
  });
  it("what it prints passes the exact-value filter: a member named as its own key's value is printed as [redacted]", async () => {
    const w = await world();
    const leaky = "sk-ant-synthetic-log-leak-0009";
    expect((await cli(["add", leaky, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], w.env, leaky)).code).toBe(0);
    expect((await cli(["ack", leaky, "--by", "owner"], w.env)).code).toBe(0);
    expect((await cli(["keypool", "add", "p", leaky, "--confirm-own-account"], w.env)).code).toBe(0);
    w.fake.answers[leaky] = dryKey;
    writeFileSync(w.log, `${CREDIT}\n`);
    const out = await watch(w, "--member", leaky, "--once");
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).not.toContain(leaky);
    expect(lines(out)).toEqual([{ pool: "p", member: "[redacted]", outcome: "exhausted" }]);
  });
  it("usage and missing: one of --member or --sink, --log needed, a pool and a member that exist, a file that is a sink, a server pid that is one number or one pid file and only with --sink", async () => {
    const w = await world();
    writeFileSync(w.log, "x\n");
    const word = async (args: string[]) => (await cli(args, w.env)).stderr.trim();
    expect(await word(["keypool", "watch", "p", "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--member", "k1", "--sink", w.file, "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "nope", "--log", w.log, "--member", "k1", "--once"])).toBe("missing");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--member", "k9", "--once"])).toBe("missing");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--sink", join(w.sinks, "other.env"), "--once"])).toBe("not_a_sink");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--sink", w.file, "--server-pid", "soon", "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--sink", w.file, "--server-pid", "5", "--server-pid-file", join(w.sinks, "x.pid"), "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--member", "k1", "--server-pid", "5", "--once"])).toBe("usage");
  });
  it("a log that is not there is an error with --once", async () => {
    const w = await world();
    const out = await watch(w, "--member", "k1", "--once");
    expect([out.code, out.stderr.trim()]).toEqual([1, "no_log"]);
  });
});

describe("--sink: the key the server loaded is the key of the write that was the file when the server started", () => {
  it("a server that started after the write holds that write's key: the stamped member is probed", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    expect((await writeEnv(w)).code).toBe(0);
    await sleep(1700);
    const pid = await server();
    writeFileSync(w.log, `${CREDIT}\n`);
    expect(lines(await watch(w, "--sink", w.file, "--server-pid", String(pid), "--once"))).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect(await states(w)).toEqual(["exhausted", "active", "active"]);
    expect(w.fake.seen.map(row => row.key)).toEqual([KEYS[0]]);
  });
  it("a server that started BEFORE the file was rewritten still holds the old key: the old member is probed, not the new one", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    w.fake.answers[KEYS[1]] = dryKey;
    expect((await writeEnv(w)).code).toBe(0);
    await sleep(1700);
    const pid = await server();
    await sleep(2300);
    expect(JSON.parse((await writeEnv(w, "--if-due", "--rotate-every", "2s")).stdout)).toMatchObject({ written: true, member: "k2" });
    writeFileSync(w.log, `${CREDIT}\n`);
    expect(lines(await watch(w, "--sink", w.file, "--server-pid", String(pid), "--once"))).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect(await states(w)).toEqual(["exhausted", "active", "active"]);
    expect(w.fake.seen.map(row => row.key)).toEqual([KEYS[0]]);
  });
  it("without the server's pid, nothing can be proved: no one is blamed and nothing is sent", async () => {
    const w = await world();
    expect((await writeEnv(w)).code).toBe(0);
    writeFileSync(w.log, `${CREDIT}\n`);
    await sleep(1700);
    const out = await watch(w, "--sink", w.file, "--once");
    expect([out.code, out.stdout]).toEqual([0, ""]);
    expect(w.fake.seen).toEqual([]);
  });
  it("a pid that is not a process, or a server that started before the first write on record, blames no one", async () => {
    const w = await world();
    const early = await server();
    await sleep(1700);
    expect((await writeEnv(w)).code).toBe(0);
    writeFileSync(w.log, `${CREDIT}\n`);
    for (const pid of [String(early), "2147483646"]) {
      const out = await watch(w, "--sink", w.file, "--server-pid", pid, "--once");
      expect([out.code, out.stdout], pid).toEqual([0, ""]);
    }
    expect(w.fake.seen).toEqual([]);
  });
  it("a pid file is read at each phrase: a server that restarted is followed to its new key", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    w.fake.answers[KEYS[1]] = dryKey;
    expect((await writeEnv(w)).code).toBe(0);
    await sleep(1700);
    const first = await server();
    const pidFile = join(w.sinks, "server.pid");
    writeFileSync(pidFile, `${first}\n`);
    writeFileSync(w.log, "");
    follow(w, "--sink", w.file, "--server-pid-file", pidFile);
    await sleep(2500);
    appendFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be found dry");
    expect(JSON.parse((await writeEnv(w, "--if-due")).stdout)).toMatchObject({ written: true, member: "k2" });
    await sleep(1700);
    writeFileSync(pidFile, `${await server()}\n`);
    appendFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[1] === "exhausted", "k2 to be found dry after the server restarted");
  });
  it("a pair that is not consistent (the file was replaced after write-env wrote the stamp) blames no one", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    expect((await writeEnv(w)).code).toBe(0);
    writeFileSync(`${w.file}.swap`, "ANTHROPIC_API_KEY=somebody-elses\n", { mode: 0o600 });
    renameSync(`${w.file}.swap`, w.file);
    await sleep(1700);
    const pid = await server();
    writeFileSync(w.log, `${CREDIT}\n`);
    const out = await watch(w, "--sink", w.file, "--server-pid", String(pid), "--once");
    expect([out.code, out.stdout]).toEqual([0, ""]);
    expect(w.fake.seen).toEqual([]);
  });
  it("with no sidecar, or a sidecar that is no stamp, nothing is blamed and nothing is sent", async () => {
    const w = await world();
    const pid = await server();
    writeFileSync(w.log, `${CREDIT}\n`);
    expect((await watch(w, "--sink", w.file, "--server-pid", String(pid), "--once")).stdout).toBe("");
    writeFileSync(w.file, "ANTHROPIC_API_KEY=x\n");
    writeFileSync(`${w.file}.member`, "k9\n");
    const out = await watch(w, "--sink", w.file, "--server-pid", String(pid), "--once");
    expect([out.code, out.stdout]).toEqual([0, ""]);
    expect(w.fake.seen).toEqual([]);
  });
});

describe("following the log", () => {
  it("starts at the end: what the log already holds is not acted on; a line appended later is", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    writeFileSync(w.log, `${CREDIT}\n`);
    const run = follow(w, "--member", "k1");
    await sleep(2500);
    expect(await states(w)).toEqual(["active", "active", "active"]);
    expect(w.fake.seen).toEqual([]);
    appendFileSync(w.log, `${CREDIT} ${PLANTED}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be found dry");
    expect(run.out().trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect(run.out() + run.err()).not.toContain(PLANTED);
  });
  it("a log that is truncated is followed from its start", async () => {
    const w = await world();
    w.fake.answers[KEYS[1]] = dryKey;
    writeFileSync(w.log, `${"ordinary line of the server\n".repeat(20)}`);
    follow(w, "--member", "k2");
    await sleep(2500);
    writeFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[1] === "exhausted", "k2 to be found dry after the truncation");
  });
  it("a log that is replaced (rotated) is followed from the start of the new file", async () => {
    const w = await world();
    w.fake.answers[KEYS[2]] = dryKey;
    writeFileSync(w.log, `${"ordinary line of the server\n".repeat(5)}`);
    follow(w, "--member", "k3");
    await sleep(2500);
    // The phrase is at the very start of the new file, before where the old file ended: only a reader that starts the new file over finds it.
    writeFileSync(`${w.log}.new`, `${CREDIT}\n${"ordinary line of the server\n".repeat(50)}`);
    renameSync(`${w.log}.new`, w.log);
    await until(async () => (await states(w))[2] === "exhausted", "k3 to be found dry after the rotation");
  });
  it("a log that is not there yet is waited for and read from its start", async () => {
    const w = await world();
    w.fake.answers[KEYS[0]] = dryKey;
    const run = follow(w, "--member", "k1");
    await sleep(2000);
    expect(run.err()).toBe("");
    writeFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be found dry once the log appeared");
  });
});
