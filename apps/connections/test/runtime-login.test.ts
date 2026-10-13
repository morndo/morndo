import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "../src/application/ports.ts";
import { acceptsSubscription, assertSubscription, isStatusRefusal, readAuth, StatusRefused, ClaudeRuntime } from "../src/adapters/runtime-claude.ts";
import { CodexRuntime } from "../src/adapters/runtime-codex.ts";
import { CursorRuntime } from "../src/adapters/runtime-cursor.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fake(): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
  dirs.push(dir);
  const bin = join(dir, "runtime.mjs");
  writeFileSync(bin, `import { readFileSync } from "node:fs";
const dir = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || process.env.CURSOR_CONFIG_DIR;
if (!dir) process.exit(1);
let auth;
try { auth = JSON.parse(readFileSync(dir + "/auth.json", "utf8")); }
catch { process.exit(1); }
if (!auth.signedIn) process.exit(1);
process.stdout.write(JSON.stringify({ authMethod: auth.authMethod }));
`);
  return { bin, dir };
}

function auth(dir: string, signedIn: boolean): void {
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ signedIn, authMethod: "claude.ai" }));
}

describe("subscription login", () => {
  it("reads claude auth status, codex login status and agent status", async () => {
    const { bin, dir } = fake();
    const claude = new ClaudeRuntime(bin, "helper", {});
    const codex = new CodexRuntime({
      bin, profilePath: join(dir, "missing.toml"), configDir: dir, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const cursor = new CursorRuntime(bin, {});
    expect(await claude.loginStatus(dir)).toBe("missing");
    auth(dir, true);
    expect(await claude.loginStatus(dir)).toBe("ok");
    expect(await codex.loginStatus(dir)).toBe("ok");
    expect(await cursor.loginStatus(dir)).toBe("ok");
    auth(dir, false);
    expect(await claude.loginStatus(dir)).toBe("missing");
    expect(await codex.loginStatus(dir)).toBe("missing");
    expect(await cursor.loginStatus(dir)).toBe("missing");
    expect(await new ClaudeRuntime("/no/such/claude", "helper", {}).loginStatus(dir)).toBe("unknown");
    expect(await new CursorRuntime("/no/such/agent", {}).loginStatus(dir)).toBe("unknown");
  });

  it("stops a subscription run whose method is a key", async () => {
    const { bin, dir } = fake();
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: dir, model: "m", effort: "high",
      workspace: dir, deny: [], reservation: 0, probe: false, subscription: true,
    };
    const claude = new ClaudeRuntime(bin, "helper", {});
    const codex = new CodexRuntime({
      bin, profilePath: join(dir, "missing.toml"), configDir: dir, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const cursor = new CursorRuntime(bin, {});
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "api_key" }));
    await expect(claude.execute(plan, [])).rejects.toThrow("not the subscription");
    await expect(codex.execute(plan, [])).rejects.toThrow("not the subscription");
    await expect(cursor.execute(plan, [])).rejects.toThrow("not the subscription");
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "claude.ai" }));
    await expect(claude.execute(plan, [])).resolves.toMatchObject({ status: 0 });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    await expect(codex.execute(plan, [])).resolves.toMatchObject({ status: 0 });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "cursor.com" }));
    await expect(cursor.execute(plan, [])).resolves.toMatchObject({ status: 0 });
  });

  it("reads a ChatGPT sign-in from stderr and refuses an API-key line there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const bin = join(dir, "codex.mjs");
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, "");
    writeFileSync(bin, `process.stderr.write("Logged in using ChatGPT\\n");\n`);
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: dir, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: dir, model: "m", effort: "high",
      workspace: dir, deny: ["/tmp/vault"], reservation: 0, probe: false, subscription: true,
    };
    await expect(runtime.execute(plan, [])).resolves.toMatchObject({ status: 0 });
    writeFileSync(bin, `process.stderr.write("Logged in using an API key - \\n");\n`);
    await expect(runtime.execute(plan, [])).rejects.toThrow("not the subscription");
    writeFileSync(bin, `process.stderr.write("Not logged in\\n");\nprocess.exit(1);\n`);
    await expect(runtime.execute(plan, [])).rejects.toThrow("not the subscription");
  });

  it("refuses a cursor api-key plan before the binary runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const marker = join(dir, "ran");
    const bin = join(dir, "agent.mjs");
    writeFileSync(bin, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const cursor = new CursorRuntime(bin, {});
    const plan: RunPlan = {
      lease: "l1", connection: "work", ref: "ref-work", configDir: null, model: "m", effort: "high",
      workspace: dir, deny: [], reservation: 0, probe: false,
    };
    await expect(cursor.execute(plan, [])).rejects.toThrow("browser login");
    expect(existsSync(marker)).toBe(false);
  });

  it("accepts a browser sign-in line and rejects a negative one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const bin = join(dir, "agent.mjs");
    writeFileSync(bin, `process.stdout.write("✓ Logged in as person@example.com\\n");\n`);
    const cursor = new CursorRuntime(bin, {});
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: dir, model: "m", effort: "high",
      workspace: dir, deny: [], reservation: 0, probe: false, subscription: true,
    };
    await expect(cursor.execute(plan, [])).resolves.toMatchObject({ status: 0 });
    expect(acceptsSubscription("cursor", "Not authenticated")).toBe(false);
    expect(acceptsSubscription("cursor", "Unauthenticated")).toBe(false);
    expect(acceptsSubscription("cursor", "Not logged in. Run agent login")).toBe(false);
    expect(acceptsSubscription("codex", "Not logged in to ChatGPT")).toBe(false);
    expect(acceptsSubscription("codex", "Logged in using ChatGPT")).toBe(true);
    writeFileSync(bin, `process.stdout.write("Not logged in. Run agent login\\n");\n`);
    await expect(cursor.execute(plan, [])).rejects.toThrow("not the subscription");
    expect(await cursor.loginStatus(dir)).toBe("missing");
  });

  it("names a denied or killed status check instead of a missing binary or a sign-out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const denied = join(dir, "denied-bin");
    writeFileSync(denied, "");
    chmodSync(denied, 0);
    await expect(assertSubscription(denied, ["status"], {}, "cursor")).rejects.toThrow("is denied");
    await expect(assertSubscription(denied, ["status"], {}, "cursor")).rejects.toBeInstanceOf(StatusRefused);
    expect(isStatusRefusal(new Error("helper timed out"))).toBe(false);
    expect(isStatusRefusal(new Error("was killed by SIGTERM"))).toBe(false);
    const killed = join(dir, "killed.mjs");
    writeFileSync(killed, `process.kill(process.pid, "SIGKILL");\n`);
    await expect(assertSubscription(killed, ["status"], {}, "cursor")).rejects.toThrow("was killed by SIGKILL");
    await expect(assertSubscription(join(dir, "missing-bin"), ["status"], {}, "cursor")).rejects.toThrow("is not on PATH");
  });

  it("reports a timed-out status check without blocking the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const bin = join(dir, "hang.mjs");
    writeFileSync(bin, `setInterval(() => {}, 1_000);\n`);
    const start = performance.now();
    const pending = assertSubscription(bin, ["auth", "status"], {}, "claude", 40);
    expect(performance.now() - start).toBeLessThan(100);
    await expect(pending).rejects.toThrow("timed out");
  }, 20_000);

  it("a timed-out status check resolves while a grandchild holds the pipes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-login-"));
    dirs.push(dir);
    const grand = join(dir, "grand.mjs");
    writeFileSync(grand, `process.stdout.write("holding\\n"); setInterval(() => {}, 1_000);\n`);
    const wrap = join(dir, "wrap.mjs");
    writeFileSync(wrap, `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(grand)}], { stdio: "inherit" });
setInterval(() => {}, 1_000);
`);
    const started = performance.now();
    const reading = await readAuth(wrap, ["status"], {}, 40);
    expect(performance.now() - started).toBeLessThan(500);
    expect(reading).toBe("timeout");
  }, 1_000);
});
