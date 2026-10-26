// The spawn half (AT-32's node half, AT-41's lock half; plan 4.4): the read runs the CLI's own headless /usage under
// the account's config directory, with no token variable in the child, its own process group killed at the timeout,
// one read at a time on the node, and a per-account lock file a stale holder loses. The CLI here is a fake a test
// writes into a temp directory (never the real claude binary), controlled by files beside it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaude } from "../src/adapters/usage-claude-run.ts";

const SESSION_ONLY = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "fix-1", cwd: "/tmp" }),
  JSON.stringify({ type: "assistant", message: { content: [] }, usage_report: { session: { total_cost_usd: 1, total_api_duration_ms: 1, total_duration_ms: 2, total_lines_added: 1, total_lines_removed: 0, model_usage: {} }, rate_limits: { limits: [{ kind: "session", group: "session", percent: 42, resets_at: "2026-10-24T15:00:00Z", scope: null, severity: "normal", is_active: true }], extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: "EUR" } } } }),
  JSON.stringify({ type: "result", is_error: false, num_turns: 0, total_cost_usd: 0, duration_ms: 1000 }),
];
const SIGNED_OUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "fix-2", cwd: "/tmp" }),
  JSON.stringify({ type: "result", subtype: "error", is_error: true, num_turns: 0, result: "please login again (401)" }),
];

// The fake CLI: controlled by the files beside it — fixture.jsonl (what it prints), sleep-ms (how long it waits),
// group (spawn a child that outlives it, so the group kill is observable), signed-in (its `auth status` answer) —
// and it records every spawn and the environment it saw.
const FAKE = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const dir = import.meta.dirname;
const log = (name, text) => appendFileSync(join(dir, name), text + "\\n");
if (process.argv[2] === "auth") process.exit(existsSync(join(dir, "signed-in")) ? 0 : 1);
const tokens = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter(k => k in process.env);
log("env.jsonl", JSON.stringify({ tokens, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }));
log("spawn.log", JSON.stringify(process.argv.slice(2)));
if (existsSync(join(dir, "group"))) {
  const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  log("group.pid", String(kid.pid));
}
const ms = Number(existsSync(join(dir, "sleep-ms")) ? readFileSync(join(dir, "sleep-ms"), "utf8").trim() : "0");
if (ms > 0) { log("run.log", "start"); await new Promise(r => setTimeout(r, ms)); log("run.log", "end"); }
for (const line of readFileSync(join(dir, "fixture.jsonl"), "utf8").split("\\n").filter(l => l !== "")) console.log(line);
`;

type Rig = { dir: string; bin: string; lines: (name: string) => string[]; count: (name: string) => number; seen: () => { tokens: string[]; configDir: string | null }[] };

function rig(fixture: readonly string[], o: { sleepMs?: number; group?: boolean } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "morndo-usage-claude-"));
  const bin = join(dir, "fake-claude.mjs");
  writeFileSync(bin, FAKE);
  writeFileSync(join(dir, "fixture.jsonl"), fixture.join("\n") + "\n");
  if (o.sleepMs) writeFileSync(join(dir, "sleep-ms"), String(o.sleepMs));
  if (o.group) writeFileSync(join(dir, "group"), "");
  return {
    dir, bin,
    lines: name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(l => l !== "") : []),
    count: name => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(l => l !== "").length : 0),
    seen: () => r.lines("env.jsonl").map(l => JSON.parse(l) as { tokens: string[]; configDir: string | null }),
  };
}

let r: Rig;      // one rig per test; removed after
beforeEach(() => { r = rig(SESSION_ONLY); });
afterEach(() => { rmSync(r.dir, { recursive: true, force: true }); });

const gone = () => {
  const probe = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  return probe.pid ?? 1;      // a pid that has exited before the read runs
};

describe("reads through the CLI's own /usage (AT-32)", () => {
  it("maps the report the fake prints, under the account's config directory", async () => {
    const out = await readClaude({ account: "seat-a", configDir: "/cfg/seat-a", bin: r.bin, now: Date.now, lockDir: r.dir });
    expect(out).toEqual({ ok: true, windows: [{ id: "five_hour", used_percent: 42, resets_at: Math.floor(Date.parse("2026-10-24T15:00:00Z") / 1000), length_mins: 300, rolling: false, note: null }] });
  });

  it("the bin comes from MORNDO_CLAUDE_BIN when opts names none", async () => {
    const saved = process.env.MORNDO_CLAUDE_BIN;
    process.env.MORNDO_CLAUDE_BIN = r.bin;
    try {
      const out = await readClaude({ account: "seat-a", configDir: "/cfg/seat-a", now: Date.now, lockDir: r.dir });
      expect(out.ok).toBe(true);
      expect(r.count("spawn.log")).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.MORNDO_CLAUDE_BIN; else process.env.MORNDO_CLAUDE_BIN = saved;
    }
  });

  it("runs the CLI headless with no tools at all: --tools followed by an empty argument (fix round, finding 4)", async () => {
    await readClaude({ account: "seat-a", configDir: "/cfg/seat-a", bin: r.bin, now: Date.now, lockDir: r.dir });
    const argv = JSON.parse(r.lines("spawn.log")[0]!) as string[];
    expect(argv.slice(0, 4)).toEqual(["-p", "/usage", "--tools", ""]);
  });

  it("no token variable reaches the child; the config directory does", async () => {
    const saved = { a: process.env.CLAUDE_CODE_OAUTH_TOKEN, b: process.env.ANTHROPIC_API_KEY, c: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok-code";
    process.env.ANTHROPIC_API_KEY = "tok-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-auth";
    try {
      await readClaude({ account: "seat-a", configDir: "/cfg/seat-a", bin: r.bin, now: Date.now, lockDir: r.dir });
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k as keyof typeof saved]; else process.env[k as keyof typeof saved] = v;
    }
    expect(r.seen()[0]?.tokens).toEqual([]);
    expect(r.seen()[0]?.configDir).toBe("/cfg/seat-a");
  });
});

describe("rationed on one node (AT-32, AT-41's lock)", () => {
  it("two reads of one account at once spawn once: the second finds the live lock", async () => {
    const slow = rig(SESSION_ONLY, { sleepMs: 400 });
    try {
      const first = readClaude({ account: "seat-a", configDir: "/cfg", bin: slow.bin, now: Date.now, lockDir: slow.dir });
      first.catch(() => {});                                        // handled again at the await below (the round-1 stub rejects)
      await new Promise(resolve => setTimeout(resolve, 100));       // the first has taken the lock
      const second = await readClaude({ account: "seat-a", configDir: "/cfg", bin: slow.bin, now: Date.now, lockDir: slow.dir });
      expect(second).toEqual({ ok: false, reason: "unreachable", retryAfterS: null, hint: null });
      expect((await first).ok).toBe(true);
      expect(slow.count("spawn.log")).toBe(1);
    } finally { rmSync(slow.dir, { recursive: true, force: true }); }
  });

  it("two accounts never run at once on a node: the semaphore serializes them", async () => {
    const slow = rig(SESSION_ONLY, { sleepMs: 200 });
    try {
      await Promise.all([
        readClaude({ account: "seat-a", configDir: "/cfg", bin: slow.bin, now: Date.now, lockDir: slow.dir }),
        readClaude({ account: "seat-b", configDir: "/cfg", bin: slow.bin, now: Date.now, lockDir: slow.dir }),
      ]);
      expect(slow.count("spawn.log")).toBe(2);                        // both ran, one after the other
      expect(existsSync(join(slow.dir, "claude-usage-seat-a.lock"))).toBe(true);
      expect(existsSync(join(slow.dir, "claude-usage-seat-b.lock"))).toBe(true);
      // The fake writes start and end around its sleep: two reads that overlapped would show a start before the
      // running one's end.
      const run = slow.lines("run.log");
      expect(run).toHaveLength(4);
      expect(run[0]).toBe("start");
      expect(run[1]).toBe("end");
      expect(run[2]).toBe("start");
      expect(run[3]).toBe("end");
    } finally { rmSync(slow.dir, { recursive: true, force: true }); }
  });

  it("the whole process group is killed at the timeout and the reason is timeout", async () => {
    const slow = rig(SESSION_ONLY, { sleepMs: 60_000, group: true });
    try {
      const started = Date.now();
      const out = await readClaude({ account: "seat-a", configDir: "/cfg", bin: slow.bin, timeoutMs: 200, now: Date.now, lockDir: slow.dir });
      expect(out).toEqual({ ok: false, reason: "timeout", retryAfterS: null, hint: null });
      expect(Date.now() - started).toBeLessThan(10_000);
      const kid = Number(slow.lines("group.pid")[0]);
      expect(Number.isInteger(kid)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(() => process.kill(kid, 0)).toThrow();      // the child died with the group, not only the fake
    } finally { rmSync(slow.dir, { recursive: true, force: true }); }
  });

  it("a lock whose pid is gone is stale and taken over", async () => {
    writeFileSync(join(r.dir, "claude-usage-seat-a.lock"), `${JSON.stringify({ pid: gone(), startedAt: Date.now() })}\n`);
    const out = await readClaude({ account: "seat-a", configDir: "/cfg", bin: r.bin, now: Date.now, lockDir: r.dir });
    expect(out.ok).toBe(true);
    expect(r.count("spawn.log")).toBe(1);
  });

  it("a lock older than 210 s is stale even with a live pid; a fresh live one is not", async () => {
    const at = Date.now();
    writeFileSync(join(r.dir, "claude-usage-seat-a.lock"), `${JSON.stringify({ pid: process.pid, startedAt: at - 211_000 })}\n`);
    expect((await readClaude({ account: "seat-a", configDir: "/cfg", bin: r.bin, now: () => at, lockDir: r.dir })).ok).toBe(true);
    expect(r.count("spawn.log")).toBe(1);
    writeFileSync(join(r.dir, "claude-usage-seat-a.lock"), `${JSON.stringify({ pid: process.pid, startedAt: at })}\n`);
    const refused = await readClaude({ account: "seat-a", configDir: "/cfg", bin: r.bin, now: () => at, lockDir: r.dir });
    expect(refused).toEqual({ ok: false, reason: "unreachable", retryAfterS: null, hint: null });
    expect(r.count("spawn.log")).toBe(1);        // still the one spawn of the stale case
  });

  // The fix round (2026-10-24, finding 4, and md-rev6's re-check, finding 1): the lock also records the child's pgid, and
  // taking over a stale lock kills that group, but only when it is still our read: the lock is less than twice the
  // lease TTL old AND the group leader's command line is the headless /usage run. A pgid a day later may belong to
  // an unrelated group (a lane's tmux): that group is never signalled, the stale lock is only taken over.
  const READ_ARGV = ["-e", "setTimeout(() => {}, 60000)", "--", "-p", "/usage", "--tools", ""];   // what the read's leader looks like
  const takeover = async (argv: string[], ageMs: number): Promise<{ survived: boolean; ok: boolean }> => {
    const kid = spawn(process.execPath, argv, { stdio: "ignore", detached: true });
    const kidPid = kid.pid ?? -1;
    if (kidPid <= 0) throw new Error("the grandchild never started");
    try {
      await new Promise(resolve => setTimeout(resolve, 200));         // its command line is readable once it has exec'd
      const at = Date.now();
      writeFileSync(join(r.dir, "claude-usage-seat-a.lock"), `${JSON.stringify({ pid: process.pid, pgid: kidPid, startedAt: at - ageMs })}\n`);
      const out = await readClaude({ account: "seat-a", configDir: "/cfg", bin: r.bin, now: () => at, lockDir: r.dir });
      await new Promise(resolve => setTimeout(resolve, 500));
      let survived = true;
      try { process.kill(kidPid, 0); } catch { survived = false; }
      return { survived, ok: out.ok };
    } finally {
      try { process.kill(-kidPid, "SIGKILL"); } catch { /* already gone, or never the leader */ }
    }
  };

  it("taking over a stale lock kills the group its pgid names, when it is still the headless read", async () => {
    const out = await takeover(READ_ARGV, 211_000);
    expect(out.ok).toBe(true);                       // the stale lock was taken over all the same
    expect(out.survived).toBe(false);                // the group the stale lock named died with the takeover
  });

  it("a group whose command line is not the read is left alone, and the lock is still taken over", async () => {
    const out = await takeover(["-e", "setTimeout(() => {}, 60000)"], 211_000);
    expect(out.ok).toBe(true);
    expect(out.survived).toBe(true);                 // a reused pgid of somebody else's group: never signalled
  });

  it("a lock older than twice the lease TTL names a group nobody may kill, even one that looks like the read", async () => {
    const out = await takeover(READ_ARGV, 2 * 210_000 + 1_000);
    expect(out.ok).toBe(true);
    expect(out.survived).toBe(true);
  });

  it("after signed_out no spawn until the fake's auth status says signed in", async () => {
    const out = rig(SIGNED_OUT);
    try {
      const first = await readClaude({ account: "seat-a", configDir: "/cfg", bin: out.bin, now: Date.now, lockDir: out.dir });
      expect(first).toEqual({ ok: false, reason: "signed_out", retryAfterS: null, hint: null });
      expect(out.count("spawn.log")).toBe(1);
      writeFileSync(join(out.dir, "fixture.jsonl"), SESSION_ONLY.join("\n") + "\n");     // signed in, the report is back
      const second = await readClaude({ account: "seat-a", configDir: "/cfg", bin: out.bin, now: Date.now, lockDir: out.dir });
      expect(second).toEqual({ ok: false, reason: "signed_out", retryAfterS: null, hint: null });   // gated: no spawn
      expect(out.count("spawn.log")).toBe(1);
      writeFileSync(join(out.dir, "signed-in"), "");
      const third = await readClaude({ account: "seat-a", configDir: "/cfg", bin: out.bin, now: Date.now, lockDir: out.dir });
      expect(third.ok).toBe(true);
      expect(out.count("spawn.log")).toBe(2);
    } finally { rmSync(out.dir, { recursive: true, force: true }); }
  });
});
