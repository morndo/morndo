// The Codex usage reader (ADR-0028 decision 5): the app server's answer, its translation into the status-line JSON the
// hub's Usage route reads (ADR-0016), and the process it starts. A fake app server stands in; no sign-in is used.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageReadingsBody, UsageReportBody } from "@morndo/protocol";
import type { CodexLimits } from "../src/adapters/usage-codex.ts";
import { codexPushedReading, codexReadingBody, everyFor, limitsFromResult, readCodexLimits, usageReport, windowLabel } from "../src/adapters/usage-codex.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const PLUS: unknown = JSON.parse(readFileSync(join(FIXTURES, "codex", "rate-limits-plus.json"), "utf8"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Seen = { argv: string[]; names: string[]; codexHome: string | null; pid: number; init: unknown };

// A copy of the fake in a directory of its own: its answer, its mode and what it saw live beside it.
function server(mode = "ok", limits: unknown = PLUS): { bin: string; dir: string; seen(): Seen } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-usage-"));
  dirs.push(dir);
  const bin = join(dir, "codex.mjs");
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), bin);
  writeFileSync(join(dir, "limits.json"), JSON.stringify(limits));
  writeFileSync(join(dir, "mode"), mode);
  return { bin, dir, seen: () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as Seen };
}

const win = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = 1_893_456_000) =>
  ({ usedPercent, windowDurationMins, resetsAt });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", ...extra });

describe("codex usage: the answer's shape", () => {
  it("reads the 0.161.0 answer and refuses a shape it doesn't know", () => {
    expect(limitsFromResult(PLUS)).toEqual({ primary: win(42, 300, 1_893_456_000), secondary: win(17, 10_080, 1_893_888_000), planType: "plus", others: [] });
    expect(limitsFromResult({ rateLimits: { primary: { usedPercent: "42" } } })).toBeNull();
    expect(limitsFromResult({ limits: [] })).toBeNull();
    expect(limitsFromResult({ rateLimits: { primary: null, secondary: null, planType: "Plus Plan!" } }))
      .toEqual({ primary: null, secondary: null, planType: null, others: [] });
  });
});

describe("codex usage: every limit the account has", () => {
  const BUCKETS: unknown = JSON.parse(readFileSync(join(FIXTURES, "codex", "rate-limits-buckets.json"), "utf8"));

  it("reads the other limits too, each with its name, and reports them as named windows the hub accepts", () => {
    const limits = limitsFromResult(BUCKETS);
    expect(limits?.others).toEqual([{ limitId: "codex-big", name: "Big model", primary: win(100, 300, 1_893_459_600), secondary: null }]);
    if (!limits) throw new Error("fixture unread");
    const body = usageReport(limits, "s");
    expect(body.rate_limits).toBeUndefined();
    expect(body.limits).toEqual([
      { label: "5-hour window", used_percentage: 42, resets_at: 1_893_456_000 },
      { label: "7-day window", used_percentage: 17, resets_at: 1_893_888_000 },
      { label: "Big model: 5-hour window", used_percentage: 100, resets_at: 1_893_459_600 },
    ]);
    expect(UsageReportBody.safeParse(body).success).toBe(true);
  });

  it("does not repeat the default limit that the map holds under its own id, and refuses a bucket in another shape", () => {
    const same = { rateLimits: (PLUS as { rateLimits: unknown }).rateLimits, rateLimitsByLimitId: { codex: (PLUS as { rateLimits: unknown }).rateLimits } };
    expect(limitsFromResult(same)?.others).toEqual([]);
    expect(limitsFromResult({ ...same, rateLimitsByLimitId: { x: { primary: { usedPercent: "no" } } } })).toBeNull();
  });
});

describe("codex usage: the status-line report", () => {
  it("turns a 5-hour and a weekly window into the hub's two windows, which the hub's own schema accepts", () => {
    const limits = limitsFromResult(PLUS);
    if (!limits) throw new Error("fixture unread");
    const body = usageReport(limits, "codex-a-limits");
    expect(body).toEqual({
      session_id: "codex-a-limits",
      model: { display_name: "Codex (plus)" },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_893_456_000 }, seven_day: { used_percentage: 17, resets_at: 1_893_888_000 } },
    });
    expect(UsageReportBody.safeParse(body).success).toBe(true);
  });

  it("reports only the weekly window for a plan with no 5-hour limit", () => {
    expect(usageReport({ primary: win(9, 10_080), secondary: null, planType: "pro", others: [] }, "s").rate_limits)
      .toEqual({ seven_day: { used_percentage: 9, resets_at: 1_893_456_000 } });
  });

  it("names every window when one isn't 5 hours or 7 days", () => {
    const body = usageReport({ primary: win(30, 300), secondary: win(50, 1440, null), planType: null, others: [] }, "s");
    expect(body.rate_limits).toBeUndefined();
    expect(body.limits).toEqual([
      { label: "5-hour window", used_percentage: 30, resets_at: 1_893_456_000 },
      { label: "1-day window", used_percentage: 50, resets_at: null },
    ]);
    expect(body.model).toEqual({ display_name: "Codex" });
    expect(UsageReportBody.safeParse(body).success).toBe(true);
    expect([windowLabel(120), windowLabel(45), windowLabel(null)]).toEqual(["2-hour window", "45-minute window", "Window"]);
  });
});

describe("codex usage: the reading body (S6, plan 4.6)", () => {
  const limits = (o: Partial<CodexLimits> = {}): CodexLimits => ({ primary: win(42, 300), secondary: win(17, 10_080, 1_893_888_000), planType: "plus", others: [], ...o });
  const flags = { identity: "a1b2c3d4e5f6", ordinaryUsageAllowed: true, rateLimitReachedType: null, now: 1_700_000_012_345, node: "pc" };
  const noFlags = { identity: null, ordinaryUsageAllowed: null, rateLimitReachedType: null, now: 1_700_000_000_000, node: "pc" };

  it("maps a primary and secondary pair onto the hub's two windows, with the flags, and the wire accepts it", () => {
    const body = codexReadingBody(limits(), flags);
    expect(body).toEqual({
      source: "app-server", node: "pc", captured_at: 1_700_000_012, every_s: 900,
      plan: "plus", identity: "a1b2c3d4e5f6",
      windows: [
        { id: "five_hour", used_percent: 42, resets_at: 1_893_456_000, length_mins: 300, rolling: false, note: null },
        { id: "seven_day", used_percent: 17, resets_at: 1_893_888_000, length_mins: 10_080, rolling: false, note: null },
      ],
      ordinary_usage_allowed: true,
    });
    expect(UsageReadingsBody.safeParse(body).success).toBe(true);
  });

  it("maps each other limit's windows under its own name, cut to 40 characters, with their lengths", () => {
    const body = codexReadingBody(limits({
      others: [
        { limitId: "codex-big", name: "Big model", primary: win(100, 300, 1_893_459_600), secondary: null },
        { limitId: "codex-long", name: "A limit name long enough to overflow the cap", primary: win(5, 720, null), secondary: null },
      ],
    }), noFlags);
    expect(body.windows).toEqual([
      { id: "five_hour", used_percent: 42, resets_at: 1_893_456_000, length_mins: 300, rolling: false, note: null },
      { id: "seven_day", used_percent: 17, resets_at: 1_893_888_000, length_mins: 10_080, rolling: false, note: null },
      { id: "Big model: 5-hour window", used_percent: 100, resets_at: 1_893_459_600, length_mins: 300, rolling: false, note: null },
      { id: "A limit name long enough to overflow the", used_percent: 5, resets_at: null, length_mins: 720, rolling: false, note: null },
    ]);
    expect(body.every_s).toBe(60);        // the fullest window (100%) holds the read at once a minute
    expect(body.node).toBe("pc");
    expect(body.plan).toBe("plus");
    expect("ordinary_usage_allowed" in body).toBe(false);        // the reader had no word on the flags: no key at all
    expect("rate_limit_reached_type" in body).toBe(false);
  });

  it("sends length_mins with every window; an unknown duration sends null, not a failure (AT-14)", () => {
    const unknown = codexReadingBody({ primary: win(30, null), secondary: null, planType: null, others: [] }, { ...noFlags, node: null });
    expect(unknown.windows).toEqual([{ id: "Window", used_percent: 30, resets_at: 1_893_456_000, length_mins: null, rolling: false, note: null }]);
    expect(unknown.plan).toBeNull();
    expect(unknown.node).toBeNull();
    const mins = codexReadingBody({ primary: win(30, 1440), secondary: null, planType: null, others: [] }, noFlags);
    expect(mins.windows[0]?.id).toBe("Window 1440 min");
  });
});

describe("codex usage: the adaptive interval (AT-42)", () => {
  it("idles at 15 minutes and quickens as a window fills, never faster than once a minute", () => {
    expect(everyFor(null)).toBe(900);
    expect(everyFor(0)).toBe(900);
    expect(everyFor(74.9)).toBe(900);
    expect(everyFor(75)).toBe(300);
    expect(everyFor(89.9)).toBe(300);
    expect(everyFor(90)).toBe(120);
    expect(everyFor(98.9)).toBe(120);
    expect(everyFor(99)).toBe(60);
    expect(everyFor(100)).toBe(60);
    for (const p of [null, 0, 25, 74.9, 75, 80, 90, 95, 99, 100]) expect(everyFor(p)).toBeGreaterThanOrEqual(60);
  });
});

describe("codex usage: a pushed update (S6)", () => {
  it("maps a rate-limits snapshot to the same body, flagged pushed, with no lease", () => {
    const body = codexPushedReading(PLUS, { identity: null, now: 1_700_000_000_000, node: "pc" });
    expect(body).toEqual({
      source: "app-server", node: "pc", captured_at: 1_700_000_000, every_s: 900,
      plan: "plus", identity: null,
      windows: [
        { id: "five_hour", used_percent: 42, resets_at: 1_893_456_000, length_mins: 300, rolling: false, note: null },
        { id: "seven_day", used_percent: 17, resets_at: 1_893_888_000, length_mins: 10_080, rolling: false, note: null },
      ],
      pushed: true,
    });
  });
});

describe("codex usage: the app server", () => {
  it("initializes, asks for the rate limits once, and leaves no process", async () => {
    const s = server();
    const reading = await readCodexLimits({ bin: s.bin, env: env({ CODEX_HOME: s.dir }), version: "9.9.9" });
    expect(reading).toEqual({ ok: true, limits: limitsFromResult(PLUS) });
    const seen = s.seen();
    expect(seen.argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(seen.init).toEqual({ clientInfo: { name: "morndo", title: "Morndo", version: "9.9.9" } });
    expect(seen.codexHome).toBe(s.dir);
    await expect.poll(() => alive(seen.pid)).toBe(false);
  });

  it("answers a request the server sends in the middle of a read, whatever its id, and still gets the limits", async () => {
    const s = server("request");
    const reading = await readCodexLimits({ bin: s.bin, env: env(), version: "1", timeoutMs: 5_000 });
    expect(reading).toEqual({ ok: true, limits: limitsFromResult(PLUS) });
    const replies = (s.seen() as Seen & { replies: { id: number; error: { code: number } | null }[] }).replies;
    expect(replies.map(r => r.id).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(replies.every(r => r.error?.code === -32601)).toBe(true);
  });

  it("stops an app server that ignores SIGTERM before it returns", async () => {
    const s = server("deaf");
    expect(await readCodexLimits({ bin: s.bin, env: env(), version: "1", timeoutMs: 500 }))
      .toEqual({ ok: false, problem: "codex app-server did not answer in time" });
    expect(alive(s.seen().pid)).toBe(false);
  }, 15_000);

  it("says why when the read is refused", async () => {
    expect(await readCodexLimits({ bin: server("error").bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "codex app-server: not signed in with ChatGPT" });
  });

  it("gives up on an app server that never answers, and stops it", async () => {
    const s = server("silent");
    expect(await readCodexLimits({ bin: s.bin, env: env(), version: "1", timeoutMs: 2_000 }))
      .toEqual({ ok: false, problem: "codex app-server did not answer in time" });
    await expect.poll(() => alive(s.seen().pid)).toBe(false);
  });

  it("refuses an answer in another shape, an answer with no window, and a binary that isn't there", async () => {
    expect(await readCodexLimits({ bin: server("garbage").bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "codex app-server answered in a shape this reader does not know" });
    expect(await readCodexLimits({ bin: server("ok", { rateLimits: { primary: null, secondary: null } }).bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "Codex reported no usage window" });
    expect(await readCodexLimits({ bin: "/nonexistent/codex", env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "/nonexistent/codex could not be started: it is missing, or its interpreter is not on PATH" });
    expect(await readCodexLimits({ bin: "codex-not-installed-anywhere", env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "codex-not-installed-anywhere is not on PATH" });
  });
});
