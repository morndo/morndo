// The collector (S5, plan 4.4): one pass of the morndo-usage-claude bin against a fake hub (a plain http server on a
// random port) and a fake CLI (a node script a test writes, never the real claude). It polls the HUB, never the
// provider: only a granted lease spawns a read, and the reading or failure carries the lease id. The token is read
// from its file and never printed. Synthetic data only.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectOnce } from "../src/adapters/usage-claude-main.ts";

const CODEX_FIXTURES = join(import.meta.dirname, "fixtures", "codex");
const FAKE_APP_SERVER = join(import.meta.dirname, "fixtures", "fake-codex-app-server.mjs");
const CODEX_PLUS: unknown = JSON.parse(readFileSync(join(CODEX_FIXTURES, "rate-limits-plus.json"), "utf8"));

const TOKEN = "mat_collector-not-a-real-token";
const SESSION_ONLY = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "fix-1", cwd: "/tmp" }),
  JSON.stringify({ type: "assistant", message: { content: [] }, usage_report: { session: { total_cost_usd: 1, total_api_duration_ms: 1, total_duration_ms: 2, total_lines_added: 1, total_lines_removed: 0, model_usage: {} }, rate_limits: { limits: [{ kind: "session", group: "session", percent: 42, resets_at: "2026-10-24T15:00:00Z", scope: null, severity: "normal", is_active: true }], extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR" } } } }),
  JSON.stringify({ type: "result", is_error: false, num_turns: 0, total_cost_usd: 0, duration_ms: 1000 }),
].join("\n");
const SIGNED_OUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "fix-2", cwd: "/tmp" }),
  JSON.stringify({ type: "result", subtype: "error", is_error: true, num_turns: 0, result: "please login again (401)" }),
].join("\n");

const FAKE_CLI = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(import.meta.dirname, "spawn.log"), process.argv.slice(2).join(" ") + "\\n");
for (const line of process.env.MORNDO_FAKE_REPORT.split("\\n")) if (line !== "") console.log(line);
`;

type Post = { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };

class FakeHub {
  server: Server | null = null;
  base = "";
  posts: Post[] = [];
  #answer: Record<string, unknown> = { status: "granted", lease_id: "lease-1-test", expires_at: 4_102_444_800 };
  answerWith(a: Record<string, unknown>) { this.#answer = a; }
  start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        this.posts.push({ path: req.url ?? "", headers: req.headers, body });
        const head = { "content-type": "application/json" };
        if (req.url === "/api/agent/usage/lease") { res.writeHead(200, head); res.end(JSON.stringify(this.#answer)); return; }
        res.writeHead(200, head); res.end(JSON.stringify({ ok: true }));
      });
    });
    return new Promise(resolve => this.server!.listen(0, "127.0.0.1", () => {
      this.base = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
      resolve();
    }));
  }
  of(path: string): Post[] { return this.posts.filter(p => p.path === path); }
}

let hub = new FakeHub();
let dir = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-usage-collector-"));
  writeFileSync(join(dir, "fake-claude.mjs"), FAKE_CLI);
  writeFileSync(join(dir, "token"), `${TOKEN}\n`);
  hub = new FakeHub();
  await hub.start();
});
afterEach(async () => { await new Promise<void>(r => hub.server!.close(() => r())); rmSync(dir, { recursive: true, force: true }); });

async function pass(opts: { report?: string } = {}) {
  const config = join(dir, "usage-claude.json");
  writeFileSync(config, `${JSON.stringify({ hub: hub.base, tokenFile: join(dir, "token"), node: "pc", accounts: { "seat-a": { configDir: "/cfg/seat-a" } } })}\n`);
  const out: string[] = [];
  const err: string[] = [];
  const code = await collectOnce({
    configPath: config,
    env: { ...process.env, MORNDO_CLAUDE_BIN: join(dir, "fake-claude.mjs"), MORNDO_FAKE_REPORT: opts.report ?? SESSION_ONLY },
    stdout: t => out.push(t),
    stderr: t => err.push(t),
    now: Date.now,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("the collector's one pass (plan 4.4)", () => {
  it("a granted lease spawns one read and posts its reading with the lease id", async () => {
    hub.answerWith({ status: "granted", lease_id: "lease-1-test", expires_at: 4_102_444_800 });
    const { code, out, err } = await pass();
    expect(code).toBe(0);
    const asks = hub.of("/api/agent/usage/lease");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.body).toEqual({ account: "seat-a", source: "claude-usage", node: "pc" });
    expect(asks[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const readings = hub.of("/api/agent/usage/readings");
    expect(readings).toHaveLength(1);
    const body = readings[0]?.body ?? {};
    expect(body.source).toBe("claude-usage");
    expect(body.node).toBe("pc");
    expect(body.lease_id).toBe("lease-1-test");
    expect(readings[0]?.headers["x-morndo-account"]).toBe("seat-a");
    expect(readings[0]?.headers["x-morndo-lane"]).toBe("usage-claude");
    expect(body.windows).toEqual([{ id: "five_hour", used_percent: 42, resets_at: Math.floor(Date.parse("2026-10-24T15:00:00Z") / 1000), length_mins: 300, rolling: false, note: null }]);
    expect(out).toBe("");
    expect(err).toBe("");
  });

  it("a denied or fresh lease spawns nothing and posts no reading", async () => {
    hub.answerWith({ status: "denied", reason: "cooldown", retry_after_s: 30 });
    const { code } = await pass();
    expect(code).toBe(0);
    expect(hub.of("/api/agent/usage/readings")).toHaveLength(0);
    // Nothing spawned: the fake's log (it appends a line per invocation) was never written. Round 2: this was
    // readFileSync(...)).toBe("") — a file the fake only ever appends to can never read empty, and never exists
    // when nothing spawned; the fix keeps the check's intent, no spawn at all.
    expect(existsSync(join(dir, "spawn.log"))).toBe(false);
    hub.posts = [];
    hub.answerWith({ status: "fresh", captured_at: 4_102_444_000 });
    const again = await pass();
    expect(again.code).toBe(0);
    expect(hub.of("/api/agent/usage/readings")).toHaveLength(0);
    expect(existsSync(join(dir, "spawn.log"))).toBe(false);
  });

  it("a failed read posts its failure with the reason and the lease id", async () => {
    const { code } = await pass({ report: SIGNED_OUT });
    expect(code).toBe(0);
    const readings = hub.of("/api/agent/usage/readings");
    expect(readings).toHaveLength(1);
    expect(readings[0]?.body.failure).toEqual({ reason: "signed_out", hint: null });
    expect(readings[0]?.body.lease_id).toBe("lease-1-test");
  });

  it("the token is read from its file and never printed", async () => {
    const { out, err } = await pass();
    expect(out).not.toContain(TOKEN);
    expect(err).not.toContain(TOKEN);
  });
});

// S6 (plan 4.6): a codex account in the same config. The fake app server a test writes stands in for the binary
// (selected by MORNDO_CODEX_BIN), its CODEX_HOME is the directory it and its answer live in. Never the real codex.
function codexServer(mode = "ok", limits: unknown = CODEX_PLUS): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-collector-"));
  const bin = join(dir, "codex.mjs");
  copyFileSync(FAKE_APP_SERVER, bin);
  writeFileSync(join(dir, "limits.json"), JSON.stringify(limits));
  writeFileSync(join(dir, "mode"), mode);
  return { bin, dir };
}

async function codexPassOnce(o: { mode?: string; accounts?: Record<string, unknown> } = {}) {
  const server = codexServer(o.mode);
  const config = join(dir, "usage-claude.json");
  writeFileSync(config, `${JSON.stringify({ hub: hub.base, tokenFile: join(dir, "token"), node: "pc", accounts: o.accounts ?? { "codex-a": { kind: "codex", codexHome: server.dir } } })}\n`);
  const err: string[] = [];
  const code = await collectOnce({
    configPath: config,
    env: { ...process.env, MORNDO_CODEX_BIN: server.bin, MORNDO_FAKE_REPORT: SESSION_ONLY, MORNDO_CLAUDE_BIN: join(dir, "fake-claude.mjs") },
    stderr: t => err.push(t),
    now: Date.now,
  });
  return { code, err: err.join("") };
}

describe("the collector's codex account (S6, plan 4.6)", () => {
  it("a granted lease for source app-server reads the app server and posts the reading with the lease id", async () => {
    hub.answerWith({ status: "granted", lease_id: "lease-9-test", expires_at: 4_102_444_800 });
    const { code, err } = await codexPassOnce();
    expect(code).toBe(0);
    expect(err).toBe("");
    const asks = hub.of("/api/agent/usage/lease");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.body).toEqual({ account: "codex-a", source: "app-server", node: "pc" });
    expect(asks[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const readings = hub.of("/api/agent/usage/readings");
    expect(readings).toHaveLength(1);
    const body = readings[0]?.body ?? {};
    expect(body.source).toBe("app-server");
    expect(body.node).toBe("pc");
    expect(body.lease_id).toBe("lease-9-test");
    expect(body.plan).toBe("plus");
    expect(body.windows).toEqual([
      { id: "five_hour", used_percent: 42, resets_at: 1_893_456_000, length_mins: 300, rolling: false, note: null },
      { id: "seven_day", used_percent: 17, resets_at: 1_893_888_000, length_mins: 10_080, rolling: false, note: null },
    ]);
    expect(body.every_s).toBe(900);                        // 42% at most: the idle interval
    expect(body.identity).toBe(null);                      // the answer names no account id: null, never a guess
    expect(readings[0]?.headers["x-morndo-account"]).toBe("codex-a");
  });

  it("a refused read posts its failure classified by its words, with a redacted hint and the lease id", async () => {
    const { code } = await codexPassOnce({ mode: "error" });
    expect(code).toBe(0);
    const readings = hub.of("/api/agent/usage/readings");
    expect(readings).toHaveLength(1);
    const failure = readings[0]?.body.failure as { reason?: string; hint?: string } | undefined;
    expect(failure?.reason).toBe("signed_out");
    expect(readings[0]?.body.lease_id).toBe("lease-9-test");
    expect(JSON.stringify(failure?.hint)).not.toContain(tmpdir());   // no path of this box in the hint
  });

  it("an answer in a shape the reader does not know is an unknown_screen failure", async () => {
    const { code } = await codexPassOnce({ mode: "garbage" });
    expect(code).toBe(0);
    const readings = hub.of("/api/agent/usage/readings");
    expect(readings).toHaveLength(1);
    expect((readings[0]?.body.failure as { reason?: string } | undefined)?.reason).toBe("unknown_screen");
  });

  it("a claude and a codex account in one config each ask and post under their own source", async () => {
    const server = codexServer();
    const config = join(dir, "usage-claude.json");
    writeFileSync(config, `${JSON.stringify({
      hub: hub.base, tokenFile: join(dir, "token"), node: "pc",
      accounts: { "seat-a": { configDir: "/cfg/seat-a" }, "codex-a": { kind: "codex", codexHome: server.dir } },
    })}\n`);
    const code = await collectOnce({
      configPath: config,
      env: { ...process.env, MORNDO_CLAUDE_BIN: join(dir, "fake-claude.mjs"), MORNDO_FAKE_REPORT: SESSION_ONLY, MORNDO_CODEX_BIN: server.bin },
      now: Date.now,
    });
    expect(code).toBe(0);
    expect(hub.of("/api/agent/usage/lease").map(p => p.body)).toEqual([
      { account: "seat-a", source: "claude-usage", node: "pc" },
      { account: "codex-a", source: "app-server", node: "pc" },
    ]);
    expect(hub.of("/api/agent/usage/readings").map(p => p.body.source)).toEqual(["claude-usage", "app-server"]);
  });
});
