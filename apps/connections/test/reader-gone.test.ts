// `morndo-keys run` when the reader of its output is gone (T-274): the turn must stop, not run on to its end with nobody
// reading and spending the key's budget. The real bin as a child, run into `head -c 20` (a real pipe), against a fake
// runtime that streams for 15 s. Nothing here times the stop closely: the bin must be back well inside the turn (9 s of 15),
// and by then the agent is gone and never finished. The lease is still closed with what the turn used, so the books are right.
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
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
  expect(keys(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], KEY).status).toBe(0);
  expect(keys(["ack", "credit", "--by", "owner"]).status).toBe(0);
  const runIntoHeadWith = (extra: string[]) => runIntoHead([MAIN, "run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--dir", dir, ...extra], env);
  return { dir, keys, runIntoHead: runIntoHeadWith };
}

describe("morndo-keys run with its reader gone", () => {
  it("stops the turn and closes the lease, instead of running on to the end", async () => {
    const { dir, keys, runIntoHead: go } = ready(fixture);
    const started = Date.now();
    const ran = await go([]);
    const took = Date.now() - started;

    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });     // the killed child's status is 1
    expect(took).toBeLessThan(9_000);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(alive(pid)).toBe(false);
    expect(existsSync(join(dir, "finished"))).toBe(false);
    expect(keys(["log", "credit"]).stdout).toContain("LeaseClosed");
  }, 40_000);

  it("stops the whole process group: an inner process that ignores SIGTERM behind a launcher does not finish the turn", async () => {
    const { dir, keys, runIntoHead: go } = ready(wrapper);
    const started = Date.now();
    const ran = await go([]);
    const took = Date.now() - started;

    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });
    expect(took).toBeLessThan(9_000);                                                    // SIGTERM, then SIGKILL after 3 s; the turn is 15 s
    expect(alive(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(false);
    expect(alive(Number(readFileSync(join(dir, "wrapper-pid"), "utf8")))).toBe(false);
    expect(existsSync(join(dir, "finished"))).toBe(false);
    expect(keys(["log", "credit"]).stdout).toContain("LeaseClosed");
  }, 40_000);

  it("forwards SIGTERM sent to the bin to the agent's group, and ends with 143", async () => {
    const { dir, keys } = ready(wrapper);
    const env: NodeJS.ProcessEnv = { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, MORNDO_CLAUDE_BIN: wrapper, PWD: join(dir, "work"), ANTHROPIC_API_KEY: KEY };
    const bin = spawn(process.execPath, ["--no-warnings", MAIN, "run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--dir", dir], { env, stdio: ["ignore", "pipe", "pipe"] });
    bin.stdout.resume();
    bin.stderr.resume();
    const closed = new Promise<number | null>(resolve => bin.once("close", resolve));
    for (let i = 0; i < 100 && !existsSync(join(dir, "pid")); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now();
    bin.kill("SIGTERM");
    expect(await closed).toBe(143);
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(alive(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(false);
    expect(existsSync(join(dir, "finished"))).toBe(false);
    expect(keys(["log", "credit"]).stdout).toContain("LeaseClosed");
  }, 40_000);
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
