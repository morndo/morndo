// `morndo-keys run` when the reader of its output is gone, or its terminal (T-274): the turn must stop, not run on to its end
// with nobody reading and spending the key's budget. The real bin as a child, run into `head -c 20` (a real pipe), against fake
// runtimes that stream for 15 s. Nothing here times the stop closely: the bin must be back well inside the turn (9 s of 15), and
// by then the agent and what it started are gone and never finished. The lease is still closed with what the turn used, and the
// bin's exit code agrees with the lease's outcome: 0 for done, never 0 for a turn that was cut short.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runIntoHead } from "../../../test/pipe-child.ts";
import { run } from "../src/cli.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const MAIN = join(import.meta.dirname, "../src/main.ts");
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/slow-runtime.mjs");
const wrapper = join(import.meta.dirname, "fixtures/wrapper-runtime.mjs");
const ptyRun = join(import.meta.dirname, "fixtures/pty-run.py");
const hasPty = spawnSync("python3", ["-c", "import pty"]).status === 0;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Waits for the child to have done something, not for a count of polls: a bin started under load can take seconds to get
// going, and a signal sent to one that has not installed its handlers yet kills it by the default action (code null,
// no lease). A wait that never ends in what it waits for fails by name instead of signalling blind.
const until = async (what: string, done: () => boolean, ms = 30_000) => {
  for (const end = Date.now() + ms; !done();) {
    if (Date.now() > end) throw new Error(`${what} did not happen within ${ms} ms`);
    await pause(5);
  }
};
const pidIn = (dir: string, file: string): number => Number(readFileSync(join(dir, file), "utf8"));

// A connection ready to run: a scratch home, a made-up key, the terms acknowledged, and `bin` as the claude runtime.
function ready(bin: string) {
  const dir = mkdtempSync(join(tmpdir(), "morndo-reader-gone-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, MORNDO_CLAUDE_BIN: bin,
    PWD: join(dir, "work"), ANTHROPIC_API_KEY: KEY,
  };
  const keys = (args: string[], input = "") => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { env, input, encoding: "utf8", timeout: 30_000 });
  expect(keys(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "100"], KEY).status).toBe(0);
  expect(keys(["ack", "credit", "--by", "owner"]).status).toBe(0);
  const args = (extra: string[]) => [MAIN, "run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--dir", dir, ...extra];
  const outcomes = (): string[] => keys(["log", "credit"]).stdout.split("\n").filter(l => l.includes('"LeaseClosed"')).map(l => (JSON.parse(l) as { outcome: string }).outcome);
  return { dir, env, keys, args, outcomes, intoHead: (extra: string[]) => runIntoHead(args(extra), env) };
}

// The bin itself as a child, output drained, for a test that sends it a signal.
function start(t: ReturnType<typeof ready>, extra: string[] = []) {
  const bin = spawn(process.execPath, ["--no-warnings", ...t.args(extra)], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
  bin.stdout.resume();
  let stderr = "";
  bin.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(resolve => bin.once("close", (code, signal) => resolve({ code, signal, stderr })));
  return { bin, closed };
}

describe("morndo-keys run with its reader gone", () => {
  it("stops the turn and closes the lease, instead of running on to the end", async () => {
    const t = ready(fixture);
    const started = Date.now();
    const ran = await t.intoHead([]);
    const took = Date.now() - started;

    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });     // the killed child's status is 1
    expect(took).toBeLessThan(9_000);
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);
    expect(existsSync(join(t.dir, "finished"))).toBe(false);
    expect(t.outcomes()).toEqual(["failed"]);
  }, 40_000);

  it("stops a launcher's inner process too, though it ignores SIGTERM", async () => {
    const t = ready(wrapper);
    const started = Date.now();
    const ran = await t.intoHead([]);
    const took = Date.now() - started;

    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });
    expect(took).toBeLessThan(9_000);                                                    // SIGTERM, then SIGKILL after 3 s; the turn is 15 s
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);
    expect(alive(pidIn(t.dir, "wrapper-pid"))).toBe(false);
    expect(existsSync(join(t.dir, "finished"))).toBe(false);
    expect(t.outcomes()).toEqual(["failed"]);
  }, 40_000);

  it("kills an inner process that outlives the launcher and the output pipes, once the grace has passed", async () => {
    const t = ready(wrapper);
    const started = Date.now();
    const ran = await t.intoHead(["--detach-inner"]);
    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);                                      // it ignores SIGTERM and holds no pipe
    expect(existsSync(join(t.dir, "finished"))).toBe(false);
  }, 40_000);
});

describe("morndo-keys run when its terminal goes away", () => {
  it("stops the agent and closes the lease on SIGHUP, and ends with 129", async () => {
    const t = ready(fixture);
    const { bin, closed } = start(t);
    await until("the agent starting", () => existsSync(join(t.dir, "pid")));
    const started = Date.now();
    bin.kill("SIGHUP");
    expect(await closed).toMatchObject({ code: 129, signal: null });
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);
    expect(existsSync(join(t.dir, "finished"))).toBe(false);
    expect(t.outcomes()).toEqual(["failed"]);
  }, 40_000);

  it("never ends 129 for a lease that was closed as done, nor 0 for one closed as failed (a SIGHUP as the agent finishes)", async () => {
    const t = ready(fixture);
    for (let round = 0; round < 6; round++) {
      rmSync(join(t.dir, "finished"), { force: true });
      const { bin, closed } = start(t, ["--fast"]);
      await until(`round ${round}: the agent finishing`, () => existsSync(join(t.dir, "finished")));   // its handlers are in, its turn is over
      try { bin.kill("SIGHUP"); } catch { /* it is already gone */ }
      const end = await closed;
      const outcome = t.outcomes().at(-1);
      // A bin that is done and then hit by the signal dies of it (code null), after its lease was closed as done.
      if (end.code === 0 || end.code === null) expect(outcome, `round ${round}: ${JSON.stringify(end)}`).toBe("done");
      else expect({ code: end.code, signal: end.signal, outcome }, `round ${round}: ${end.stderr}`).toEqual({ code: 129, signal: null, outcome: "failed" });
    }
  }, 60_000);
});

describe("morndo-keys run in a terminal that closes", () => {
  it.skipIf(!hasPty)("ends 129 without an error stack, with the agent gone and the lease closed (writes to the dead terminal fail with EIO)", async () => {
    const t = ready(fixture);
    const ran = spawnSync("python3", [ptyRun, process.execPath, "--no-warnings", ...t.args([])], { env: t.env, encoding: "utf8", timeout: 40_000 });
    expect({ out: ran.stdout.trim(), err: ran.stderr }).toEqual({ out: "129", err: "" });
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);
    expect(existsSync(join(t.dir, "finished"))).toBe(false);
    expect(t.outcomes()).toEqual(["failed"]);
  }, 60_000);

  it.skipIf(process.platform !== "linux")("is stopped by SIGHUP even when started with it ignored: Node resets an inherited ignore at startup, so nohup cannot exempt it", async () => {
    const t = ready(fixture);
    const bin = spawn("sh", ["-c", 'trap "" HUP; exec "$0" "$@"', process.execPath, "--no-warnings", ...t.args([])], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
    bin.stdout.resume();
    bin.stderr.resume();
    const closed = new Promise<number | null>(resolve => bin.once("close", resolve));
    await until("the agent starting", () => existsSync(join(t.dir, "pid")));
    bin.kill("SIGHUP");
    expect(await closed).toBe(129);
    expect(alive(pidIn(t.dir, "pid"))).toBe(false);
    expect(t.outcomes()).toEqual(["failed"]);
  }, 30_000);
});

describe("morndo-keys help", () => {
  it("says what a gone reader stops, and the limit for an agent that prints once at the end", async () => {
    let out = "";
    let err = "";
    const code = await run(["help"], {}, { stdout: t => { out += t; }, stderr: t => { err += t; } });
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("run --connection");
    expect(out).toMatch(/reader .*gone.*stopped/s);
    expect(out).toMatch(/noticed only when .* writes/s);
    expect(out).toContain("--output-format json");
  });
});
