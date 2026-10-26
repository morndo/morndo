// `keypool watch` through the real bin (ADR-0037, slice 4; plan 3.6): for a server that cannot report a dry key itself, the command reads its log, matches the
// two exhausted phrases of the classifier and reports the member; it never echoes the line it matched. `--once` reads what the log holds now and exits; without
// it the command follows the log from its end, from the start of a file that is new, truncated or replaced. Every key is synthetic.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });
const KEYS: [string, string, string] = ["sk-ant-synthetic-log-key-0001", "sk-ant-synthetic-log-key-0002", "sk-ant-synthetic-log-key-0003"];
const PLANTED = "planted-secret-in-the-log-line";
const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const SPEND = "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Out = { code: number; stdout: string; stderr: string };
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
type World = { dir: string; env: NodeJS.ProcessEnv; sinks: string; log: string; file: string };
async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-watch-"));
  const sinks = mkdtempSync(join(tmpdir(), "morndo-watchfiles-"));
  dirs.push(dir, sinks);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "home"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath, PWD: join(dir, "work"),
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
  return { dir, env, sinks, log: join(sinks, "server.log"), file };
}
type View = { members: { credential: string; state: string; reason: string | null }[] };
const view = async (w: World): Promise<View> => JSON.parse((await cli(["keypool", "list"], w.env)).stdout.trim().split("\n")[0] ?? "{}") as View;
const states = async (w: World): Promise<string[]> => (await view(w)).members.map(m => m.state);
const watch = (w: World, ...more: string[]) => cli(["keypool", "watch", "p", "--log", w.log, ...more], w.env);
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

describe("--once", () => {
  it("a credit line marks the member exhausted and prints one line of words; the matched line is never echoed", async () => {
    const w = await world();
    writeFileSync(w.log, `start\n${CREDIT} ${PLANTED} ${KEYS[1]}\nend\n`);
    const out = await watch(w, "--member", "k2", "--once");
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(lines(out)).toEqual([{ pool: "p", member: "k2", outcome: "exhausted" }]);
    expect(await states(w)).toEqual(["active", "exhausted", "active"]);
    for (const text of [out.stdout, out.stderr, (await cli(["keypool", "list"], w.env)).stdout, (await cli(["log"], w.env)).stdout]) {
      expect(text).not.toContain(PLANTED);
      for (const key of KEYS) expect(text).not.toContain(key);
    }
    for (const path of homeFiles(w.dir)) { const body = readFileSync(path).toString("latin1"); expect(body, path).not.toContain(PLANTED); for (const key of KEYS) expect(body, path).not.toContain(key); }
  });
  it("a spend-limit line marks it exhausted for the spend limit", async () => {
    const w = await world();
    writeFileSync(w.log, `${SPEND}\n`);
    expect(lines(await watch(w, "--member", "k1", "--once"))).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect((await view(w)).members[0]).toMatchObject({ state: "exhausted", reason: "spend-limit" });
  });
  it("lines that are not those two phrases change nothing and print nothing: a rate limit, a hold, a refused key, ordinary traffic", async () => {
    const w = await world();
    writeFileSync(w.log, ["GET / 200", "429 rate_limit_error: per-minute rate limit", "403 account_on_hold", "401 authentication_error invalid x-api-key", "authentication_failed"].join("\n") + "\n");
    const out = await watch(w, "--member", "k1", "--once");
    expect([out.code, out.stdout, out.stderr]).toEqual([0, "", ""]);
    expect(await states(w)).toEqual(["active", "active", "active"]);
  });
  it("three matches in a row report once (a member is reported at most once in ten seconds)", async () => {
    const w = await world();
    writeFileSync(w.log, `${CREDIT}\n${CREDIT}\n${SPEND}\n`);
    expect(lines(await watch(w, "--member", "k1", "--once"))).toHaveLength(1);
  });
  it("--sink reads the member from the sidecar at the match", async () => {
    const w = await world();
    writeFileSync(`${w.file}.member`, "k3\n");
    writeFileSync(w.log, `${CREDIT}\n`);
    expect(lines(await watch(w, "--sink", w.file, "--once"))).toEqual([{ pool: "p", member: "k3", outcome: "exhausted" }]);
    expect(await states(w)).toEqual(["active", "active", "exhausted"]);
  });
  it("--sink with no sidecar, or one naming a member that is not in the pool, reports nothing", async () => {
    const w = await world();
    writeFileSync(w.log, `${CREDIT}\n`);
    expect((await watch(w, "--sink", w.file, "--once")).stdout).toBe("");
    writeFileSync(`${w.file}.member`, "k9\n");
    const out = await watch(w, "--sink", w.file, "--once");
    expect([out.code, out.stdout]).toEqual([0, ""]);
    expect(await states(w)).toEqual(["active", "active", "active"]);
  });
  it("usage and missing: one of --member or --sink, --log needed, a pool and a member that exist, a file that is a sink", async () => {
    const w = await world();
    writeFileSync(w.log, "x\n");
    const word = async (args: string[]) => (await cli(args, w.env)).stderr.trim();
    expect(await word(["keypool", "watch", "p", "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--member", "k1", "--sink", w.file, "--once"])).toBe("usage");
    expect(await word(["keypool", "watch", "nope", "--log", w.log, "--member", "k1", "--once"])).toBe("missing");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--member", "k9", "--once"])).toBe("missing");
    expect(await word(["keypool", "watch", "p", "--log", w.log, "--sink", join(w.sinks, "other.env"), "--once"])).toBe("not_a_sink");
  });
  it("a log that is not there is an error with --once", async () => {
    const w = await world();
    const out = await watch(w, "--member", "k1", "--once");
    expect([out.code, out.stderr.trim()]).toEqual([1, "no_log"]);
  });
});

describe("following the log", () => {
  it("starts at the end: what the log already holds is not reported; a line appended later is", async () => {
    const w = await world();
    writeFileSync(w.log, `${CREDIT}\n`);
    const run = follow(w, "--member", "k1");
    await sleep(2500);
    expect(await states(w)).toEqual(["active", "active", "active"]);
    appendFileSync(w.log, `${CREDIT} ${PLANTED}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be reported dry");
    expect(run.out().trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([{ pool: "p", member: "k1", outcome: "exhausted" }]);
    expect(run.out() + run.err()).not.toContain(PLANTED);
  });
  it("a log that is truncated is followed from its start", async () => {
    const w = await world();
    writeFileSync(w.log, `${"ordinary line of the server\n".repeat(20)}`);
    follow(w, "--member", "k2");
    await sleep(2500);
    writeFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[1] === "exhausted", "k2 to be reported dry after the truncation");
  });
  it("a log that is replaced (rotated) is followed from the start of the new file", async () => {
    const w = await world();
    writeFileSync(w.log, `${"ordinary line of the server\n".repeat(5)}`);
    follow(w, "--member", "k3");
    await sleep(2500);
    writeFileSync(`${w.log}.new`, `${"ordinary line of the server\n".repeat(50)}${CREDIT}\n`);
    renameSync(`${w.log}.new`, w.log);
    await until(async () => (await states(w))[2] === "exhausted", "k3 to be reported dry after the rotation");
  });
  it("a log that is not there yet is waited for and read from its start", async () => {
    const w = await world();
    const run = follow(w, "--member", "k1");
    await sleep(2000);
    expect(run.err()).toBe("");
    writeFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be reported dry once the log appeared");
  });
  it("--sink follows a rotated key: the member is read from the sidecar at each match", async () => {
    const w = await world();
    writeFileSync(`${w.file}.member`, "k1\n");
    writeFileSync(w.log, "");
    follow(w, "--sink", w.file);
    await sleep(2500);
    appendFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[0] === "exhausted", "k1 to be reported dry");
    writeFileSync(`${w.file}.member`, "k2\n");
    await sleep(11_000);
    appendFileSync(w.log, `${CREDIT}\n`);
    await until(async () => (await states(w))[1] === "exhausted", "k2 to be reported dry after the file moved to it");
  });
});
