// morndo-keys usage (ADR-0028 decision 5): a Codex subscription's windows as one line of status-line JSON, nothing on
// stdout otherwise, and no key variable in the CLI's environment. A fake app server stands in for the CLI.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const FIXTURES = join(import.meta.dirname, "fixtures");
const MAIN = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function home(): NodeJS.ProcessEnv {
  const dir = scratch("morndo-usage-cli-");
  return { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir };
}

function fakeCodex(mode = "ok"): { bin: string; dir: string } {
  const dir = scratch("morndo-usage-codex-");
  const bin = join(dir, "codex.mjs");
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), bin);
  copyFileSync(join(FIXTURES, "codex", "rate-limits-plus.json"), join(dir, "limits.json"));
  writeFileSync(join(dir, "mode"), mode);
  return { bin, dir };
}

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin: "", stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("morndo-keys usage", () => {
  it("prints a Codex subscription's windows, with no key in the CLI's environment", async () => {
    const env = home();
    const login = scratch("morndo-usage-login-");
    expect((await cli(["add", "codex-a", "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", login], env)).code).toBe(0);
    const codex = fakeCodex();
    const out = await cli(["usage", "--connection", "codex-a"], {
      ...env, MORNDO_CODEX_BIN: codex.bin,
      CODEX_API_KEY: "sk-synthetic-usage-0001", CODEX_ACCESS_TOKEN: "synthetic-access-0002", OPENAI_API_KEY: "sk-synthetic-usage-0003",
    });
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      session_id: "codex-a-limits",
      model: { display_name: "Codex (plus)" },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_893_456_000 }, seven_day: { used_percentage: 17, resets_at: 1_893_888_000 } },
    });
    const seen = JSON.parse(readFileSync(join(codex.dir, "seen.json"), "utf8")) as { names: string[]; codexHome: string };
    expect(seen.names.filter(name => /KEY|TOKEN/.test(name))).toEqual([]);
    expect(seen.codexHome).toBe(login);
  });

  it("refuses another kind of connection and a missing one, printing nothing on stdout", async () => {
    const env = home();
    expect((await cli(["add", "sub-c", "--vendor", "claude", "--runtime", "claude", "--subscription", "true"], env)).code).toBe(0);
    const other = await cli(["usage", "--connection", "sub-c"], env);
    expect([other.code, other.stdout, other.stderr]).toEqual([1, "", "usage reads a Codex subscription only\n"]);
    const missing = await cli(["usage", "--connection", "nope"], env);
    expect([missing.code, missing.stdout, missing.stderr]).toEqual([1, "", "missing\n"]);
  });

  it("prints nothing on stdout and says why when the read fails", async () => {
    const env = home();
    expect((await cli(["add", "codex-a", "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", scratch("morndo-usage-login-")], env)).code).toBe(0);
    const out = await cli(["usage", "--connection", "codex-a"], { ...env, MORNDO_CODEX_BIN: fakeCodex("error").bin });
    expect([out.code, out.stdout, out.stderr]).toEqual([1, "", "codex app-server: not signed in with ChatGPT\n"]);
  });

  it("takes the connection as a positional argument too, as check and spend do", async () => {
    const env = home();
    expect((await cli(["add", "codex-a", "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", scratch("morndo-usage-login-")], env)).code).toBe(0);
    const out = await cli(["usage", "codex-a"], { ...env, MORNDO_CODEX_BIN: fakeCodex().bin });
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ session_id: "codex-a-limits" });
  });

  it("reads stdin by the command word only: a key added under the name 'usage' is still read", async () => {
    const env = home();
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "add", "usage", "--vendor", "openai", "--runtime", "codex", "--billing", "metered", "--budget", "unlimited"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.stdin.end("sk-synthetic-usage-0009\n");
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    expect([code, stderr]).toEqual([0, ""]);
  }, 20_000);

  it("doesn't wait for input that never comes", async () => {
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "usage", "--connection", "nope"], { env: home(), stdio: ["pipe", "pipe", "pipe"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    clearTimeout(killer);
    expect(code).toBe(1);
    expect(stderr).toContain("missing");
  }, 20_000);
});
