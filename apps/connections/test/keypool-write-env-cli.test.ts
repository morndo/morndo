// `keypool write-env` through the real bin (ADR-0037, slice 4; plan 3.6): one gated lease per write, the picked member's key written to a registered sink
// as NAME=value (0600, by rename), a sidecar naming the member and stamping the file it is about, one writer at a time (<sink>.lock), words only on stdout and stderr. `--if-due` rewrites only when the served member can no longer
// serve (or the file is gone, or `--rotate-every` has passed). Every key is synthetic; the planted values must reach nothing but the file.
import { spawn } from "node:child_process";
import { acquireEnvLock } from "../src/adapters/env-file.ts";
import { chmodSync, readlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 180_000 });
// The pid namespace the tests run in, as a lock records it (a lock of another namespace is never taken over).
const NS = /\[(\d+)\]/.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? "0";
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
// The writer is a timer or a pre-start, no agent: its isolation is its own claim, as for `lease` (the vendor's floor is rules).
const acquireNow = (w: World) => acquireEnvLock(w.file, { waitMs: 0 });
const write = (w: World, ...more: string[]) => cli(["keypool", "write-env", "p", "--file", w.file, "--var", "ANTHROPIC_API_KEY", "--isolation", "rules", ...more], w.env);
const content = (path: string): string => readFileSync(path, "utf8");
// The sidecar: the member's name, then the stamp of the file it is about (inode and mtime).
const memberOf = (file: string): string => content(`${file}.member`).split("\n")[0] ?? "";
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
const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

describe("a write", () => {
  it("writes the first member's key as NAME=value, 0600, with the sidecar, and prints words only", async () => {
    const w = await world();
    const out = await write(w);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(line(out)).toEqual({ pool: "p", written: true, member: "k1" });
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[0]}\n`);
    expect(statSync(w.file).mode & 0o777).toBe(0o600);
    expect(memberOf(w.file)).toBe("k1");
    expect(content(`${w.file}.member`)).toMatch(/^k1\n\d+:\d+\n\d+ k1\n$/);
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
    expect(readdirSync(blocked.sinks)).toEqual(["app.env.lock"]);
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
    const a = await cli(["keypool", "write-env", "p", "--file", inRepo, "--var", "ANTHROPIC_API_KEY", "--isolation", "rules"], w.env);
    expect([a.code, a.stderr.trim()]).toEqual([1, "in_repository"]);
    const open = join(w.sinks, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const loose = join(open, ".env");
    expect((await cli(["keypool", "sink", "add", "p", loose], w.env)).code).toBe(0);
    const b = await cli(["keypool", "write-env", "p", "--file", loose, "--var", "ANTHROPIC_API_KEY", "--isolation", "rules"], w.env);
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
    expect(memberOf(w.file)).toBe("k2");
  });
  it("rewrites when the file or the sidecar is missing, or the file is not the one the stamp is about (replaced after the stamp, or a write cut short)", async () => {
    const w = await world();
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    rmSync(`${w.file}.member`);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    writeFileSync(`${w.file}.swap`, "ANTHROPIC_API_KEY=somebody-elses\n", { mode: 0o600 });
    renameSync(`${w.file}.swap`, w.file);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: false, why: "not_due" });
    rmSync(w.file);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true });
  });
  it("rewrites when the served member has left the pool", async () => {
    const w = await world();
    await write(w);
    expect((await cli(["keypool", "remove", "p", "k1"], w.env)).code).toBe(0);
    expect(line(await write(w, "--if-due"))).toMatchObject({ written: true, member: "k2" });
  });
  it("--rotate-every rewrites after that long and not before (seconds, minutes, hours or days), in round-robin only", async () => {
    const w = await world();
    await write(w);
    const young = await write(w, "--if-due", "--rotate-every", "1d");
    expect(line(young)).toEqual({ pool: "p", written: false, why: "not_due" });
    await sleep(2300);
    expect(line(await write(w, "--if-due", "--rotate-every", "2s"))).toMatchObject({ written: true, member: "k2" });
    const drain = await world("drain");
    await write(drain);
    const out = await write(drain, "--if-due", "--rotate-every", "12h");
    expect([out.code, out.stderr.trim()]).toEqual([1, "usage"]);
    expect((await write(w, "--if-due", "--rotate-every", "soon")).stderr.trim()).toBe("usage");
  });
});

describe("one writer at a time, and a pair that agrees", () => {
  it("two writes at once both finish, one after the other: the file holds the key of the member its sidecar names, and the stamp matches", async () => {
    const w = await world();
    const [a, b] = await Promise.all([write(w), write(w)]);
    expect([a.code, b.code], `${a.stderr}${b.stderr}`).toEqual([0, 0]);
    const members = [a, b].map(out => (line(out) as { member: string }).member);
    expect(new Set(members).size).toBe(2);
    const member = memberOf(w.file);
    expect(content(w.file)).toBe(`ANTHROPIC_API_KEY=${KEYS[Number(member.slice(1)) - 1]}\n`);
    expect(content(`${w.file}.member`).split("\n")[1]).toBe(`${statSync(w.file).ino}:${Math.trunc(statSync(w.file).mtimeMs)}`);
    expect(readdirSync(w.sinks).sort()).toEqual(["app.env", "app.env.lock", "app.env.member"]);
  });
  it("a lock held by a live process makes a write wait and then say busy, naming the holder and how to look at it; nothing is written, no lease is taken, and the lock is not forced", async () => {
    const w = await world();
    const helper = join(import.meta.dirname, "fixtures/lock-hold.mjs");
    const holder = spawn(process.execPath, ["--experimental-strip-types", helper, w.file]);
    try {
      const first = await new Promise<string>(resolve => { let out = ""; holder.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.trim()); }); });
      expect(first).toBe("ok");
      const started = Date.now();
      const out = await write(w);
      expect([out.code, out.stdout]).toEqual([1, ""]);
      const lines = out.stderr.trim().split("\n");
      expect(lines[0]).toBe("busy");
      expect(out.stderr).toContain(`pid ${holder.pid}`);
      expect(out.stderr).toContain(`ps -o pid,lstart,args -p ${holder.pid}`);
      expect(out.stderr).not.toContain(w.file);
      expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
      expect(readdirSync(w.sinks).filter(name => name === "app.env" || name === "app.env.member")).toEqual([]);
      for (const name of ["k1", "k2", "k3"]) expect((await events(w, name)).filter(e => e.type === "LeaseGranted")).toEqual([]);
      expect((await acquireNow(w)).ok).toBe(false);
    } finally { holder.kill("SIGKILL"); }
  });
  it("a holder that was killed while holding frees the lock at once: the next write needs no waiting and no clean-up", async () => {
    const w = await world();
    const helper = join(import.meta.dirname, "fixtures/lock-hold.mjs");
    const holder = spawn(process.execPath, ["--experimental-strip-types", helper, w.file]);
    await new Promise<string>(resolve => { let out = ""; holder.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.trim()); }); });
    holder.kill("SIGKILL");
    await new Promise<void>(resolve => { holder.on("close", () => { resolve(); }); });
    const started = Date.now();
    const out = await write(w);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(Date.now() - started).toBeLessThan(4000);
  });
  it("a lock file of the earlier text form is busy and is never deleted: it is not a lock this code can take", async () => {
    const w = await world();
    writeFileSync(`${w.file}.lock`, `2147483646 1 ${NS}\n`);
    const out = await write(w);
    expect([out.code, out.stdout, out.stderr.trim().split("\n")[0]]).toEqual([1, "", "busy"]);
    expect(readFileSync(`${w.file}.lock`, "utf8")).toBe(`2147483646 1 ${NS}\n`);
    expect(readdirSync(w.sinks).filter(name => name === "app.env" || name === "app.env.member")).toEqual([]);
  });
  it("a temp file left by a killed write is replaced, not kept", async () => {
    const w = await world();
    writeFileSync(`${w.file}.tmp`, `ANTHROPIC_API_KEY=${KEYS[2]}\n`, { mode: 0o600 });
    expect((await write(w)).code).toBe(0);
    expect(readdirSync(w.sinks).sort()).toEqual(["app.env", "app.env.lock", "app.env.member"]);
  });
  it("a run that began before the sink was registered has the file open to its tools: write-env refuses while it lives, and writes once it is gone", async () => {
    const w = await world("round-robin", false);
    const added = await cli(["add", "k5", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], w.env, "sk-ant-synthetic-env-key-0005");
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", "k5", "--by", "owner"], w.env)).code).toBe(0);
    const marks = mkdtempSync(join(tmpdir(), "morndo-envrun-"));
    dirs.push(marks);
    const slow = join(import.meta.dirname, "fixtures/slow-runtime.mjs");
    const running = spawn(process.execPath, ["--experimental-strip-types", main, "run", "--connection", "k5", "--workspace", join(w.dir, "work"), "--reserve", "1", "--", "--dir", marks], { env: { ...w.env, MORNDO_CLAUDE_BIN: slow } });
    try {
      for (let i = 0; i < 100 && !readdirSync(marks).includes("pid"); i++) await sleep(100);
      expect(readdirSync(marks)).toContain("pid");
      await sleep(1100);
      expect((await cli(["keypool", "sink", "add", "p", w.file], w.env)).code).toBe(0);
      const refused = await write(w);
      expect([refused.code, refused.stdout, refused.stderr.trim()]).toEqual([1, "", "older_runs"]);
      expect(readdirSync(w.sinks)).toEqual([]);
    } finally {
      running.kill("SIGKILL");
      try { process.kill(Number(readFileSync(join(marks, "pid"), "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
    const written = await write(w);
    expect([written.code, written.stderr]).toEqual([0, ""]);
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
    expect(readdirSync(w.sinks).sort()).toEqual(["app.env", "app.env.lock", "app.env.member"]);
    expect(memberOf(w.file)).toMatch(/^k\d$/);
  });
  it("a write that fails after the lease (the path is a directory by now) closes the lease failed and leaves no temp file", async () => {
    const w = await world();
    mkdirSync(w.file);
    const out = await write(w);
    expect([out.code, out.stdout, out.stderr.trim()]).toEqual([1, "", "write_failed"]);
    expect(readdirSync(w.sinks)).toEqual(["app.env", "app.env.lock"]);
    const k1 = (await events(w, "k1")).filter(e => e.type === "LeaseClosed");
    expect(k1.map(e => e.outcome)).toEqual(["failed"]);
  });
});
