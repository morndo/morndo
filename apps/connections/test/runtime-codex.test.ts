import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunPlan } from "../src/application/ports.ts";
import { CodexRuntime, codexAuthToml, codexConfig, isolationFromProfile } from "../src/adapters/runtime-codex.ts";
import { isStatusRefusal } from "../src/adapters/runtime-claude.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The note a fake child writes with a plain writeFileSync can be seen half written: the file exists before its text is
// whole. A parse error inside the window means "not yet"; only the window running out is a failure.
async function awaitNote<T>(path: string, windowMs: number): Promise<T | null> {
  const started = performance.now();
  while (performance.now() - started < windowMs) {
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { /* still being written */ }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
}

describe("codex permission profile", () => {
  it("cites the pages checked on 2026-10-10", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/adapters/runtime-codex.ts"), "utf8");
    expect(source).toContain("https://developers.openai.com/codex/config-advanced");
    expect(source).toContain("https://developers.openai.com/codex/permissions");
    expect(source).toContain("2026-10-10");
  });

  it("treats a permission profile as the isolation, and writes auth.command without env_key", () => {
    expect(isolationFromProfile('default_permissions = ":workspace"\n')).toBe("rules");
    expect(isolationFromProfile('default_permissions = ":danger-full-access"\n')).toBe("none");
    expect(isolationFromProfile('sandbox_mode = "workspace-write"\ndefault_permissions = "morndo"\n')).toBe("rules");
    const custom = 'default_permissions = "morndo"\n[permissions.morndo.filesystem."/tmp/vault"]\n"." = "deny"\n';
    expect(isolationFromProfile(custom)).toBe("os");
    expect(isolationFromProfile('default_permissions = "morndo"\n[permissions.morndo]\ndescription = "no filesystem"\n')).toBe("rules");
    const profile = 'default_permissions = "morndo"\n[permissions.morndo.filesystem."/tmp/vault"]\n"." = "deny"\n';
    const config = codexConfig(profile, ["/home/vault", "/home/connections.db", "/home/identity"], codexAuthToml("/usr/bin/node", ["helper"], "https://api.openai.com"));
    expect(config).toContain('[permissions.morndo.filesystem."/home/vault"]');
    expect(config).toContain('[permissions.morndo.filesystem."/home/identity"]');
    expect(config).toContain('"." = "deny"');
    const toml = codexAuthToml("/usr/bin/node", ["helper", "--lease", "l1"], "https://api.openai.com");
    expect(toml).toContain('command = "/usr/bin/node"');
    expect(toml).toContain("timeout_ms = 5000");
    expect(toml).toContain("refresh_interval_ms = 60000");
    expect(toml).not.toContain("env_key");
  });

  it("puts the provider at the root and refuses a profile that sets one", () => {
    const auth = codexAuthToml("/usr/bin/node", ["helper"], "https://api.openai.com");
    const profile = '[permissions.morndo]\ndescription = "os"\n';
    const config = codexConfig(profile, [], auth);
    const providerAt = config.indexOf('model_provider = "morndo"');
    const tableAt = config.indexOf("[permissions.morndo]");
    const oursAt = config.indexOf("[model_providers.morndo]");
    expect(providerAt).toBeGreaterThanOrEqual(0);
    expect(providerAt).toBeLessThan(tableAt);
    expect(oursAt).toBeGreaterThan(tableAt);
    expect(() => codexConfig('model_provider = "openai"\n', [], auth)).toThrow(/model_provider/);
  });

  it("a subscription run leaves the login config byte-identical and denies from another home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-login-"));
    dirs.push(dir);
    const login = join(dir, "login");
    mkdirSync(login);
    const original = Buffer.from('model = "kept"\nmcp = "personal"\n');
    writeFileSync(join(login, "config.toml"), original);
    writeFileSync(join(login, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    const seen = join(dir, "seen.jsonl");
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `import { appendFileSync, readFileSync, readlinkSync } from "node:fs";
const row = { codex: process.env.CODEX_HOME ?? null, argv: process.argv.slice(2), config: "", auth: "" };
if (!process.argv.includes("status") && process.env.CODEX_HOME) {
  row.config = readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8");
  row.auth = readlinkSync(process.env.CODEX_HOME + "/auth.json");
}
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(row) + "\\n");
if (process.argv.includes("status")) {
  const auth = JSON.parse(readFileSync(process.env.CODEX_HOME + "/auth.json", "utf8"));
  if (!auth.signedIn) process.exit(1);
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
process.exit(0);
`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n[permissions.morndo.filesystem."/tmp/profile"]\n"." = "deny"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: login, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: login, model: "m", effort: "high",
      workspace: dir, deny: ["/tmp/vault", "/tmp/identity"], reservation: 0, probe: false, subscription: true,
    };
    await runtime.execute(plan, []);
    expect(readFileSync(join(login, "config.toml"))).toEqual(original);
    const rows = readFileSync(seen, "utf8").trim().split("\n").map(line => JSON.parse(line) as { codex: string | null; argv: string[]; config: string; auth: string });
    const run = rows.find(row => !row.argv.includes("status"));
    expect(run?.codex).toBeTruthy();
    expect(run?.codex).not.toBe(login);
    expect(run?.config).toContain('[permissions.morndo.filesystem."/tmp/vault"]');
    expect(run?.config).toContain('[permissions.morndo.filesystem."/tmp/identity"]');
    expect(run?.config).not.toContain("command =");
    expect(run?.auth).toBe(join(login, "auth.json"));
    expect(existsSync(run?.codex ?? "")).toBe(false);
    expect(runtime.isolation()).toBe("os");
  });

  it("a subscription without a config dir still denies and leaves the default login unchanged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-default-"));
    dirs.push(dir);
    const home = join(dir, "home");
    const login = join(home, ".codex");
    mkdirSync(login, { recursive: true });
    const original = Buffer.from('model = "kept"\n');
    writeFileSync(join(login, "config.toml"), original);
    writeFileSync(join(login, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    const seen = join(dir, "seen.jsonl");
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `import { appendFileSync, readFileSync, readlinkSync } from "node:fs";
const row = { codex: process.env.CODEX_HOME ?? null, argv: process.argv.slice(2), config: "", auth: "" };
if (!process.argv.includes("status") && process.env.CODEX_HOME) {
  row.config = readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8");
  row.auth = readlinkSync(process.env.CODEX_HOME + "/auth.json");
}
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(row) + "\\n");
process.stderr.write("Logged in using ChatGPT\\n");
`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n[permissions.morndo.filesystem."/tmp/profile"]\n"." = "deny"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: join(dir, "private"), command: "helper", args: [], baseUrl: "", parent: { HOME: home },
    });
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: null, model: "m", effort: "high",
      workspace: dir, deny: ["/tmp/vault"], reservation: 0, probe: false, subscription: true,
    };
    await runtime.execute(plan, []);
    expect(readFileSync(join(login, "config.toml"))).toEqual(original);
    const rows = readFileSync(seen, "utf8").trim().split("\n").map(line => JSON.parse(line) as { codex: string | null; argv: string[]; config: string; auth: string });
    const check = rows.find(row => row.argv.includes("status"));
    const run = rows.find(row => !row.argv.includes("status"));
    expect(check?.codex).toBeNull();
    expect(run?.codex).toBeTruthy();
    expect(run?.codex).not.toBe(login);
    expect(run?.config).toContain('[permissions.morndo.filesystem."/tmp/vault"]');
    expect(run?.auth).toBe(join(login, "auth.json"));
    expect(existsSync(run?.codex ?? "")).toBe(false);
  });

  it("a missing config dir leaves the check on the runtime default and the run on its own home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-default-"));
    dirs.push(dir);
    const home = join(dir, "empty-home");
    mkdirSync(home);
    const seen = join(dir, "seen.jsonl");
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `import { appendFileSync, readFileSync } from "node:fs";
const row = { codex: process.env.CODEX_HOME ?? null, argv: process.argv.slice(2), config: "" };
if (!process.argv.includes("status") && process.env.CODEX_HOME) row.config = readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8");
appendFileSync(${JSON.stringify(seen)}, JSON.stringify(row) + "\\n");
process.stderr.write("Logged in using ChatGPT\\n");
`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: join(dir, "private"), command: "helper", args: [], baseUrl: "", parent: { HOME: home },
    });
    expect(await runtime.loginStatus(null)).toBe("ok");
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: null, model: "m", effort: "high",
      workspace: dir, deny: ["/tmp/vault"], reservation: 0, probe: false, subscription: true,
    };
    await runtime.execute(plan, []);
    const rows = readFileSync(seen, "utf8").trim().split("\n").map(line => JSON.parse(line) as { codex: string | null; argv: string[]; config: string });
    expect(rows.find(row => row.argv.includes("status"))?.codex).toBeNull();
    const run = rows.find(row => !row.argv.includes("status"));
    expect(run?.codex).toBeTruthy();
    expect(run?.codex?.startsWith(home)).toBe(false);
    expect(run?.config).toContain('[permissions.morndo.filesystem."/tmp/vault"]');
    expect(existsSync(run?.codex ?? "")).toBe(false);
  });

  it("removes the run home after the child exits, including a failure or a kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-clean-"));
    dirs.push(dir);
    const login = join(dir, "login");
    mkdirSync(login);
    writeFileSync(join(login, "config.toml"), 'model = "kept"\n');
    writeFileSync(join(login, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    const note = join(dir, "note.json");
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `import { writeFileSync } from "node:fs";
if (process.argv.includes("status")) {
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
const code = process.argv.at(-1);
writeFileSync(${JSON.stringify(note)}, JSON.stringify({ codex: process.env.CODEX_HOME, pid: process.pid }));
if (code === "kill") setInterval(() => {}, 1_000);
else process.exit(Number(code));
`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: login, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const plan = (): RunPlan => ({
      lease: "l1", connection: "seat", ref: null, configDir: login, model: "m", effort: "high",
      workspace: dir, deny: ["/tmp/vault"], reservation: 0, probe: false, subscription: true,
    });
    const homeAfter = async (code: string): Promise<string> => {
      rmSync(note, { force: true });
      const pending = runtime.execute(plan(), [code]);
      const recorded = await awaitNote<{ codex: string; pid: number }>(note, 2_000);
      if (!recorded) throw new Error("run home was not recorded");
      if (code === "kill") process.kill(recorded.pid, "SIGKILL");
      await pending;
      return recorded.codex;
    };
    expect(existsSync(await homeAfter("0"))).toBe(false);
    expect(existsSync(await homeAfter("1"))).toBe(false);
    expect(existsSync(await homeAfter("kill"))).toBe(false);
  });

  it("keeps session history in the login directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-sessions-"));
    dirs.push(dir);
    const login = join(dir, "login");
    mkdirSync(join(login, "sessions"), { recursive: true });
    writeFileSync(join(login, "sessions", "old.txt"), "old");
    writeFileSync(join(login, "config.toml"), 'model = "kept"\n');
    writeFileSync(join(login, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    const seen = join(dir, "seen.json");
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `import { appendFileSync, readlinkSync, writeFileSync } from "node:fs";
if (process.argv.includes("status")) {
  process.stderr.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
const home = process.env.CODEX_HOME;
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
  sessions: readlinkSync(home + "/sessions"),
  history: readlinkSync(home + "/history.jsonl"),
}));
appendFileSync(home + "/sessions/new.txt", "new");
appendFileSync(home + "/history.jsonl", "new-line\\n");
`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: login, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: login, model: "m", effort: "high",
      workspace: dir, deny: [], reservation: 0, probe: false, subscription: true,
    };
    await runtime.execute(plan, []);
    const recorded = JSON.parse(readFileSync(seen, "utf8")) as { sessions: string; history: string };
    expect(recorded.sessions).toBe(join(login, "sessions"));
    expect(recorded.history).toBe(join(login, "history.jsonl"));
    expect(readFileSync(join(login, "sessions", "old.txt"), "utf8")).toBe("old");
    expect(readFileSync(join(login, "sessions", "new.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(login, "history.jsonl"), "utf8")).toBe("new-line\n");
  });

  it("refuses a keyring login because the run home cannot see that entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-keyring-"));
    dirs.push(dir);
    const login = join(dir, "login");
    mkdirSync(login);
    writeFileSync(join(login, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "chatgpt" }));
    const bin = join(dir, "codex.mjs");
    writeFileSync(bin, `if (process.argv.includes("status")) process.stderr.write("Logged in using ChatGPT\\n");\n`);
    const profile = join(dir, "profile.toml");
    writeFileSync(profile, 'default_permissions = "morndo"\n');
    const runtime = new CodexRuntime({
      bin, profilePath: profile, configDir: login, command: "helper", args: [], baseUrl: "", parent: {},
    });
    const plan: RunPlan = {
      lease: "l1", connection: "seat", ref: null, configDir: login, model: "m", effort: "high",
      workspace: dir, deny: [], reservation: 0, probe: false, subscription: true,
    };
    for (const mode of ["keyring", "auto"]) {
      writeFileSync(join(login, "config.toml"), `cli_auth_credentials_store = "${mode}"\n`);
      const refused = runtime.execute(plan, []).then(() => null, (error: unknown) => error);
      const error = await refused;
      expect(isStatusRefusal(error)).toBe(true);
      if (!isStatusRefusal(error)) throw new Error("expected a status refusal");
      expect(error.exit).toBe(75);
      expect(error.message).toMatch(/keyring/i);
    }
    writeFileSync(join(login, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    await expect(runtime.execute(plan, [])).resolves.toMatchObject({ status: 0 });
  });
});

describe("awaitNote", () => {
  it("waits out a note that exists but is only half written, and fails only when the window runs out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-codex-note-"));
    dirs.push(dir);
    const note = join(dir, "note.json");
    writeFileSync(note, '{"codex": "/run/home", "pi');
    setTimeout(() => writeFileSync(note, JSON.stringify({ codex: "/run/home", pid: 7 })), 60);
    expect(await awaitNote<{ codex: string; pid: number }>(note, 2_000)).toEqual({ codex: "/run/home", pid: 7 });
    writeFileSync(note, '{"codex": "/run/home", "pi');
    expect(await awaitNote(note, 100)).toBeNull();
  });
});
