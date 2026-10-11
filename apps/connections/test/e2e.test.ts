// Row 4 done-check. A local server records headers. The runtime binary is the fixture, not a vendor CLI.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
const KEY = "sk-ant-synthetic-test-key-0001";
const catalogPath = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const fixture = join(import.meta.dirname, "fixtures/fake-runtime.mjs");
const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function homeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-e2e-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  return dir;
}

function envOf(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalogPath,
    MORNDO_CLAUDE_BIN: fixture, MORNDO_CODEX_BIN: fixture, PWD: join(dir, "work"), ANTHROPIC_API_KEY: KEY, ...extra,
  };
}

function cli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function ready(dir: string, vendor = "anthropic", runtime = "claude", budget = "10"): Promise<void> {
  const added = await cli(["add", "credit", "--vendor", vendor, "--runtime", runtime, "--billing", "metered", "--budget", budget], envOf(dir), KEY);
  expect(added.code, added.stderr).toBe(0);
  expect((await cli(["ack", "credit", "--by", "owner"], envOf(dir))).code).toBe(0);
}

function job(dir: string, body: Record<string, unknown>): string {
  const path = join(dir, `job-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ record: join(dir, "record.json"), ...body }));
  return path;
}

function listen(): Promise<{ server: Server; url: string; hits: { authorization?: string | undefined; apiKey?: string | undefined }[] }> {
  const hits: { authorization?: string | undefined; apiKey?: string | undefined }[] = [];
  const server = createServer((req, res) => {
    hits.push({ authorization: req.headers.authorization, apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined });
    res.end("{}");
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    resolve({ server, url: `http://127.0.0.1:${address.port}/v1/messages`, hits });
  }));
}

describe("keys run", () => {
  it("refuses an api-key cursor run before booking the key", async () => {
    const dir = homeDir();
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; kinds: string[] }[];
    const cursor = catalog.find(row => row.id === "cursor");
    if (!cursor) throw new Error("cursor preset missing");
    cursor.kinds = ["subscription", "api-key"];
    const catalogFile = join(dir, "vendors.json");
    writeFileSync(catalogFile, JSON.stringify(catalog));
    const env = envOf(dir, { MORNDO_CATALOG: catalogFile, MORNDO_CURSOR_BIN: fixture });
    const added = await cli(["add", "work", "--vendor", "cursor", "--runtime", "cursor", "--billing", "metered", "--budget", "10"], env, "cursor-synthetic-test-key-0001");
    expect(added.code, added.stderr).not.toBe(0);
    expect(added.stderr).toContain("browser login");
    expect((await cli(["log", "work"], env)).stdout).not.toContain("LeaseGranted");
  }, 20_000);

  it("honours the implement role's model and effort", async () => {
    const dir = homeDir();
    const env = envOf(dir);
    expect((await cli(["add", "glm", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "20"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "glm", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "glm", "--role", "implement", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { exit: 0 })], env);
    expect(ran.code, ran.stderr).toBe(0);
    const recorded = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(recorded.env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(recorded.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-5.3-flash");
    expect(recorded.argv[recorded.argv.indexOf("--effort") + 1]).toBe("max");
    expect(recorded.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("max");
    expect(recorded.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT).toBe("1");
    const other = await cli(["run", "--connection", "glm", "--role", "review", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { exit: 0 })], env);
    expect(other.code, other.stderr).toBe(0);
    const again = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(again.env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(again.argv[again.argv.indexOf("--effort") + 1]).toBe("high");
    expect(again.env.CLAUDE_CODE_EFFORT_LEVEL).toBe("high");
  }, 20_000);

  it("sends a Z.ai key only as the helper header to the catalog base URL", async () => {
    const dir = homeDir();
    const hits: { url?: string | undefined; authorization?: string | undefined; apiKey?: string | undefined }[] = [];
    const server = createServer((req, res) => {
      hits.push({
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      });
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { baseUrl: string | null }[] }[];
    const zai = body.find(row => row.id === "zai");
    if (!zai) throw new Error("preset");
    const runtime = zai.runtimes[0];
    if (!runtime) throw new Error("runtime");
    runtime.baseUrl = origin;
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", "glm", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "20"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "glm", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "glm", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { base: true, model: "glm-5.3" })], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).not.toContain(KEY);
    expect(hits).toEqual([{ url: "/v1/messages", authorization: `Bearer ${KEY}`, apiKey: KEY }]);
    const recorded = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { env: Record<string, string>; bashEnv: string };
    expect(recorded.env.ANTHROPIC_BASE_URL).toBe(origin);
    expect(recorded.env.ANTHROPIC_MODEL).toBe("glm-5.3");
    expect(JSON.stringify(recorded.env)).not.toContain(KEY);
    expect(recorded.bashEnv).not.toContain(KEY);
  }, 20_000);

  it("refuses a claude run whose base URL is missing", async () => {
    const dir = homeDir();
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { baseUrl: string | null }[]; terms: { revision: string; summary: string; sources: string[] } }[];
    const custom = body.find(row => row.id === "custom-anthropic");
    if (!custom) throw new Error("preset");
    custom.terms = { revision: "2026-01-01", summary: "Named by the test.", sources: ["https://example.com/terms"] };
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", "gate", "--vendor", "custom-anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "gate", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "gate", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { exit: 0 })], env);
    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain("base URL");
    expect(existsSync(join(dir, "record.json"))).toBe(false);
    expect((await cli(["log", "gate"], env)).stdout).not.toContain("LeaseGranted");
  }, 20_000);

  it("does not mark a placeholder pick as a missing model after a successful run", async () => {
    const dir = homeDir();
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { baseUrl: string | null }[]; terms: { revision: string; summary: string; sources: string[] } }[];
    const custom = body.find(row => row.id === "custom-anthropic");
    if (!custom) throw new Error("preset");
    custom.terms = { revision: "2026-01-01", summary: "Named by the test.", sources: ["https://example.com/terms"] };
    const runtime = custom.runtimes[0];
    if (!runtime) throw new Error("runtime");
    runtime.baseUrl = "http://127.0.0.1:9";
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", "gate", "--vendor", "custom-anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "gate", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "gate", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { model: "glm-5.3" })], env);
    expect(ran.code, ran.stderr).toBe(0);
    const enginesPath = join(dir, "engines.json");
    const marks = existsSync(enginesPath)
      ? (JSON.parse(readFileSync(enginesPath, "utf8")) as { marks: { reason: string }[] }).marks
      : [];
    expect(marks.some(mark => mark.reason.includes("missing"))).toBe(false);
  }, 20_000);

  it("records a placeholder lease entry as default", async () => {
    const dir = homeDir();
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { baseUrl: string | null }[]; terms: { revision: string; summary: string; sources: string[] } }[];
    const custom = body.find(row => row.id === "custom-anthropic");
    if (!custom) throw new Error("preset");
    custom.terms = { revision: "2026-01-01", summary: "Named by the test.", sources: ["https://example.com/terms"] };
    const runtime = custom.runtimes[0];
    if (!runtime) throw new Error("runtime");
    runtime.baseUrl = "http://127.0.0.1:9";
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", "gate", "--vendor", "custom-anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "gate", "--by", "owner"], env)).code).toBe(0);
    const running = cli(["run", "--connection", "gate", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, {
      hold: { ready: join(dir, "ready"), release: join(dir, "release") },
      helperOut: join(dir, "helpers.json"),
    })], env);
    while (!existsSync(join(dir, "ready"))) await new Promise(resolve => setTimeout(resolve, 20));
    const db = new Database(join(dir, "connections.db"), { readonly: true, fileMustExist: true });
    const stored = db.prepare("SELECT body FROM directory WHERE id = 1").get() as { body: string };
    db.close();
    const directory = JSON.parse(stored.body) as { connections: { leases: { entry: string }[] }[] };
    expect(directory.connections.flatMap(connection => connection.leases).map(lease => lease.entry)).toEqual(["default"]);
    writeFileSync(join(dir, "release"), "go");
    const ran = await running;
    expect(ran.code, ran.stderr).toBe(0);
  }, 20_000);

  it("charges a Z.ai lease from catalog token prices, not total_cost_usd", async () => {
    const dir = homeDir();
    const hits: { url?: string | undefined }[] = [];
    const server = createServer((_req, res) => {
      hits.push({ url: _req.url });
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { baseUrl: string | null }[] }[];
    const zai = body.find(row => row.id === "zai");
    if (!zai) throw new Error("preset");
    const runtime = zai.runtimes[0];
    if (!runtime) throw new Error("runtime");
    runtime.baseUrl = origin;
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", "glm", "--vendor", "zai", "--runtime", "claude", "--billing", "metered", "--budget", "20"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", "glm", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "glm", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, {
      base: true,
      model: "glm-5.3",
      cost: 99,
      modelUsage: { "glm-5.3": { inputTokens: 1_000_000, outputTokens: 0 } },
    })], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(hits).toEqual([{ url: "/v1/messages" }]);
    const spent = JSON.parse((await cli(["spend", "glm"], env)).stdout) as { spent: number };
    expect(spent.spent).toBe(1.4);
  }, 20_000);

  it.each([
    ["deepseek", "deepseek-v4-pro"],
    ["moonshot", "kimi-k3"],
    ["openrouter", "openrouter/auto"],
  ])("sends a %s key to its catalog base as %s", async (vendor, model) => {
    const dir = homeDir();
    const hits: { url?: string | undefined; authorization?: string | undefined; apiKey?: string | undefined }[] = [];
    const server = createServer((req, res) => {
      hits.push({
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      });
      res.end("{}");
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    const origin = `http://127.0.0.1:${address.port}`;
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; runtimes: { runtime: string; baseUrl: string | null }[] }[];
    const row = body.find(item => item.id === vendor);
    if (!row) throw new Error("preset");
    const runtime = row.runtimes.find(item => item.runtime === "claude");
    if (!runtime) throw new Error("runtime");
    runtime.baseUrl = origin;
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const env = envOf(dir, { MORNDO_CATALOG: catalog });
    expect((await cli(["add", vendor, "--vendor", vendor, "--runtime", "claude", "--billing", "metered", "--budget", "20"], env, KEY)).code).toBe(0);
    expect((await cli(["ack", vendor, "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", vendor, "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { base: true, model })], env);
    expect(ran.code, ran.stderr).toBe(0);
    expect(hits).toEqual([{ url: "/v1/messages", authorization: `Bearer ${KEY}`, apiKey: KEY }]);
    const recorded = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { env: Record<string, string> };
    expect(recorded.env.ANTHROPIC_BASE_URL).toBe(origin);
    expect(recorded.env.ANTHROPIC_MODEL).toBe(model);
    expect(recorded.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.stringify(recorded.env)).not.toContain(KEY);
  }, 20_000);

  it("sends the key only as the helper header and keeps it out of env", async () => {
    const dir = homeDir();
    await ready(dir);
    const api = await listen();
    const path = job(dir, { api: api.url, cost: 0.25 });
    const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", path], envOf(dir));
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).not.toContain(KEY);
    expect(api.hits).toEqual([{ authorization: `Bearer ${KEY}`, apiKey: KEY }]);
    const recorded = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; env: Record<string, string>; bashEnv: string };
    expect(JSON.stringify(recorded.env)).not.toContain(KEY);
    expect(recorded.bashEnv).not.toContain(KEY);
    expect(recorded.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS).toBe("60000");
    expect(recorded.argv[recorded.argv.indexOf("--max-budget-usd") + 1]).toBe("2.00");
    expect((await cli(["spend", "credit"], envOf(dir))).stdout).toContain("0.25");
  }, 20_000);

  it("refuses the next helper call after the connection is turned off", async () => {
    const dir = homeDir();
    await ready(dir);
    const helperOut = join(dir, "helpers.json");
    const path = job(dir, { hold: { ready: join(dir, "ready"), release: join(dir, "release") }, helperOut });
    const running = cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", path], envOf(dir));
    while (!existsSync(join(dir, "ready"))) await new Promise(resolve => setTimeout(resolve, 20));
    const id = JSON.parse((await cli(["log", "credit"], envOf(dir))).stdout.split("\n").find(line => line.includes("LeaseGranted")) ?? "{}") as { lease?: string };
    const stranger = await cli(["helper", "--lease", id.lease ?? ""], envOf(dir));
    expect(stranger.code).toBe(1);
    expect(stranger.stdout).not.toContain(KEY);
    expect((await cli(["off", "credit"], envOf(dir))).code).toBe(0);
    writeFileSync(join(dir, "release"), "go");
    const ran = await running;
    expect(ran.code, ran.stderr).toBe(0);
    const outs = JSON.parse(readFileSync(helperOut, "utf8")) as string[];
    expect(outs[0]?.trim()).toBe(KEY);
    expect(outs[1]?.trim() ?? "").toBe("");
  }, 20_000);

  it("counts a subagent and ends the lease on the call past the allowance", async () => {
    const dir = homeDir();
    await ready(dir);
    const helperOut = join(dir, "helpers.json");
    const path = job(dir, { calls: 5, subagentAt: 1, helperOut });
    const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", path], envOf(dir));
    expect(ran.code, ran.stderr).toBe(0);
    const outs = JSON.parse(readFileSync(helperOut, "utf8")) as string[];
    expect(outs.slice(0, 4).map(text => text.trim())).toEqual([KEY, KEY, KEY, KEY]);
    expect(outs[4]?.trim() ?? "").toBe("");
    expect((await cli(["log", "credit"], envOf(dir))).stdout).toContain("helper_limit");
  }, 20_000);

  it("refuses a second lease once the budget is reserved", async () => {
    const dir = homeDir();
    await ready(dir, "anthropic", "claude", "2");
    const path = job(dir, { hold: { ready: join(dir, "ready"), release: join(dir, "release") }, helperOut: join(dir, "helpers.json") });
    const first = cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", path], envOf(dir));
    while (!existsSync(join(dir, "ready"))) await new Promise(resolve => setTimeout(resolve, 20));
    const second = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { exit: 0 })], envOf(dir));
    expect(second.code).toBe(75);
    expect(second.stderr).toContain("budget");
    writeFileSync(join(dir, "release"), "go");
    expect((await first).code).toBe(0);
  }, 20_000);

  it("exits 70 when the store is not private, and 75 when terms or the repo list refuse", async () => {
    const dir = homeDir();
    const added = await cli(["add", "credit", "--vendor", "anthropic", "--runtime", "claude", "--billing", "metered", "--budget", "10"], envOf(dir), KEY);
    expect(added.code).toBe(0);
    const early = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { exit: 0 })], envOf(dir));
    expect(early.code).toBe(75);
    expect(early.stderr).toContain("terms");
    expect(existsSync(join(dir, "record.json"))).toBe(false);
    expect((await cli(["ack", "credit", "--by", "owner"], envOf(dir))).code).toBe(0);
    const workspace = join(dir, "work");
    expect((await cli(["repos", "credit", "--deny", workspace], envOf(dir))).code).toBe(0);
    const denied = await cli(["run", "--connection", "credit", "--workspace", workspace, "--", "--job", job(dir, { exit: 0 })], envOf(dir));
    expect(denied.code).toBe(75);
    expect(denied.stderr).toContain("repo");
    chmodSync(join(dir, "connections.db"), 0o644);
    const broken = await cli(["run", "--connection", "credit", "--workspace", workspace, "--", "--job", job(dir, { exit: 0 })], envOf(dir));
    expect(broken.code).toBe(70);
    expect(existsSync(join(dir, "record.json"))).toBe(false);
  }, 20_000);

  it("turns a child exit of 70 into 1", async () => {
    const dir = homeDir();
    await ready(dir);
    const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { exit: 70 })], envOf(dir));
    expect(ran.code).toBe(1);
  }, 20_000);

  it("fetches a model list under a probe lease and marks a mismatch", async () => {
    const dir = homeDir();
    await ready(dir);
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "other-model" }] }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("port");
    const body = JSON.parse(readFileSync(catalogPath, "utf8")) as { id: string; models: { url?: string } }[];
    const anthropic = body.find(row => row.id === "anthropic");
    if (!anthropic) throw new Error("preset");
    anthropic.models.url = `http://127.0.0.1:${address.port}/models`;
    const catalog = join(dir, "vendors.json");
    writeFileSync(catalog, JSON.stringify(body));
    const before = await cli(["models", "other"], { ...envOf(dir), MORNDO_CATALOG: catalog });
    expect(before.code).toBe(1);
    expect(hits).toEqual([]);
    const listed = await cli(["models", "credit"], { ...envOf(dir), MORNDO_CATALOG: catalog });
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("other-model");
    expect(hits).toEqual(["/models"]);
    const marks = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { marks: { name: string; reason: string }[] };
    expect(marks.marks[0]?.name).toBe("credit");
    expect(marks.marks[0]?.reason).toContain("sonnet-5.5");
    expect(marks.marks.some(mark => mark.name === "claude")).toBe(false);
    expect((await cli(["spend", "credit"], { ...envOf(dir), MORNDO_CATALOG: catalog })).stdout).toContain("\"spent\":0");
    expect((await cli(["log", "credit"], envOf(dir))).stdout).toContain("LeaseGranted");
  }, 20_000);

  it("rotates onto a fresh ref that is not the current one", async () => {
    const dir = homeDir();
    await ready(dir);
    const before = readdirSync(join(dir, "vault")).filter(name => name.startsWith("key-"));
    const rotated = await cli(["rotate", "credit"], envOf(dir), "sk-ant-synthetic-test-key-0002");
    expect(rotated.code, rotated.stderr).toBe(0);
    const after = readdirSync(join(dir, "vault")).filter(name => name.startsWith("key-"));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]?.split("-").at(-1)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("matches a catalog id pattern and marks only that connection", async () => {
    const dir = homeDir();
    await ready(dir);
    const matched = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { model: "claude-sonnet-5-5-20260901" })], envOf(dir));
    expect(matched.code, matched.stderr).toBe(0);
    const quiet = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { marks: { name: string; reason: string }[] };
    expect(quiet.marks.filter(mark => mark.reason.includes("model"))).toEqual([]);
    const missed = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { model: "not-a-sonnet" })], envOf(dir));
    expect(missed.code, missed.stderr).toBe(0);
    const marks = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { marks: { name: string; reason: string }[] };
    expect(marks.marks.filter(mark => mark.reason.includes("not-a-sonnet")).map(mark => mark.name)).toEqual(["credit"]);
  }, 20_000);

  it("forwards redacted stderr and keeps the output if the key rotates", async () => {
    const dir = homeDir();
    await ready(dir);
    const path = job(dir, { speak: KEY, hold: { ready: join(dir, "ready"), release: join(dir, "release") } });
    const running = cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", path], envOf(dir));
    while (!existsSync(join(dir, "ready"))) await new Promise(resolve => setTimeout(resolve, 20));
    const rotated = await cli(["rotate", "credit"], envOf(dir), "sk-ant-synthetic-test-key-0003");
    expect(rotated.code, rotated.stderr).toBe(0);
    writeFileSync(join(dir, "release"), "go");
    const ran = await running;
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("[redacted]");
    expect(ran.stderr).toContain("[redacted]");
    expect(ran.stdout).not.toContain(KEY);
    expect(ran.stderr).not.toContain(KEY);
  }, 20_000);

  it("charges the reservation when the run reports no cost", async () => {
    const dir = homeDir();
    await ready(dir);
    const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--reserve", "2", "--", "--job", job(dir, { omitCost: true })], envOf(dir));
    expect(ran.code, ran.stderr).toBe(0);
    expect((await cli(["spend", "credit"], envOf(dir))).stdout).toContain("\"spent\":2");
  }, 20_000);

  it("closes the lease when the secret cannot be opened", async () => {
    const dir = homeDir();
    await ready(dir);
    const secret = readdirSync(join(dir, "vault")).find(name => name.startsWith("key-"));
    expect(secret).toBeTruthy();
    const file = join(dir, "vault", secret ?? "");
    chmodSync(file, 0o000);
    try {
      const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, {})], envOf(dir));
      expect(ran.code).not.toBe(0);
    } finally { chmodSync(file, 0o600); }
    const events = await cli(["log", "credit"], envOf(dir));
    const closed = events.stdout.split("\n").filter(line => line.includes("LeaseClosed")).map(line => JSON.parse(line) as { outcome: string });
    expect(closed.at(-1)?.outcome).toContain("EACCES");
  }, 20_000);

  it("the read tool cannot open the identity file or the database", async () => {
    const dir = homeDir();
    await ready(dir);
    writeFileSync(join(dir, "identity"), "IDENTITY-MARKER");
    for (const path of [join(dir, "identity"), join(dir, "connections.db")]) {
      const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { read: path })], envOf(dir));
      expect(ran.code, ran.stderr).toBe(1);
      expect(ran.stdout).not.toContain("IDENTITY-MARKER");
      expect(ran.stdout).not.toContain("SQLite format 3");
    }
  }, 20_000);

  it("fails a sandboxed cat of the identity and the vault", async () => {
    const dir = homeDir();
    await ready(dir);
    const identity = join(dir, "identity");
    const secret = join(dir, "vault", "note");
    writeFileSync(identity, "IDENTITY-MARKER");
    writeFileSync(secret, "MARKER-SECRET");
    for (const path of [identity, secret]) {
      const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { cat: path })], envOf(dir));
      expect(ran.code).toBe(1);
      expect(ran.stdout).not.toContain("IDENTITY-MARKER");
      expect(ran.stdout).not.toContain("MARKER-SECRET");
    }
    expect(readFileSync(identity, "utf8")).toBe("IDENTITY-MARKER");
    expect(readFileSync(secret, "utf8")).toBe("MARKER-SECRET");
  }, 20_000);

  it("checks Codex's permission profile before it grants a lease", async () => {
    const dir = homeDir();
    const profile = join(dir, "codex.toml");
    writeFileSync(profile, 'default_permissions = ":workspace"\n');
    const base = envOf(dir, { MORNDO_CODEX_CONFIG: profile });
    expect((await cli(["add", "credit", "--vendor", "deepseek", "--runtime", "codex", "--billing", "metered", "--budget", "10"], base, KEY)).code).toBe(0);
    expect((await cli(["ack", "credit", "--by", "owner"], base)).code).toBe(0);
    const refused = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { exit: 0 })], base);
    expect(refused.code).toBe(75);
    expect(refused.stderr).toContain("isolation");
    writeFileSync(profile, 'default_permissions = "morndo"\n[permissions.morndo.filesystem."/tmp/vault"]\n"." = "deny"\n');
    const ran = await cli(["run", "--connection", "credit", "--workspace", join(dir, "work"), "--", "--job", job(dir, { exit: 0 })], base);
    expect(ran.code, ran.stderr).toBe(0);
    const config = readFileSync(join(dir, "runtime", "credit", "config.toml"), "utf8");
    expect(config).toContain(`[permissions.morndo.filesystem."${join(dir, "vault")}"]`);
    expect(config).toContain(`[permissions.morndo.filesystem."${join(dir, "identity")}"]`);
    expect(config).toContain("timeout_ms = 5000");
    expect(config).toContain("refresh_interval_ms = 60000");
    expect(config).toContain('command = "');
    expect(config).not.toContain("env_key");
  }, 20_000);

  it("a denied status check exits 75 and names the denial", async () => {
    const dir = homeDir();
    const bin = join(dir, "denied-bin");
    writeFileSync(bin, "");
    chmodSync(bin, 0);
    const env = envOf(dir, { MORNDO_CLAUDE_BIN: bin });
    expect((await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude"], env)).code).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], env)).code).toBe(0);
    const ran = await cli(["run", "--connection", "seat", "--workspace", join(dir, "work"), "--"], env);
    expect(ran.code).toBe(75);
    expect(ran.stderr).toContain("is denied");
    expect(ran.stderr).not.toContain("not on PATH");
  }, 20_000);

  it("a subscription without a config dir leaves the login directory to the runtime", async () => {
    const dir = homeDir();
    const seen = join(dir, "seen.jsonl");
    const bin = join(dir, "runtime.mjs");
    writeFileSync(bin, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({
  claude: process.env.CLAUDE_CONFIG_DIR ?? null,
  codex: process.env.CODEX_HOME ?? null,
  cursor: process.env.CURSOR_CONFIG_DIR ?? null,
}) + "\\n");
process.stdout.write(JSON.stringify({ authMethod: "claude.ai" }));
`);
    expect((await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude"], envOf(dir, { MORNDO_CLAUDE_BIN: bin }))).code).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], envOf(dir, { MORNDO_CLAUDE_BIN: bin }))).code).toBe(0);
    await cli(["run", "--connection", "seat", "--workspace", join(dir, "work"), "--"], envOf(dir, { MORNDO_CLAUDE_BIN: bin }));
    const rows = readFileSync(seen, "utf8").trim().split("\n").map(line => JSON.parse(line) as { claude: string | null; codex: string | null; cursor: string | null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.claude === null && row.codex === null && row.cursor === null)).toBe(true);
  }, 20_000);

  it("runs a subscription without a stray key from the parent", async () => {
    const dir = homeDir();
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "claude.ai" }));
    const added = await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude", "--config-dir", cfg], envOf(dir));
    expect(added.code, added.stderr).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], envOf(dir))).code).toBe(0);
    const api = await listen();
    const ran = await cli(["run", "--connection", "seat", "--workspace", join(dir, "work"), "--", "--job", job(dir, { subscription: true, api: api.url })], envOf(dir));
    expect(ran.code, ran.stderr).toBe(0);
    expect(api.hits).toEqual([{ authorization: undefined, apiKey: undefined }]);
    const recorded = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[]; env: Record<string, string> };
    expect(JSON.stringify(recorded.env)).not.toContain(KEY);
    expect(recorded.argv.join(" ")).not.toContain("apiKeyHelper");
    const settings = JSON.parse(recorded.argv[recorded.argv.indexOf("--settings") + 1] ?? "{}") as {
      apiKeyHelper?: string;
      permissions: { deny: string[] };
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; credentials: { envVars: { name: string; mode: string }[] }; filesystem: { denyRead: string[] } };
    };
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.permissions.deny.some(rule => rule.includes(join(dir, "identity")))).toBe(true);
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(settings.sandbox.credentials.envVars).toContainEqual({ name: "ANTHROPIC_API_KEY", mode: "deny" });
    expect(settings.sandbox.filesystem.denyRead).toContain(join(dir, "vault"));
    expect(recorded.env.CLAUDE_CONFIG_DIR).toBe(cfg);
    expect(ran.stdout).toContain('"authMethod":"claude.ai"');
  }, 20_000);

  it("refuses a subscription run whose sign-in is a key", async () => {
    const dir = homeDir();
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    writeFileSync(join(cfg, "auth.json"), JSON.stringify({ signedIn: true, authMethod: "api_key" }));
    expect((await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude", "--config-dir", cfg], envOf(dir))).code).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], envOf(dir))).code).toBe(0);
    const api = await listen();
    const ran = await cli(["run", "--connection", "seat", "--workspace", join(dir, "work"), "--", "--job", job(dir, { subscription: true, api: api.url })], envOf(dir));
    expect(ran.code).toBe(75);
    expect(ran.stderr).toContain("not the subscription");
    expect(api.hits).toEqual([]);
  }, 20_000);

  it("a repo-denied workspace exits 75 and the next entry runs", async () => {
    const dir = homeDir();
    const cfg = join(dir, "cfg");
    mkdirSync(cfg);
    expect((await cli(["add", "seat", "--subscription", "--vendor", "claude", "--runtime", "claude", "--config-dir", cfg], envOf(dir))).code).toBe(0);
    expect((await cli(["ack", "seat", "--by", "owner"], envOf(dir))).code).toBe(0);
    const workspace = join(dir, "work");
    expect((await cli(["repos", "seat", "--deny", workspace], envOf(dir))).code).toBe(0);
    const ran = await cli(["run", "--connection", "seat", "--workspace", workspace, "--", "--job", job(dir, { subscription: true })], envOf(dir));
    expect(ran.code).toBe(75);
    expect(ran.stderr).toContain("repo");
    expect(existsSync(join(dir, "record.json"))).toBe(false);
    const next = join(dir, "next.mjs");
    const marker = join(dir, "fell-through");
    writeFileSync(next, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const followed = spawnSync(process.execPath, [next], { encoding: "utf8" });
    expect(followed.status).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  }, 20_000);

  it("switches the gate when the engines file is the CLI default", async () => {
    const dir = homeDir();
    const home = join(dir, "home");
    const config = join(home, ".config", "engines", "engines.json");
    mkdirSync(join(home, ".config", "engines"), { recursive: true });
    writeFileSync(config, JSON.stringify({
      providers: { claude: { enabled: true, adapter: "claude", bin: "claude-as", probe: "claude-as --version" } },
    }));
    const env = envOf(dir, { MORNDO_ENGINES_BIN: join(import.meta.dirname, "fixtures/engines-cli.mjs"), HOME: home });
    delete env.ENGINES_CONFIG;
    expect((await cli(["gate", "on", "claude"], env)).code).toBe(0);
    const gated = JSON.parse(readFileSync(config, "utf8")) as { providers: { claude: { bin: unknown; adapter: unknown } } };
    expect(gated.providers.claude.bin).toEqual(["morndo-keys", "run", "--connection", "claude", "--"]);
    expect(gated.providers.claude.adapter).toBe("claude");
    expect((await cli(["gate", "off", "claude"], env)).code).toBe(0);
    const restored = JSON.parse(readFileSync(config, "utf8")) as { providers: { claude: { bin: unknown } } };
    expect(restored.providers.claude.bin).toBe("claude-as");
  }, 20_000);

  it("saves the stored command, not the listing default, and puts that back", async () => {
    const dir = homeDir();
    const config = join(dir, "engines.json");
    writeFileSync(config, JSON.stringify({
      providers: { claude: { enabled: true, adapter: "claude", note: "private" } },
    }));
    const env = envOf(dir, {
      MORNDO_ENGINES_BIN: join(import.meta.dirname, "fixtures/engines-cli.mjs"),
      ENGINES_CONFIG: config,
    });
    expect((await cli(["gate", "on", "claude"], env)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "gate", "claude.json"), "utf8"))).toEqual({ bin: null, probe: null });
    expect((await cli(["gate", "off", "claude"], env)).code).toBe(0);
    const after = JSON.parse(readFileSync(config, "utf8")) as { providers: { claude: Record<string, unknown> } };
    expect(after.providers.claude.bin).toBeUndefined();
    expect(after.providers.claude.probe).toBeUndefined();
    expect(after.providers.claude.adapter).toBe("claude");
    expect(after.providers.claude.note).toBe("private");
    expect(after.providers.claude.label).toBeUndefined();
  }, 20_000);

  it("changes only the command on the stored provider", async () => {
    const dir = homeDir();
    const config = join(dir, "engines.json");
    writeFileSync(config, JSON.stringify({
      providers: {
        claude: { enabled: true, adapter: "claude", family: "anthropic", bin: "claude-as", probe: "claude-as --version", note: "private" },
      },
    }));
    const env = envOf(dir, {
      MORNDO_ENGINES_BIN: join(import.meta.dirname, "fixtures/engines-cli.mjs"),
      ENGINES_CONFIG: config,
    });
    expect((await cli(["gate", "on", "claude"], env)).code).toBe(0);
    const after = JSON.parse(readFileSync(config, "utf8")) as { providers: { claude: Record<string, unknown> } };
    expect(after.providers.claude.adapter).toBe("claude");
    expect(after.providers.claude.note).toBe("private");
    expect(after.providers.claude.label).toBeUndefined();
    expect(after.providers.claude.efforts).toBeUndefined();
    expect(after.providers.claude.installed).toBeUndefined();
    expect(after.providers.claude.bin).toEqual(["morndo-keys", "run", "--connection", "claude", "--"]);
    expect(after.providers.claude.probe).toEqual(["morndo-keys", "check", "--connection", "claude"]);
  }, 20_000);

  it("saves a string command and an argv command and puts each back unchanged", async () => {
    const dir = homeDir();
    const config = join(dir, "engines.json");
    writeFileSync(config, JSON.stringify({
      providers: {
        claude: { enabled: true, bin: "claude-as", probe: "claude-as --version" },
        codex: { enabled: true, bin: ["codex", "--full"], probe: ["codex", "login", "status"] },
      },
    }));
    const env = envOf(dir, {
      MORNDO_ENGINES_BIN: join(import.meta.dirname, "fixtures/engines-cli.mjs"),
      ENGINES_CONFIG: config,
    });
    expect((await cli(["gate", "on", "claude"], env)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "gate", "claude.json"), "utf8"))).toEqual({ bin: "claude-as", probe: "claude-as --version" });
    expect((await cli(["gate", "off", "claude"], env)).code).toBe(0);
    const stringBack = JSON.parse(readFileSync(config, "utf8")) as { providers: { claude: { bin: unknown; probe: unknown } } };
    expect(stringBack.providers.claude.bin).toBe("claude-as");
    expect(stringBack.providers.claude.probe).toBe("claude-as --version");
    expect((await cli(["gate", "on", "codex"], env)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "gate", "codex.json"), "utf8"))).toEqual({
      bin: ["codex", "--full"], probe: ["codex", "login", "status"],
    });
    expect((await cli(["gate", "off", "codex"], env)).code).toBe(0);
    const arrayBack = JSON.parse(readFileSync(config, "utf8")) as { providers: { codex: { bin: unknown; probe: unknown } } };
    expect(arrayBack.providers.codex.bin).toEqual(["codex", "--full"]);
    expect(arrayBack.providers.codex.probe).toEqual(["codex", "login", "status"]);
  }, 20_000);

  it("drops the saved command when switching off and refuses to save the gate command", async () => {
    const dir = homeDir();
    const engines = join(dir, "engines.json");
    const saved = join(dir, "gate", "claude.json");
    const write = (bin: string[]) => writeFileSync(engines, JSON.stringify({
      providers: [{ name: "claude", enabled: true, bin, probe: ["claude-as", "--version"] }],
      marks: [], chains: [],
    }));
    write(["claude-as"]);
    expect((await cli(["gate", "on", "claude"], envOf(dir))).code).toBe(0);
    expect((await cli(["gate", "off", "claude"], envOf(dir))).code).toBe(0);
    expect(existsSync(saved)).toBe(false);
    write(["claude-v2"]);
    expect((await cli(["gate", "on", "claude"], envOf(dir))).code).toBe(0);
    expect(JSON.parse(readFileSync(saved, "utf8")).bin).toEqual(["claude-v2"]);
    expect((await cli(["gate", "off", "claude"], envOf(dir))).code).toBe(0);
    const restored = JSON.parse(readFileSync(engines, "utf8")) as { providers: { bin: string[] }[] };
    expect(restored.providers[0]?.bin).toEqual(["claude-v2"]);
    write(["morndo-keys", "run", "--connection", "claude", "--"]);
    const refused = await cli(["gate", "on", "claude"], envOf(dir));
    expect(refused.code).not.toBe(0);
    expect(existsSync(saved)).toBe(false);
    const config = join(dir, "cli-engines.json");
    writeFileSync(config, JSON.stringify({
      providers: { claude: { enabled: true, bin: "morndo-keys run --connection claude --", probe: "morndo-keys check --connection claude" } },
    }));
    const stringRefused = await cli(["gate", "on", "claude"], envOf(dir, {
      MORNDO_ENGINES_BIN: join(import.meta.dirname, "fixtures/engines-cli.mjs"),
      ENGINES_CONFIG: config,
    }));
    expect(stringRefused.code).not.toBe(0);
    expect(existsSync(saved)).toBe(false);
  }, 20_000);

  it("switches one provider onto the gate and restores its old command", async () => {
    const dir = homeDir();
    writeFileSync(join(dir, "engines.json"), JSON.stringify({
      providers: [{ name: "claude", enabled: true, bin: ["claude-as"], probe: ["claude-as", "--version"] }],
      marks: [], chains: [],
    }));
    const on = await cli(["gate", "on", "claude"], envOf(dir));
    expect(on.code, on.stderr).toBe(0);
    const switched = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { providers: { bin: string[]; probe: string[] }[] };
    expect(switched.providers[0]?.bin).toEqual(["morndo-keys", "run", "--connection", "claude", "--"]);
    expect(switched.providers[0]?.probe).toEqual(["morndo-keys", "check", "--connection", "claude"]);
    const saved = JSON.parse(readFileSync(join(dir, "gate", "claude.json"), "utf8")) as { bin: string[]; probe: string[] };
    expect(saved.bin).toEqual(["claude-as"]);
    expect(saved.probe).toEqual(["claude-as", "--version"]);
    expect((await cli(["gate", "on", "claude"], envOf(dir))).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "gate", "claude.json"), "utf8"))).toMatchObject({ bin: ["claude-as"] });
    const off = await cli(["gate", "off", "claude"], envOf(dir));
    expect(off.code, off.stderr).toBe(0);
    const restored = JSON.parse(readFileSync(join(dir, "engines.json"), "utf8")) as { providers: { bin: string[]; probe: string[] }[] };
    expect(restored.providers[0]?.bin).toEqual(["claude-as"]);
    expect(restored.providers[0]?.probe).toEqual(["claude-as", "--version"]);
  }, 20_000);
});
