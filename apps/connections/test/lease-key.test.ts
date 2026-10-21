// `morndo-keys lease --connection <name>` as an apiKeyHelper (T-340): one call is one lease — the gate runs, the key is
// printed once on stdout, a KeyServed audit line lands, the lease closes. The key never reaches argv, env, stderr or a
// file outside the vault. The `run` path that serves `helper --lease <id>` stays e2e.test.ts's
// "sends the key only as the helper header and keeps it out of env".
// Z.ai's floor is os, so its lease is served only to a claude parent started with the sandbox settings (check 2,
// adapters/caller-proof.ts). The tests make that parent: a process whose exe is the binary MORNDO_CLAUDE_BIN names (here
// node itself), started with --settings, which runs the helper line through `sh -c` as Claude Code does.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSettings } from "../src/adapters/runtime-claude.ts";
import { selfHolder } from "../src/adapters/processes.ts";
import { openHome } from "../src/compose.ts";

const KEY = "sk-ant-synthetic-test-key-0001";
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const main = join(import.meta.dirname, "../src/main.ts");
const composeTs = join(import.meta.dirname, "../src/compose.ts");
const processesTs = join(import.meta.dirname, "../src/adapters/processes.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-lease-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  return dir;
}

// No key variable in this env: a lane that samples the child's environ must find the key nowhere it was put.
function envOf(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath,
    PWD: join(dir, "work"), ...extra,
  };
}

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

// The settings a lane's Claude Code is started with: what the runtime writes (vault, database and identity denied to Bash
// and to the Read tool, sandbox on and fail-closed), changed by `change` for a case that must be refused.
let counter = 0;
function settingsFile(dir: string, change: (body: Record<string, any>) => void = () => {}): string {
  const deny = [join(dir, "vault"), join(dir, "connections.db"), join(dir, "identity")];
  const plan = { lease: "l", connection: "zai", ref: null, configDir: null, model: "m", effort: "low", workspace: join(dir, "work"), deny, reservation: 0, probe: true };
  const body = JSON.parse(claudeSettings(plan, "ulimit -c 0; exec morndo-keys lease --connection zai")) as Record<string, any>;
  change(body);
  const path = join(dir, `settings-${counter++}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

type Via = { settings?: string | null; keepShell?: boolean; sample?: Buffer[]; isolation?: string | null };

// Runs `lease` as an apiKeyHelper: a "claude" parent (this node binary, started with --settings) that runs the helper line
// through `sh -c`. With `exec`, as the documented line has, the lease's parent is the claude process; `keepShell` leaves a
// shell between them, as an agent's own shell command has. `sample` collects /proc/<pid>/{cmdline,environ} of the tree.
function viaClaude(dir: string, args: string[], via: Via = {}): Promise<Out> {
  const script = join(dir, "parent.mjs");
  writeFileSync(script, `import { spawn } from "node:child_process";
const child = spawn("sh", ["-c", process.env.LEASE_CMD], { stdio: ["ignore", "inherit", "inherit"] });
child.on("close", code => process.exit(code ?? 1));
`);
  const isolation = via.isolation === null ? [] : ["--isolation", via.isolation ?? "os"];
  const lease = `${process.execPath} --experimental-strip-types ${main} lease ${[...args, ...isolation].join(" ")}`;
  const command = via.keepShell ? `${lease}; code=$?; exit $code` : `ulimit -c 0; exec ${lease}`;
  const settings = via.settings === null ? [] : ["--settings", via.settings ?? settingsFile(dir)];
  const env = envOf(dir, { LEASE_CMD: command, MORNDO_CLAUDE_BIN: process.execPath });
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...settings], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const read = (pid: number) => {
      for (const file of ["cmdline", "environ"]) {
        try { via.sample?.push(readFileSync(`/proc/${pid}/${file}`)); } catch { /* gone */ }
      }
      let kids: string[] = [];
      try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean); } catch { /* none */ }
      for (const kid of kids) read(Number(kid));
    };
    const timer = via.sample ? setInterval(() => read(child.pid ?? -1), 4) : null;
    child.on("close", code => { if (timer) clearInterval(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

const lease = (dir: string, extra: string[] = [], via: Via = {}) => viaClaude(dir, ["--connection", "zai", ...extra], via);

async function zaiReady(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const added = await cli(["add", "zai", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEY);
  expect(added.code, added.stderr).toBe(0);
  expect((await cli(["ack", "zai", "--by", "owner"], env)).code).toBe(0);
}

async function events(env: NodeJS.ProcessEnv, name?: string): Promise<Record<string, unknown>[]> {
  const log = await cli(name ? ["log", name] : ["log"], env);
  return log.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function storedLeases(dir: string): unknown[] {
  const db = new Database(join(dir, "connections.db"), { readonly: true, fileMustExist: true });
  const stored = db.prepare("SELECT body FROM directory WHERE id = 1").get() as { body: string };
  db.close();
  return (JSON.parse(stored.body) as { connections: { leases: unknown[] }[] }).connections.flatMap(c => c.leases);
}

describe("keys lease", () => {
  it("lease prints the key and only the key, takes one lease and closes it", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    const ran = await lease(dir);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(`${KEY}\n`);
    expect(ran.stderr).toBe("");
    const rows = await events(env, "zai");
    const granted = rows.find(e => e.type === "LeaseGranted");
    const served = rows.filter(e => e.type === "KeyServed");
    const closed = rows.filter(e => e.type === "LeaseClosed");
    expect(served).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(served[0]?.lease).toBe(granted?.lease);
    expect(closed[0]?.lease).toBe(granted?.lease);
    expect(storedLeases(dir)).toEqual([]);
  }, 30_000);

  it("a planted key never appears in argv, env, the audit log, the registry or stderr", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    // Claude Code runs an apiKeyHelper through the system shell; the sample of /proc catches a key put in argv or env.
    const samples: Buffer[] = [];
    const ran = await lease(dir, [], { sample: samples });
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toBe(`${KEY}\n`);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) expect(sample.includes(Buffer.from(KEY)), "a /proc sample holds the key").toBe(false);
    expect(ran.stderr).not.toContain(KEY);
    expect((await cli(["log", "zai"], env)).stdout).not.toContain(KEY);
    const needle = Buffer.from(KEY);
    const vault = join(dir, "vault");
    const planted: string[] = [];
    const scan = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) { if (path !== vault) scan(path); continue; }
        if (readFileSync(path).includes(needle)) planted.push(path);
      }
    };
    scan(dir);
    expect(planted, "files outside the vault hold the key").toEqual([]);
    const held = readdirSync(vault).find(name => name.startsWith("key-"));
    expect(held && readFileSync(join(vault, held)).includes(needle), "the vault no longer holds the key: the scan proved nothing").toBe(true);
  }, 30_000);

  it("refusals print nothing on stdout and the reason word on stderr", async () => {
    // One home per row: a row that ends the connection (revoke) must not speak for the next.
    const cases: { what: string; connection: string; prepare?: (env: NodeJS.ProcessEnv) => Promise<void>; exit: number; word: string }[] = [
      { what: "missing", connection: "nope", exit: 1, word: "missing" },
      { what: "revoked", connection: "zai", prepare: async env => { expect((await cli(["revoke", "zai"], env)).code).toBe(0); }, exit: 1, word: "revoked" },
      { what: "off", connection: "zai", prepare: async env => { expect((await cli(["off", "zai"], env)).code).toBe(0); }, exit: 75, word: "off" },
      { what: "expired", connection: "zai", prepare: async env => { expect((await cli(["expiry", "zai", "1"], env)).code).toBe(0); }, exit: 75, word: "expired" },
      {
        what: "not_leasable", connection: "credit", exit: 1, word: "not_leasable",
        // Its own key text: a second copy of zai's key would be refused for its fingerprint, not its runtime.
        prepare: async env => { expect((await cli(["add", "credit", "--vendor", "deepseek", "--runtime", "codex", "--billing", "metered", "--budget", "10"], env, "sk-deepseek-synthetic-test-key-0002")).code).toBe(0); },
      },
      {
        what: "subscription", connection: "sub", exit: 1, word: "not_leasable",
        prepare: async env => { expect((await cli(["add", "sub", "--vendor", "claude", "--runtime", "claude", "--subscription", "true"], env)).code).toBe(0); },
      },
    ];
    for (const row of cases) {
      const dir = homeDir();
      const env = envOf(dir);
      await zaiReady(dir, env);
      await row.prepare?.(env);
      const ran = await viaClaude(dir, ["--connection", row.connection]);
      expect(ran.stdout, row.what).toBe("");
      expect(ran.stderr, row.what).toContain(row.word);
      expect(ran.stderr, row.what).not.toContain(KEY);
      expect(ran.code, row.what).toBe(row.exit);
      expect((await events(env)).some(e => e.type === "KeyServed"), row.what).toBe(false);
    }
  }, 180_000);

  it("check 2: a connection that has to run under os is served only to a claude parent with the sandbox settings", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    type Settings = { sandbox: { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean; filesystem: { denyRead: string[] } }; permissions: { deny: string[] } };
    const changed = (change: (s: Settings) => void) => settingsFile(dir, body => change(body as unknown as Settings));
    const rows: { what: string; run: () => Promise<Out> }[] = [
      { what: "a bare --isolation os claim from any process", run: () => cli(["lease", "--connection", "zai", "--isolation", "os"], env) },
      { what: "the agent's own shell command: a shell between the lease and claude", run: () => lease(dir, [], { keepShell: true }) },
      { what: "claude started without --settings", run: () => lease(dir, [], { settings: null }) },
      { what: "the sandbox is off", run: () => lease(dir, [], { settings: changed(s => { s.sandbox.enabled = false; }) }) },
      { what: "the sandbox opens on failure", run: () => lease(dir, [], { settings: changed(s => { s.sandbox.failIfUnavailable = false; }) }) },
      { what: "a command may leave the sandbox", run: () => lease(dir, [], { settings: changed(s => { s.sandbox.allowUnsandboxedCommands = true; }) }) },
      { what: "the vault is readable to Bash", run: () => lease(dir, [], { settings: changed(s => { s.sandbox.filesystem.denyRead = s.sandbox.filesystem.denyRead.filter(p => !p.endsWith("/vault")); }) }) },
      { what: "the identity is readable to the Read tool", run: () => lease(dir, [], { settings: changed(s => { s.permissions.deny = s.permissions.deny.filter(rule => !rule.includes("/identity")); }) }) },
    ];
    for (const row of rows) {
      const ran = await row.run();
      expect(ran.stdout, row.what).toBe("");
      expect(ran.stderr, row.what).toContain("isolation");
      expect(ran.stderr, row.what).not.toContain(KEY);
      expect(ran.code, row.what).toBe(75);
    }
    const all = await events(env, "zai");
    expect(all.filter(e => e.type === "LeaseRefused" && e.reason === "isolation")).toHaveLength(rows.length);
    expect(all.some(e => e.type === "KeyServed")).toBe(false);
    // and the right parent, once more, is served: the refusals above were the settings, not the setup
    const served = await lease(dir);
    expect(served.code, served.stderr).toBe(0);
    expect(served.stdout).toBe(`${KEY}\n`);
  }, 240_000);

  it("a connection that needs less than os is served on the caller's claim, and the audit says claimed", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    const added = await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, "sk-ant-synthetic-test-key-0002");
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], env)).code).toBe(0);
    const none = await cli(["lease", "--connection", "credit"], env);              // anthropic's floor is rules: nothing vouched is refused
    expect(none.code).toBe(75);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("isolation");
    const rules = await cli(["lease", "--connection", "credit", "--isolation", "rules"], env);
    expect(rules.code, rules.stderr).toBe(0);
    expect(rules.stdout).toBe("sk-ant-synthetic-test-key-0002\n");
    const served = (await events(env, "credit")).filter(e => e.type === "KeyServed");
    expect(served).toHaveLength(1);
    expect(served[0]?.caller).toMatchObject({ isolation: "rules", proof: "claimed" });
  }, 60_000);

  it("a vault that fails says only failed, never its message", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    const secret = readdirSync(join(dir, "vault")).find(name => name.startsWith("key-"));
    expect(secret).toBeTruthy();
    rmSync(join(dir, "vault", secret ?? ""));
    const ran = await lease(dir);
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("failed\n");
  }, 30_000);

  it("an error that is not one of the lease's own prints only the reason word, never a path", async () => {
    const dir = homeDir();
    const notADirectory = join(dir, "a-file");
    writeFileSync(notADirectory, "x");
    const ran = await cli(["lease", "--connection", "zai"], envOf(dir, { MORNDO_CONNECTIONS_HOME: notADirectory }));
    expect(ran.code).not.toBe(0);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toBe("failed\n");
    expect(ran.stderr).not.toContain(dir);
  }, 30_000);

  it("one KeyServed per call, with the caller's claims and how the isolation is known", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    for (let i = 0; i < 2; i++) {
      const ran = await lease(dir, ["--lane", "builder", "--workspace", join(dir, "work")]);
      expect(ran.code, ran.stderr).toBe(0);
    }
    const rows = await events(env, "zai");
    const served = rows.filter(e => e.type === "KeyServed");
    expect(served).toHaveLength(2);
    expect(new Set(served.map(e => e.lease)).size).toBe(2);
    for (const event of served) {
      const caller = event.caller as { pid: number; ppid: number; lane: string | null; workspace: string; isolation: string; proof: string };
      expect(caller.lane).toBe("builder");
      expect(caller.workspace).toBe(join(dir, "work"));
      expect(caller.isolation).toBe("os");
      expect(caller.proof).toBe("verified");                    // the parent was read, not taken on the caller's word
      expect(typeof caller.pid).toBe("number");
      expect(typeof caller.ppid).toBe("number");
    }
    expect(rows.some(e => JSON.stringify(e).includes(KEY))).toBe(false);
    expect(storedLeases(dir)).toEqual([]);
  }, 60_000);

  it("a lease killed before it closes is swept by the next lease call", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    // A child that takes the lease limit's worth of leases and dies by SIGKILL: no finally runs, nothing closes them.
    const orphans = join(dir, "orphans.mjs");
    writeFileSync(orphans, `import { openHome } from ${JSON.stringify(composeTs)};
import { selfHolder } from ${JSON.stringify(processesTs)};
const home = openHome(process.env);
home.runtime.current = { isolation: () => "os", dialects: () => ["anthropic"], loginStatus: () => Promise.resolve("unknown"), launch: () => Promise.resolve({ id: "" }) };
const holder = selfHolder(null);
for (let i = 0; i < 8; i++) {
  const granted = home.leases.lease("zai", { role: "x", entry: "x", holder, workspacePath: process.env.PWD, limit: 8, reserve: 0, margin: 0, probe: true });
  if (!granted.ok) throw new Error(granted.error.problem);
}
home.close();
process.stdout.write("ready\\n");
process.kill(process.pid, "SIGKILL");
`);
    await new Promise<void>(resolve => {
      const child = spawn(process.execPath, ["--experimental-strip-types", orphans], { env });
      child.on("close", () => resolve());
    });
    expect(storedLeases(dir)).toHaveLength(8);
    const ran = await lease(dir);
    expect(ran.code, ran.stderr).toBe(0);                       // without the sweep the gate answers `leases`: 8 are open
    expect(ran.stdout).toBe(`${KEY}\n`);
    expect((await events(env, "zai")).filter(e => e.type === "LeaseLost")).toHaveLength(8);
    expect(storedLeases(dir)).toEqual([]);
  }, 60_000);

  it("help names the helper line: ulimit, exec, and what the caller must be", async () => {
    const dir = homeDir();
    const help = await cli(["help"], envOf(dir));
    expect(help.stdout).toContain("ulimit -c 0; exec morndo-keys lease --connection <name>");
    expect(help.stdout).toContain("Node can neither wipe a string nor set its own core limit");
  });

  it("helper --lease serves a lease's key as an apiKeyHelper reads it: the key and a newline, nothing else", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    await zaiReady(dir, env);
    // A lease held by this process (as `run` holds its own); the helper is its child, so the ancestry check admits it.
    const home = openHome(env);
    let id = "";
    try {
      home.runtime.current = { isolation: () => "os" as const, dialects: () => ["anthropic"], loginStatus: () => Promise.resolve("unknown" as const), launch: () => Promise.resolve({ id: "" }) };
      const holder = selfHolder(null);
      if (!holder) throw new Error("no holder");
      const granted = home.leases.lease("zai", { role: "run", entry: "default", holder, workspacePath: join(dir, "work"), limit: 8, reserve: 1, margin: 0, probe: false });
      if (!granted.ok) throw new Error(granted.error.problem);
      id = granted.value.id;
    } finally { home.close(); }
    const served = await cli(["helper", "--lease", id], env);
    expect(served.code).toBe(0);
    expect(served.stdout.split("\n")).toEqual([KEY, ""]);
    expect(served.stderr).toBe("");
    // Closed, the lease serves nothing: no key on stdout and a failing exit, which Claude Code reports as a failed helper.
    const again = openHome(env);
    try { expect(again.leases.close("zai", id, "done", null).ok).toBe(true); } finally { again.close(); }
    const closed = await cli(["helper", "--lease", id], env);
    expect(closed.code).toBe(1);
    expect(closed.stdout).toBe("");
  }, 30_000);
});
