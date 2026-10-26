// `keypool write-env` through the real bin (ADR-0037, slice 4; plan 3.6): one gated lease per write, the picked member's key written to a registered sink
// as NAME=value (0600, by rename), a sidecar naming the member, words only on stdout and stderr. `--if-due` rewrites only when the served member can no longer
// serve (or the file is gone, or `--rotate-every` has passed). Every key is synthetic; the planted values must reach nothing but the file.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
const KEYS: [string, string, string] = ["sk-ant-synthetic-env-key-0001", "sk-ant-synthetic-env-key-0002", "sk-ant-synthetic-env-key-0003"];
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

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
type World = { dir: string; env: NodeJS.ProcessEnv; file: string; sinks: string };
async function world(mode: "round-robin" | "drain" = "round-robin", register = true): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-writeenv-"));
  const sinks = mkdtempSync(join(tmpdir(), "morndo-envsinks-"));
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
  const made = await cli(["keypool", "create", "p", "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", "--mode", mode, "k1", "k2", "k3"], env);
  expect(made.code, made.stderr).toBe(0);
  const file = join(sinks, "app.env");
  if (register) expect((await cli(["keypool", "sink", "add", "p", file], env)).code).toBe(0);
  return { dir, env, file, sinks };
}
const write = (w: World, ...more: string[]) => cli(["keypool", "write-env", "p", "--file", w.file, "--var", "ANTHROPIC_API_KEY", ...more], w.env);
const content = (path: string): string => readFileSync(path, "utf8");
const dry = async (w: World, member: string) => { expect((await cli(["keypool", "report", "p", "--member", member, "--outcome", "exhausted"], w.env)).code).toBe(0); };
type Event = { type: string; name?: string; outcome?: string };
const events = async (w: World, name: string): Promise<Event[]> => (await cli(["log", name], w.env)).stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event);
const line = (out: Out): unknown => JSON.parse(out.stdout.trim());
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
const ago = (path: string, ms: number): void => { const at = new Date(Date.now() - ms); utimesSync(path, at, at); };

describe("a write", () => {
  it("writes the first member's key as NAME=value, 0600, with the sidecar, and prints words only", async () => {
    const w = await world();
    const out = await write(w);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(line(out)).toEqual({ pool: "p", written: true, member: "k1" });
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[0]}\n`);
    expect(statSync(w.file).mode & 0o777).toBe(0o600);
    expect(content(`${w.file}.member`)).toBe("k1\n");
    expect(statSync(`${w.file}.member`).mode & 0o777).toBe(0o600);
    expect(out.stdout).not.toContain(KEYS[0]);
    expect(out.stdout).not.toContain(w.file);
  });
  it("the next write follows the pool's order, as lease --pool does: k2, then k3, then k1", async () => {
    const w = await world();
    const members: unknown[] = [];
    for (let i = 0; i < 4; i++) members.push((line(await write(w)) as { member: string }).member);
    expect(members).toEqual(["k1", "k2", "k3", "k1"]);
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[0]}\n`);
  });
  it("takes one gated lease per write: granted, served and closed done, once each, KeyServed before the close", async () => {
    const w = await world();
    await write(w);
    const k1 = (await events(w, "k1")).filter(e => ["LeaseGranted", "KeyServed", "LeaseClosed"].includes(e.type));
    expect(k1.map(e => e.type)).toEqual(["LeaseGranted", "KeyServed", "LeaseClosed"]);
    expect(k1[2]?.outcome).toBe("done");
  });
  it("an empty pool writes nothing, leaves the old file and exits 75 with pool_empty; a blocked one says pool_blocked", async () => {
    const w = await world();
    await write(w);
    const before = content(w.file);
    for (const m of ["k1", "k2", "k3"]) await dry(w, m);
    const empty = await write(w);
    expect([empty.code, empty.stdout, empty.stderr.trim()]).toEqual([75, "", "pool_empty"]);
    expect(content(w.file)).toBe(before);
    const blocked = await world();
    expect((await cli(["keypool", "report", "p", "--member", "k1", "--outcome", "failing", "--reason", "rejected"], blocked.env)).code).toBe(0);
    const out = await write(blocked);
    expect([out.code, out.stdout, out.stderr.trim()]).toEqual([75, "", "pool_blocked"]);
    expect(readdirSync(blocked.sinks)).toEqual([]);
  });
});

describe("what is refused before a lease is taken", () => {
  it("a path that is not a registered sink of the pool says not_a_sink, writes nothing and takes no lease", async () => {
    const w = await world("round-robin", false);
    const out = await write(w);
    expect([out.code, out.stdout, out.stderr.trim()]).toEqual([1, "", "not_a_sink"]);
    expect(readdirSync(w.sinks)).toEqual([]);
    expect((await events(w, "k1")).filter(e => e.type === "LeaseGranted")).toEqual([]);
  });
  it("usage: --file and --var are needed; --var must be a name; --rotate-every and --if-due go together", async () => {
    const w = await world();
    expect((await cli(["keypool", "write-env", "p", "--var", "A"], w.env)).stderr.trim()).toBe("usage");
    expect((await cli(["keypool", "write-env", "p", "--file", w.file], w.env)).stderr.trim()).toBe("usage");
    expect((await cli(["keypool", "write-env", "p", "--file", w.file, "--var", "lower"], w.env)).stderr.trim()).toBe("bad_name");
    expect((await write(w, "--rotate-every", "12h")).stderr.trim()).toBe("usage");
    expect((await cli(["keypool", "write-env", "nope", "--file", w.file, "--var", "A"], w.env)).stderr.trim()).toBe("missing");
    expect(readdirSync(w.sinks)).toEqual([]);
  });
  it("a registered path in a git work tree is in_repository; in a directory others can write, dir_writable: no file, no lease", async () => {
    const w = await world();
    const repo = join(w.sinks, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inRepo = join(repo, ".env");
    expect((await cli(["keypool", "sink", "add", "p", inRepo], w.env)).code).toBe(0);
    const a = await cli(["keypool", "write-env", "p", "--file", inRepo, "--var", "ANTHROPIC_API_KEY"], w.env);
    expect([a.code, a.stderr.trim()]).toEqual([1, "in_repository"]);
    const open = join(w.sinks, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const loose = join(open, ".env");
    expect((await cli(["keypool", "sink", "add", "p", loose], w.env)).code).toBe(0);
    const b = await cli(["keypool", "write-env", "p", "--file", loose, "--var", "ANTHROPIC_API_KEY"], w.env);
    expect([b.code, b.stderr.trim()]).toEqual([1, "dir_writable"]);
    expect(readdirSync(repo)).toEqual([".git"]);
    expect(readdirSync(open)).toEqual([]);
    for (const name of ["k1", "k2", "k3"]) expect((await events(w, name)).filter(e => e.type === "LeaseGranted")).toEqual([]);
  });
});

describe("--if-due", () => {
  it("does nothing while the served member is still active", async () => {
    const w = await world();
    await write(w);
    const out = await write(w, "--if-due");
    expect([out.code, line(out)]).toEqual([0, { pool: "p", written: false, why: "not_due" }]);
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[0]}\n`);
    expect((await events(w, "k2")).filter(e => e.type === "LeaseGranted")).toEqual([]);
  });
  it("rewrites after the served member is reported exhausted: the next member's key and sidecar", async () => {
    const w = await world();
    await write(w);
    await dry(w, "k1");
    const out = await write(w, "--if-due");
    expect(line(out)).toEqual({ pool: "p", written: true, member: "k2" });
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[1]}\n`);
    expect(content(`${w.file}.member`)).toBe("k2\n");
  });
  it("rewrites when the file or the sidecar is missing, or the sidecar is older than the file (a write that was cut short)", async () => {
    const w = await world();
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    rmSync(`${w.file}.member`);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    ago(`${w.file}.member`, 60_000);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    rmSync(w.file);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
  });
  it("rewrites when the served member has left the pool", async () => {
    const w = await world();
    await write(w);
    expect((await cli(["keypool", "remove", "p", "k1"], w.env)).code).toBe(0);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true, member: "k2" });
  });
  it("--rotate-every rewrites after that long and not before, in round-robin only", async () => {
    const w = await world();
    await write(w);
    const young = await write(w, "--if-due", "--rotate-every", "12h");
    expect(line(young)).toEqual({ pool: "p", written: false, why: "not_due" });
    ago(w.file, 13 * 3_600_000);
    ago(`${w.file}.member`, 13 * 3_600_000);
    expect(line(await write(w, "--if-due", "--rotate-every", "12h"))).toMatchObject({ written: true, member: "k2" });
    const drain = await world("drain");
    await write(drain);
    const out = await write(drain, "--if-due", "--rotate-every", "12h");
    expect([out.code, out.stderr.trim()]).toEqual([1, "usage"]);
  });
});

describe("the value goes to the file and nowhere else", () => {
  it("no other file of the home, no event, list or log, and no output holds it; the sidecar holds the name only", async () => {
    const w = await world();
    const outs = [await write(w), await write(w, "--if-due"), await write(w)];
    await dry(w, "k2");
    outs.push(await write(w, "--if-due"));
    for (const out of outs) for (const key of KEYS) { expect(out.stdout).not.toContain(key); expect(out.stderr).not.toContain(key); }
    const shown = [(await cli(["keypool", "list"], w.env)).stdout, (await cli(["log"], w.env)).stdout, ...await Promise.all(["k1", "k2", "k3"].map(async n => (await cli(["log", n], w.env)).stdout))];
    for (const text of shown) for (const key of KEYS) expect(text).not.toContain(key);
    for (const path of homeFiles(w.dir)) for (const key of KEYS) expect(readFileSync(path).toString("latin1"), path).not.toContain(key);
    expect(readdirSync(w.sinks).sort()).toEqual(["app.env", "app.env.member"]);
    expect(content(`${w.file}.member`)).toMatch(/^k\d\n$/);
  });
  it("a write that fails after the lease (the path is a directory by now) closes the lease failed and leaves no temp file", async () => {
    const w = await world();
    mkdirSync(w.file);
    const out = await write(w);
    expect([out.code, out.stdout, out.stderr.trim()]).toEqual([1, "", "write_failed"]);
    expect(readdirSync(w.sinks)).toEqual(["app.env"]);
    const k1 = (await events(w, "k1")).filter(e => e.type === "LeaseClosed");
    expect(k1.map(e => e.outcome)).toEqual(["failed"]);
  });
});
