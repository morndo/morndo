// Sinks through the real bin (ADR-0037, slice 4; KP20): `keypool sink add|remove|list`, and the lane deny list of a `run`: every sink of every pool
// and the sidecar of each is denied to the agent's tools, beside the vault, the database and the identity, in both lists the settings carry. The runtime is the
// fixture fake-keyed-runtime.mjs. Every key is synthetic.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
const KEYS = ["sk-ant-synthetic-sink-key-0001", "sk-ant-synthetic-sink-key-0002", "sk-ant-synthetic-sink-key-0003", "sk-ant-synthetic-sink-key-0004", "sk-ant-synthetic-sink-key-0005"];
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/fake-keyed-runtime.mjs");
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
// Keys k1..k5; pool p over k1 and k2, pool q over k3 and k4; k5 is no pool's. `elsewhere` is a directory outside the home, where the sinks live.
async function world(): Promise<{ dir: string; elsewhere: string; env: NodeJS.ProcessEnv }> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-sink-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "morndo-sinkfiles-"));
  dirs.push(dir, elsewhere);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "home"));
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(dir, "home"), MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath, MORNDO_CLAUDE_BIN: fixture,
    PWD: join(dir, "work"),
  };
  for (let i = 1; i <= 5; i++) {
    const added = await cli(["add", `k${i}`, "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEYS[i - 1]);
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", `k${i}`, "--by", "owner"], env)).code).toBe(0);
  }
  for (const [name, members] of [["p", ["k1", "k2"]], ["q", ["k3", "k4"]]] as const) {
    const made = await cli(["keypool", "create", name, "--vendor", "anthropic", "--runtime", "claude", "--by", "owner", "--confirm-own-account", ...members], env);
    expect(made.code, made.stderr).toBe(0);
  }
  return { dir, elsewhere, env };
}
const job = (dir: string): string => {
  const path = join(dir, "work", `job-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ record: join(dir, "work", "record.jsonl"), keys: {} }));
  return path;
};
type Settings = { permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[] } } };
// The settings of the last run recorded by the fixture.
const lastSettings = (dir: string): Settings => {
  const rows = readFileSync(join(dir, "work", "record.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { argv: string[] });
  const argv = rows.at(-1)?.argv ?? [];
  return JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "{}") as Settings;
};
// What a run denies without any sink: the vault, the database and the identity.
const BASE = 3;
const runPool = (env: NodeJS.ProcessEnv, dir: string, pool = "p") =>
  cli(["run", "--pool", pool, "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", job(dir)], env);
const runOne = (env: NodeJS.ProcessEnv, dir: string) =>
  cli(["run", "--connection", "k5", "--workspace", join(dir, "work"), "--reserve", "1", "--", "-p", "--job", job(dir)], env);

describe("keypool sink add | remove | list", () => {
  it("add registers a path for that pool; list prints that pool's paths only, one JSON line each", async () => {
    const { env, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    const b = join(elsewhere, "other.env");
    expect((await cli(["keypool", "sink", "add", "p", a], env)).code).toBe(0);
    expect((await cli(["keypool", "sink", "add", "q", b], env)).code).toBe(0);
    const listed = await cli(["keypool", "sink", "list", "p"], env);
    expect(listed.code).toBe(0);
    expect(listed.stdout.trim().split("\n").map(line => JSON.parse(line) as unknown)).toEqual([{ pool: "p", path: a }]);
    expect(listed.stdout).not.toContain(b);
  });
  it("remove takes it out; a path that is not there says missing", async () => {
    const { env, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    expect((await cli(["keypool", "sink", "remove", "p", a], env)).code).toBe(0);
    expect((await cli(["keypool", "sink", "list", "p"], env)).stdout).toBe("");
    const again = await cli(["keypool", "sink", "remove", "p", a], env);
    expect([again.code, again.stderr.trim()]).toEqual([1, "missing"]);
  });
  it("refuses a path another pool holds (sink_taken), a bad path (bad_path), an unknown pool (missing) and a missing path argument (usage)", async () => {
    const { env, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    expect((await cli(["keypool", "sink", "add", "q", a], env)).stderr.trim()).toBe("sink_taken");
    expect((await cli(["keypool", "sink", "add", "p", "relative.env"], env)).stderr.trim()).toBe("bad_path");
    expect((await cli(["keypool", "sink", "add", "nope", join(elsewhere, "x.env")], env)).stderr.trim()).toBe("missing");
    expect((await cli(["keypool", "sink", "add", "p"], env)).stderr.trim()).toBe("usage");
    expect((await cli(["keypool", "sink", "frob", "p"], env)).stderr.trim()).toBe("usage");
  });
  it("refuses a path inside the connections home (sink_protected) and a path that is a directory (sink_directory)", async () => {
    const { env, dir, elsewhere } = await world();
    expect((await cli(["keypool", "sink", "add", "p", join(dir, "vault", "x.env")], env)).stderr.trim()).toBe("sink_protected");
    expect((await cli(["keypool", "sink", "add", "p", join(dir, "connections.db")], env)).stderr.trim()).toBe("sink_protected");
    expect((await cli(["keypool", "sink", "add", "p", elsewhere], env)).stderr.trim()).toBe("sink_directory");
  });
  it("refuses a path whose directory is a link into the connections home: the real place is judged", async () => {
    const { env, dir, elsewhere } = await world();
    symlinkSync(dir, join(elsewhere, "lnk"));
    expect((await cli(["keypool", "sink", "add", "p", join(elsewhere, "lnk", "x.env")], env)).stderr.trim()).toBe("sink_protected");
    expect((await cli(["keypool", "sink", "add", "p", join(elsewhere, "lnk", "vault", "x.env")], env)).stderr.trim()).toBe("sink_protected");
  });
  it("keypool list prints no sink path (the hub forwards it)", async () => {
    const { env, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    expect((await cli(["keypool", "list"], env)).stdout).not.toContain(a);
    expect((await cli(["keypool", "list"], env)).stdout).not.toContain("sink");
  });
});

describe("the lane deny list of a run", () => {
  it("characterisation: with no sink the deny lists are the the vault, the database and the identity", async () => {
    const { env, dir } = await world();
    expect((await runPool(env, dir)).code).toBe(0);
    const settings = lastSettings(dir);
    expect(settings.sandbox.filesystem.denyRead).toHaveLength(BASE);
    expect(settings.permissions.deny.every(rule => rule.startsWith("Read(//"))).toBe(true);
  });
  it("a registered sink and its sidecar are in both lists, for a pooled run and for a single-connection run", async () => {
    const { env, dir, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    for (const run of [() => runPool(env, dir), () => runOne(env, dir)]) {
      expect((await run()).code).toBe(0);
      const settings = lastSettings(dir);
      for (const path of [a, `${a}.member`]) {
        expect(settings.sandbox.filesystem.denyRead, path).toContain(path);
        expect(settings.permissions.deny, path).toContain(`Read(/${path})`);
      }
      expect(settings.sandbox.filesystem.denyRead).toHaveLength(BASE + 2);
    }
  });
  it("a sink of another pool is denied too: any lane may read any sink", async () => {
    const { env, dir, elsewhere } = await world();
    const b = join(elsewhere, "other.env");
    await cli(["keypool", "sink", "add", "q", b], env);
    expect((await runPool(env, dir, "p")).code).toBe(0);
    expect(lastSettings(dir).sandbox.filesystem.denyRead).toContain(b);
    expect(lastSettings(dir).permissions.deny).toContain(`Read(/${b})`);
  });
  it("a removed sink leaves the deny list at the next run", async () => {
    const { env, dir, elsewhere } = await world();
    const a = join(elsewhere, "app.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    await cli(["keypool", "sink", "remove", "p", a], env);
    expect((await runPool(env, dir)).code).toBe(0);
    expect(lastSettings(dir).sandbox.filesystem.denyRead).not.toContain(a);
    expect(lastSettings(dir).sandbox.filesystem.denyRead).toHaveLength(BASE);
  });
  it("the rule for a file that does not exist yet covers the file and what is under it (readRule)", async () => {
    const { env, dir, elsewhere } = await world();
    const a = join(elsewhere, "not-yet.env");
    await cli(["keypool", "sink", "add", "p", a], env);
    expect((await runPool(env, dir)).code).toBe(0);
    const deny = lastSettings(dir).permissions.deny;
    expect(deny).toContain(`Read(/${a})`);
    expect(deny).toContain(`Read(/${a}/**)`);
  });
});
