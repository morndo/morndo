// `morndo-keys pool` and a turn that goes on elsewhere (ADR-0029, §6.8). A scratch node: temporary homes, a fake CLI that
// plays a turn from a `mode` file in each account's home, and a synthetic API key in the parent environment that no child may
// ever see. Nothing here touches ~/.codex, a real sign-in or a port of the running system.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { UsageReportBody } from "@morndo/protocol";
import { runIntoHead } from "../../../test/pipe-child.ts";
import { run } from "../src/cli.ts";
import { awaitSeat, isNight, waitDelay, waitLimit } from "../src/pool-cli.ts";

const ROOT = join(import.meta.dirname, "../../..");
const catalog = join(ROOT, "packages/protocol/catalog/vendors.json");
const FIXTURES = join(import.meta.dirname, "fixtures");
const MAIN = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Out = { code: number; stdout: string; stderr: string };
type Run = { argv: string[]; member: string; sessionsDir: string; locksDir: string; names: string[] };
type Event = { type: string; thread_id?: string; message?: string; error?: { message?: string } };
const events = (text: string): Event[] => text.trim().split("\n").filter(l => l !== "").map(l => JSON.parse(l) as Event);

type Node = {
  env: NodeJS.ProcessEnv;
  dir: string;
  cli(args: string[], extra?: NodeJS.ProcessEnv): Promise<Out>;
  runs(member: string): Run[];
  setMode(member: string, mode: string): void;
  home(member: string): string;
};

// A node whose pool has the given members, each signed in to a home of its own (`mode` says how its fake turn goes).
async function poolNode(opts: { mode?: "pinned" | "rotate"; members: Record<string, string>; ack?: boolean; account?: unknown; defaultMember?: string }): Promise<Node> {
  const dir = scratch("morndo-pool-cli-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  copyFileSync(join(FIXTURES, "fake-codex-exec.mjs"), join(bin, "exec.mjs"));
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), join(bin, "fake-codex-app-server.mjs"));
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "exec.mjs")}" "$@"\n`);
  chmodSync(join(bin, "codex"), 0o755);
  const workspace = join(dir, "work");
  mkdirSync(workspace);
  const env: NodeJS.ProcessEnv = {
    ...process.env, MORNDO_CONNECTIONS_HOME: join(dir, "home"), MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, MORNDO_POOL_DATA: join(dir, "pool"),
    MORNDO_CODEX_BIN: join(bin, "codex"), TZ: "UTC", PWD: workspace, HOME: dir,
    CODEX_API_KEY: "sk-synthetic-pool-0001", CODEX_ACCESS_TOKEN: "synthetic-pool-0002", OPENAI_API_KEY: "sk-synthetic-pool-0003",
  };
  const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Out> => {
    let stdout = "";
    let stderr = "";
    const code = await run(args, { ...env, ...extra }, { stdin: "", stdout: t => { stdout += t; }, stderr: t => { stderr += t; } });
    return { code, stdout, stderr };
  };
  const home = (member: string): string => join(dir, "accounts", member);
  for (const [member, mode] of Object.entries(opts.members)) {
    mkdirSync(home(member), { recursive: true, mode: 0o700 });
    writeFileSync(join(home(member), "auth.json"), "{}", { mode: 0o600 });
    writeFileSync(join(home(member), "config.toml"), 'cli_auth_credentials_store = "file"\n');
    writeFileSync(join(home(member), "mode"), mode);
    const limits = JSON.parse(readFileSync(join(FIXTURES, "codex", "rate-limits-pool.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(home(member), "limits.json"), JSON.stringify({ ...limits, accountId: `acct-synthetic-${member}` }));
    writeFileSync(join(home(member), "account.json"), JSON.stringify(opts.account ?? JSON.parse(readFileSync(join(FIXTURES, "codex", "account-plus.json"), "utf8"))));
    expect((await cli(["add", member, "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", home(member)])).code).toBe(0);
    if (opts.ack !== false) expect((await cli(["ack", member, "--by", "test"])).code).toBe(0);
    expect((await cli(["pool", "add", member])).code, member).toBe(0);
  }
  if (opts.defaultMember) expect((await cli(["pool", "set", "defaultMember", opts.defaultMember])).code).toBe(0);
  if (opts.mode === "rotate") expect((await cli(["pool", "mode", "rotate", "--runtime", "codex", "--by", "principal@example.com"])).code).toBe(0);
  const runs = (member: string): Run[] => {
    const file = join(home(member), "runs.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(l => l !== "").map(l => JSON.parse(l) as Run) : [];
  };
  return { env, dir, cli, runs, home, setMode: (member, mode) => writeFileSync(join(home(member), "mode"), mode) };
}

const turn = (extra: string[] = []): string[] => ["pool", "exec", "--runtime", "codex", ...extra, "--", "exec", "--json", "-m", "model-x", "-s", "danger-full-access", "Make hello.txt"];
const until = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 50));
  }
};

describe("morndo-keys pool exec", () => {
  it("moves a turn cut off by the usage limit to the other account, as the same session, and hides the failed line", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "ok" } });
    const out = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "--json", "-m", "model-x", "-s", "danger-full-access", "Make hello.txt"]);
    expect(out.code, out.stderr).toBe(0);
    const seen = events(out.stdout);
    expect(seen.filter(e => e.type === "turn.failed")).toEqual([]);
    const threads = [...new Set(seen.filter(e => e.type === "thread.started").map(e => e.thread_id))];
    expect(threads).toHaveLength(1);
    expect(seen.some(e => e.type === "error" && /codex-a reached its usage limit; this turn goes on as the same session on codex-b/.test(e.message ?? ""))).toBe(true);
    expect(seen.at(-1)?.type).toBe("turn.completed");
    const [b] = t.runs("codex-b");
    expect(b?.argv.slice(0, 3)).toEqual(["exec", "resume", threads[0]]);
    expect(b?.argv).toContain('sandbox_mode="danger-full-access"');
    expect(b?.argv).not.toContain("-s");
    expect(b?.argv.at(-1)).toMatch(/^\[pool\] The turn before this one stopped[\s\S]*Its request was:\nMake hello\.txt$/);
    expect(b?.sessionsDir).toBe(t.runs("codex-a")[0]?.sessionsDir);
    expect(b?.locksDir).toBe(t.runs("codex-a")[0]?.locksDir);
    expect(b?.names.filter(n => /KEY|TOKEN/.test(n))).toEqual([]);
    expect(t.runs("codex-a")[0]?.names.filter(n => /KEY|TOKEN/.test(n))).toEqual([]);
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { seats: { member: string; state: string }[] };
    expect(list.seats.find(s => s.member === "codex-a")?.state).toBe("out");
  });

  it("pinned: needs a default or a pin, runs on it, and never moves at the limit", async () => {
    const none = await poolNode({ mode: "pinned", members: { "codex-a": "ok", "codex-b": "ok" } });
    const bare = await none.cli(turn());
    expect([bare.code, bare.stderr]).toEqual([1, "no default member: set one with morndo-keys pool set defaultMember <name>\n"]);
    const pinned = await none.cli(turn(["--account", "codex-a"]));
    expect(pinned.code, pinned.stderr).toBe(0);
    const list = JSON.parse((await none.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { placements: { member: string; pinned: boolean }[] };
    expect(list.placements).toMatchObject([{ member: "codex-a", pinned: true }]);

    const limited = await poolNode({ mode: "pinned", members: { "codex-a": "limit", "codex-b": "ok" } });
    const out = await limited.cli(turn(["--account", "codex-a"]));
    expect(out.code).toBe(1);
    expect(events(out.stdout).filter(e => e.type === "turn.failed")).toHaveLength(1);
    expect(limited.runs("codex-b")).toEqual([]);
    const seats = JSON.parse((await limited.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { seats: { member: string; state: string }[] };
    expect(seats.seats.find(s => s.member === "codex-a")?.state).toBe("out");
  });

  it("never lets two writers on one session", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, defaultMember: "codex-a" });
    const first = await t.cli(turn());
    expect(first.code, first.stderr).toBe(0);
    const thread = events(first.stdout).find(e => e.type === "thread.started")?.thread_id ?? "";
    t.setMode("codex-a", "slow");
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "pool", "exec", "--runtime", "codex", "--", "exec", "resume", thread, "--json", "next brief"], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<number | null>(resolve => child.on("close", resolve));
    try {
      await until(() => t.runs("codex-a").length === 2);
      const second = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "resume", thread, "--json", "again"]);
      expect(second.code).toBe(1);
      expect(second.stderr).toMatch(new RegExp(`^session ${thread} is being written by pid \\d+\\n$`));
      expect(t.runs("codex-a")).toHaveLength(2);
    } finally { child.kill("SIGKILL"); await closed; }
  }, 30_000);

  it("stops the turn when the reader of its output is gone, instead of running on to the end", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "stream" }, defaultMember: "codex-a" });
    const started = Date.now();
    const ran = await runIntoHead([MAIN, ...turn()], t.env);
    expect(Date.now() - started).toBeLessThan(9_000);                                    // the fake turn is 15 s
    expect(ran.code).toBe(143);                                                          // stopped as a SIGTERM stops it
    const pid = Number(readFileSync(join(t.home("codex-a"), "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(t.home("codex-a"), "finished"))).toBe(false);
  }, 30_000);

  it("kills an agent that ignores SIGTERM once the reader is gone", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "stubborn" }, defaultMember: "codex-a" });
    const started = Date.now();
    const ran = await runIntoHead([MAIN, ...turn()], t.env);
    expect(Date.now() - started).toBeLessThan(9_000);                                    // SIGKILL follows after 3 s; the turn is 15 s
    expect(ran.code).toBe(143);
    const pid = Number(readFileSync(join(t.home("codex-a"), "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(t.home("codex-a"), "finished"))).toBe(false);
  }, 40_000);

  it("kills what the turn left behind once the grace has passed, though the agent itself has gone", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "orphan" }, defaultMember: "codex-a" });
    const started = Date.now();
    const ran = await runIntoHead([MAIN, ...turn()], t.env);
    expect(ran.code).toBe(143);
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(() => process.kill(Number(readFileSync(join(t.home("codex-a"), "inner-pid"), "utf8")), 0)).toThrow();
  }, 40_000);

  it("ends with the exit code that matches the lease: a SIGTERM as the turn finishes is 0 and done, or 143 and failed", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, defaultMember: "codex-a" });
    const outcomes = async (): Promise<string[]> => (await t.cli(["log", "codex-a"])).stdout.split("\n").filter(l => l.includes('"LeaseClosed"')).map(l => (JSON.parse(l) as { outcome: string }).outcome);
    for (let round = 0; round < 5; round++) {
      const seen = t.runs("codex-a").length;
      const bin = spawn(process.execPath, ["--no-warnings", MAIN, ...turn()], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
      bin.stdout.resume();
      bin.stderr.resume();
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => bin.once("close", (code, signal) => resolve({ code, signal })));
      await until(() => t.runs("codex-a").length > seen);
      try { bin.kill("SIGTERM"); } catch { /* it is already gone */ }
      const end = await closed;
      const outcome = (await outcomes()).at(-1);
      if (end.code === 0 || end.code === null) expect(outcome, `round ${round}: ${JSON.stringify(end)}`).toBe("done");
      else expect({ end, outcome }, `round ${round}`).toEqual({ end: { code: 143, signal: null }, outcome: "failed" });
    }
  }, 60_000);

  it("stops the turn on SIGHUP, as run does: 129, the agent gone, the lease failed and the seat free", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "stream" }, defaultMember: "codex-a" });
    const bin = spawn(process.execPath, ["--no-warnings", MAIN, ...turn()], { env: t.env, stdio: ["ignore", "pipe", "pipe"] });
    bin.stdout.resume();
    bin.stderr.resume();
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => bin.once("close", (code, signal) => resolve({ code, signal })));
    await until(() => existsSync(join(t.home("codex-a"), "pid")));
    const started = Date.now();
    bin.kill("SIGHUP");
    expect(await closed).toEqual({ code: 129, signal: null });
    expect(Date.now() - started).toBeLessThan(9_000);                                    // the fake turn is 15 s
    expect(() => process.kill(Number(readFileSync(join(t.home("codex-a"), "pid"), "utf8")), 0)).toThrow();
    expect(existsSync(join(t.home("codex-a"), "finished"))).toBe(false);
    const closedLeases = (await t.cli(["log", "codex-a"])).stdout.split("\n").filter(l => l.includes('"LeaseClosed"')).map(l => (JSON.parse(l) as { outcome: string }).outcome);
    expect(closedLeases).toEqual(["failed"]);
    t.setMode("codex-a", "ok");
    const next = await t.cli(turn());                                                    // the claim was ended: the seat is free
    expect([next.code, next.stderr]).toEqual([0, ""]);
  }, 40_000);

  it("does not start the agent when the reader goes after the seat is won", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "slow-status" }, defaultMember: "codex-a" });
    const marker = join(t.home("codex-a"), "status-started");
    rmSync(marker, { force: true });
    const gone = new AbortController();
    const running = run(turn(), t.env, { stdin: "", stdout: () => {}, stderr: () => {}, gone: gone.signal });
    await until(() => existsSync(marker));
    gone.abort();
    expect(await running).toBe(143);
    expect(t.runs("codex-a")).toHaveLength(0);
    expect(existsSync(join(t.home("codex-a"), "finished"))).toBe(false);
  }, 40_000);

  it("runs one turn at a time per account", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "slow" }, defaultMember: "codex-a" });
    const first = t.cli(turn(["--lane", "lane-1"]));
    await until(() => t.runs("codex-a").length === 1);
    const second = await t.cli(turn(["--lane", "lane-2"]), { MORNDO_POOL_WAIT_MS: "500" });
    expect(events(second.stdout).filter(e => /\[pool\] waiting: a turn runs on codex-a/.test(e.message ?? ""))).toHaveLength(1);
    expect([second.code, second.stderr]).toEqual([1, "codex-a is busy\n"]);
    expect((await first).code).toBe(0);
    expect(t.runs("codex-a")).toHaveLength(1);
  }, 30_000);

  it("says when an account is back when every account is out, and then refuses without starting the CLI", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "limit" } });
    const one = await t.cli(turn());
    expect(one.code).toBe(1);
    const last = events(one.stdout).at(-1);
    expect(last?.type).toBe("turn.failed");
    expect(last?.error?.message).toContain("every pool account");
    expect([t.runs("codex-a").length, t.runs("codex-b").length]).toEqual([1, 1]);
    const two = await t.cli(turn());
    expect(two.code).toBe(1);
    expect(events(two.stdout).at(-1)?.error?.message).toContain("every pool account");
    expect([t.runs("codex-a").length, t.runs("codex-b").length]).toEqual([1, 1]);
  });

  it("hands off to a new session when the conversation can't be read under the other account", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "encrypted" } });
    const out = await t.cli(turn());
    expect(out.code, out.stderr).toBe(0);
    const thread = events(out.stdout).find(e => e.type === "thread.started")?.thread_id ?? "";
    const runs = t.runs("codex-b");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(runs[1]?.argv[0]).toBe("exec");
    expect(runs[1]?.argv[1]).not.toBe("resume");
    expect(runs[1]?.argv.at(-1)).toContain(thread);
    expect(runs[1]?.argv.at(-1)).toContain("git status");
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { settings: { moveBy: string } };
    expect(list.settings.moveBy).toBe("handoff");
    const db = new Database(join(t.dir, "home", "connections.db"), { readonly: true });
    try {
      const body = JSON.parse(db.prepare("SELECT body FROM pool WHERE runtime = 'codex'").pluck().get() as string) as { events: { type: string }[] };
      expect(body.events.some(e => e.type === "MoveByChanged")).toBe(true);
    } finally { db.close(); }
  });

  it("a workspace out of credits marks the account and the turn goes on elsewhere, so the next new lane starts on the other account (T-250)", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "credits", "codex-b": "ok" } });
    const first = await t.cli(turn());
    expect(first.code, first.stderr).toBe(0);
    expect(events(first.stdout).filter(e => e.type === "turn.failed")).toEqual([]);
    expect(events(first.stdout).at(-1)?.type).toBe("turn.completed");
    const second = await t.cli(turn());
    expect(second.code, second.stderr).toBe(0);
    expect(t.runs("codex-a")).toHaveLength(1);
    expect(t.runs("codex-b")).toHaveLength(2);
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { seats: { member: string; state: string }[] };
    expect(list.seats.find(s => s.member === "codex-a")?.state).toBe("out");
  });

  it("a new turn in rotate mode starts on the account whose reading says it can run, and a pin still runs where it points (T-250)", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "ok", "codex-b": "ok" } });
    const limits = JSON.parse(readFileSync(join(t.home("codex-a"), "limits.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(t.home("codex-a"), "limits.json"), JSON.stringify({ ...limits, ordinaryUsageAllowed: false }));
    expect((await t.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    const out = await t.cli(turn());
    expect(out.code, out.stderr).toBe(0);
    expect([t.runs("codex-a").length, t.runs("codex-b").length]).toEqual([0, 1]);
    const pinned = await t.cli(turn(["--account", "codex-a"]));
    expect(pinned.code, pinned.stderr).toBe(0);
    expect(t.runs("codex-a")).toHaveLength(1);
  });

  it("a new turn in rotate mode skips an account at or below its switch point (T-250)", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "ok", "codex-b": "ok" } });
    const limits = JSON.parse(readFileSync(join(t.home("codex-a"), "limits.json"), "utf8")) as { rateLimits: { primary: Record<string, unknown> } } & Record<string, unknown>;
    writeFileSync(join(t.home("codex-a"), "limits.json"), JSON.stringify({ ...limits, rateLimits: { ...limits.rateLimits, primary: { ...limits.rateLimits.primary, usedPercent: 98 } } }));
    expect((await t.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    const out = await t.cli(turn());
    expect(out.code, out.stderr).toBe(0);
    expect([t.runs("codex-a").length, t.runs("codex-b").length]).toEqual([0, 1]);
  });
});

describe("morndo-keys pool exec: what a turn does when it can't simply run", () => {
  it("refuses `exec resume --last`, which names no session, before any claim or run", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, defaultMember: "codex-a" });
    const out = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "resume", "--last", "continue"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("--last");
    expect(t.runs("codex-a")).toEqual([]);
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { placements: unknown[] };
    expect(list.placements).toEqual([]);
  });

  it("finds the session after options and keys the claim by it", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, defaultMember: "codex-a" });
    const first = await t.cli(turn());
    const thread = events(first.stdout).find(e => e.type === "thread.started")?.thread_id ?? "";
    const again = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "resume", "--json", "-m", "model-x", thread, "more"]);
    expect(again.code, again.stderr).toBe(0);
    expect(t.runs("codex-a").at(-1)?.argv.slice(0, 2)).toEqual(["exec", "resume"]);
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { placements: { session: string }[] };
    expect(list.placements.map(p => p.session)).toEqual([thread]);
  });

  it("tells a busy next account as busy, never as every account out, and waits for it", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "slow" } });
    const holder = t.cli(turn(["--lane", "lane-1", "--account", "codex-b"]));
    await until(() => t.runs("codex-b").length === 1);
    const impatient = await t.cli(turn(["--lane", "lane-2"]), { MORNDO_POOL_WAIT_MS: "300" });
    expect(impatient.code).toBe(1);
    expect(impatient.stdout).not.toContain("every pool account");
    expect(events(impatient.stdout).filter(e => e.type === "turn.failed")).toEqual([]);
    expect(impatient.stderr).toBe("codex-b is busy\n");
    expect(t.runs("codex-a")).toHaveLength(1);
    await holder;
  }, 30_000);

  it("goes on with the busy account once it is free", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "slow" } });
    const holder = t.cli(turn(["--lane", "lane-1", "--account", "codex-b"]));
    await until(() => t.runs("codex-b").length === 1);
    const patient = await t.cli(turn(["--lane", "lane-2"]), { MORNDO_POOL_WAIT_MS: "20000" });
    expect(patient.code, patient.stderr).toBe(0);
    expect(events(patient.stdout).at(-1)?.type).toBe("turn.completed");
    expect(t.runs("codex-b")).toHaveLength(2);
    await holder;
  }, 40_000);

  it("hands a session off when it moves between turns after the pool learned that conversations can't cross", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "ok", "codex-b": "ok" } });
    const first = await t.cli(turn());
    const thread = events(first.stdout).find(e => e.type === "thread.started")?.thread_id ?? "";
    expect((await t.cli(["pool", "set", "moveBy", "handoff"])).code).toBe(0);
    expect((await t.cli(["pool", "retire", "codex-a"])).code).toBe(0);
    const moved = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "resume", thread, "--json", "next brief"]);
    expect(moved.code, moved.stderr).toBe(0);
    expect(events(moved.stdout).some(e => e.type === "error" && /codex-a can't take this turn \(retired\); it goes on as a new session on codex-b/.test(e.message ?? ""))).toBe(true);
    const [run] = t.runs("codex-b");
    expect(run?.argv[0]).toBe("exec");
    expect(run?.argv[1]).not.toBe("resume");
    expect(run?.argv.at(-1)).toContain(thread);
  });
});

describe("morndo-keys pool exec: waiting and the night", () => {
  it("backs off 200 ms, doubling to 5 s, until the wait is up, on a clock of its own", async () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(waitDelay)).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
    let t = 0;
    const slept: number[] = [];
    const waited: string[] = [];
    const busy = { ok: false as const, error: { kind: "busy" as const, member: "codex-a", problem: "codex-a is busy", exit: 1 as const } };
    const got = await awaitSeat({ attempt: () => busy, waitMs: 12_000, now: () => t, sleep: async ms => { slept.push(ms); t += ms; }, onWait: m => waited.push(m) });
    expect(got).toEqual(busy);
    expect(slept).toEqual([200, 400, 800, 1600, 3200, 5000, 800]);
    expect(waited).toEqual(["codex-a"]);
    expect(t).toBe(12_000);
  });

  it("stops at once for a refusal that is not busy, and succeeds as soon as the member is free", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const free = await awaitSeat({
      attempt: () => (++calls < 3 ? { ok: false as const, error: { kind: "busy" as const, member: "m", problem: "m is busy", exit: 1 as const } } : { ok: true as const, value: "seat" }),
      waitMs: 60_000, now: () => 0, sleep: async ms => { sleeps.push(ms); }, onWait: () => {},
    });
    expect(free).toEqual({ ok: true, value: "seat" });
    expect(sleeps).toEqual([200, 400]);
    const stop = await awaitSeat({ attempt: () => ({ ok: false as const, error: { kind: "no-default" as const, problem: "x", exit: 1 as const } }), waitMs: 60_000, now: () => 0, sleep: async () => { throw new Error("slept"); }, onWait: () => {} });
    expect(stop.ok).toBe(false);
  });

  it("takes a wait that is not a number of milliseconds as the default, and finds the night in a time zone", () => {
    expect([waitLimit(undefined), waitLimit("abc"), waitLimit(""), waitLimit("500")]).toEqual([1_800_000, 1_800_000, 1_800_000, 500]);
    const at = (h: number): number => Date.UTC(2026, 9, 15, h);
    expect([isNight(at(23), "UTC", "22-7"), isNight(at(3), "UTC", "22-7"), isNight(at(12), "UTC", "22-7")]).toEqual([true, true, false]);
    expect([isNight(at(21), "UTC", "22-7"), isNight(at(21), "Europe/Berlin", "22-7")]).toEqual([false, true]);          // 23:00 in Berlin
    expect(isNight(at(12), "UTC", "bad")).toBe(false);
  });
});

describe("morndo-keys pool read, check, advice and reset", () => {
  it("reports a member's windows for Home, and skips the read while a turn holds the account", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "slow" }, defaultMember: "codex-a" });
    const out = await t.cli(["pool", "read", "--runtime", "codex", "--member", "codex-a", "--report"]);
    expect(out.code, out.stderr).toBe(0);
    const body = JSON.parse(out.stdout) as { session_id: string; rate_limits: Record<string, { used_percentage: number }> };
    expect(UsageReportBody.safeParse(body).success).toBe(true);
    expect(body.session_id).toBe("codex-a-limits");
    expect([body.rate_limits.five_hour?.used_percentage, body.rate_limits.seven_day?.used_percentage]).toEqual([42, 17]);

    const turnRun = t.cli(turn());
    await until(() => t.runs("codex-a").length === 1);
    rmSync(join(t.home("codex-a"), "seen.json"), { force: true });
    const busy = await t.cli(["pool", "read", "--runtime", "codex", "--member", "codex-a", "--report"]);
    expect([busy.code, busy.stdout, busy.stderr]).toEqual([0, "", "codex-a: busy, read skipped\n"]);
    expect(existsSync(join(t.home("codex-a"), "seen.json"))).toBe(false);
    const usage = await t.cli(["usage", "--connection", "codex-a"]);
    expect([usage.code, usage.stdout, usage.stderr]).toEqual([1, "", "busy\n"]);
    await turnRun;
  }, 30_000);

  it("spends a reset credit only on the principal's command, and only one module names how", async () => {
    const t = await poolNode({ mode: "pinned", members: { "codex-a": "ok" } });
    expect((await t.cli(["pool", "reset", "--runtime", "codex", "--member", "codex-a"])).code).toBe(1);
    expect((await t.cli(["pool", "reset", "--runtime", "codex", "--member", "codex-a", "--by", "principal@example.com"])).code).toBe(1);
    const spent = await t.cli(["pool", "reset", "--runtime", "codex", "--member", "codex-a", "--by", "principal@example.com", "--yes"]);
    expect([spent.code, spent.stdout]).toEqual([0, "reset\n"]);
    const db = new Database(join(t.dir, "home", "connections.db"), { readonly: true });
    try {
      const body = JSON.parse(db.prepare("SELECT body FROM pool WHERE runtime = 'codex'").pluck().get() as string) as { events: { type: string; by?: string }[] };
      expect(body.events.filter(e => e.type === "ResetSpent")).toMatchObject([{ by: "principal@example.com" }]);
    } finally { db.close(); }

    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") || path.endsWith(".svelte")) sources.push(path);
      }
    };
    for (const base of ["apps/connections/src", "apps/hub/src", "apps/node-agent/src"]) walk(join(ROOT, base));
    for (const pkg of readdirSync(join(ROOT, "packages"))) if (existsSync(join(ROOT, "packages", pkg, "src"))) walk(join(ROOT, "packages", pkg, "src"));
    const names = (needle: string): string[] => sources.filter(f => readFileSync(f, "utf8").includes(needle)).map(f => relative(ROOT, f));
    expect(names("rateLimitResetCredit/consume")).toEqual(["apps/connections/src/adapters/codex-reset.ts"]);
    expect(names("codex-reset.ts")).toEqual(["apps/connections/src/pool-cli.ts"]);
  });

  it("answers the engine layer's probe", async () => {
    const ok = await poolNode({ mode: "pinned", members: { "codex-a": "ok" } });
    expect((await ok.cli(["pool", "check", "--runtime", "codex"])).code).toBe(1);
    expect((await ok.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    expect((await ok.cli(["pool", "check", "--runtime", "codex"])).code).toBe(0);

    const unacked = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, ack: false });
    expect((await unacked.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    expect((await unacked.cli(["pool", "check", "--runtime", "codex"])).code).toBe(1);

    const out = await poolNode({ mode: "pinned", members: { "codex-a": "ok" }, account: { account: null, requiresOpenaiAuth: true } });
    expect((await out.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    expect((await out.cli(["pool", "check", "--runtime", "codex"])).code).toBe(1);
  });

  it("prints the advice once a day when asked to notify", async () => {
    const posts: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", c => { body += String(c); });
      req.on("end", () => { posts.push(body); res.end("ok"); });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/notify`;
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "limit" } });
    expect((await t.cli(["pool", "read", "--runtime", "codex", "--all"])).code).toBe(0);
    await t.cli(turn());
    await t.cli(turn());
    const first = await t.cli(["pool", "advice", "--runtime", "codex", "--notify"], { MORNDO_POOL_NOTIFY_URL: url });
    expect(first.stdout).toContain("Reset credit:");
    const second = await t.cli(["pool", "advice", "--runtime", "codex", "--notify"], { MORNDO_POOL_NOTIFY_URL: url });
    expect(second.stdout).toBe("");
    expect(posts).toHaveLength(1);
  }, 30_000);
});

describe("morndo-keys pool set readingMaxAgeMinutes (T-614)", () => {
  it("sets it like the other numbers, and refuses a value that is not a number", async () => {
    const t = await poolNode({ mode: "rotate", members: { "codex-a": "ok" } });
    const set = await t.cli(["pool", "set", "readingMaxAgeMinutes", "45"]);
    expect(set.code, set.stderr).toBe(0);
    const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { settings: { readingMaxAgeMinutes: number } };
    expect(list.settings.readingMaxAgeMinutes).toBe(45);
    expect((await t.cli(["pool", "set", "readingMaxAgeMinutes", "soon"])).code).toBe(1);
  });
});
