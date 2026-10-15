// The Codex usage reader (ADR-0028 decision 5): the app server's answer, its translation into the status-line JSON the
// hub's Usage route reads (ADR-0016), and the process it starts. A fake app server stands in; no sign-in is used.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageReportBody } from "@morndo/protocol";
import { limitsFromResult, readCodexLimits, usageReport, windowLabel } from "../src/adapters/usage-codex.ts";

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
    expect(limitsFromResult(PLUS)).toEqual({ primary: win(42, 300, 1_893_456_000), secondary: win(17, 10_080, 1_893_888_000), planType: "plus" });
    expect(limitsFromResult({ rateLimits: { primary: { usedPercent: "42" } } })).toBeNull();
    expect(limitsFromResult({ limits: [] })).toBeNull();
    expect(limitsFromResult({ rateLimits: { primary: null, secondary: null, planType: "Plus Plan!" } }))
      .toEqual({ primary: null, secondary: null, planType: null });
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
    expect(usageReport({ primary: win(9, 10_080), secondary: null, planType: "pro" }, "s").rate_limits)
      .toEqual({ seven_day: { used_percentage: 9, resets_at: 1_893_456_000 } });
  });

  it("names every window when one isn't 5 hours or 7 days", () => {
    const body = usageReport({ primary: win(30, 300), secondary: win(50, 1440, null), planType: null }, "s");
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
      .toEqual({ ok: false, problem: "/nonexistent/codex is not on PATH" });
  });
});
