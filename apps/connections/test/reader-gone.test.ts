// `morndo-keys run` when the reader of its output is gone (T-274): the turn must stop, not run on to its end with nobody
// reading and spending the key's budget. The real bin as a child, run into `head -c 20` (a real pipe), against a fake
// runtime that streams for 5 s. The lease is still closed with what the turn used, so the books are right.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runIntoHead } from "../../../test/pipe-child.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const MAIN = join(import.meta.dirname, "../src/main.ts");
const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/slow-runtime.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("morndo-keys run with its reader gone", () => {
  it("stops the turn and closes the lease, instead of running on to the end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-reader-gone-"));
    dirs.push(dir);
    mkdirSync(join(dir, "work"));
    const env: NodeJS.ProcessEnv = {
      ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, MORNDO_CLAUDE_BIN: fixture,
      PWD: join(dir, "work"), ANTHROPIC_API_KEY: KEY,
    };
    const keys = (args: string[], input = "") => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], { env, input, encoding: "utf8", timeout: 30_000 });
    expect(keys(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], KEY).status).toBe(0);
    expect(keys(["ack", "credit", "--by", "owner"]).status).toBe(0);

    const started = Date.now();
    await runIntoHead([MAIN, "run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--dir", dir], env);
    const took = Date.now() - started;

    expect(took).toBeLessThan(3_500);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(alive(pid)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect(existsSync(join(dir, "finished"))).toBe(false);
    expect(keys(["log", "credit"]).stdout).toContain("LeaseClosed");
  }, 40_000);
});
