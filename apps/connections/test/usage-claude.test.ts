// The headless Claude usage report, mapped (AT-31, AT-38's claude cases; plan 4.4): the kinds the report names, the
// windows they become, the null report that is no scope and never 0%, the bad values dropped, and every failure
// class. The fixtures under fixtures/usage/claude are made-up report lines, never a real account's values.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeReport } from "../src/adapters/usage-claude.ts";

const fixture = (name: string): string[] =>
  readFileSync(join(import.meta.dirname, "fixtures/usage/claude", `${name}.jsonl`), "utf8").split("\n").filter(l => l !== "");

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe("maps the headless report (AT-31)", () => {
  it("a session-only report is one five-hour window of 300 minutes", () => {
    const r = parseClaudeReport(fixture("session-only"));
    expect(r).toEqual({
      ok: true,
      windows: [{ id: "five_hour", used_percent: 42, resets_at: at("2026-10-24T15:00:00Z"), length_mins: 300, rolling: false, note: null }],
    });
  });

  it("a full report maps session, weekly_all and a weekly_scoped titled with its model, without a length", () => {
    const r = parseClaudeReport(fixture("full"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([
      { id: "five_hour", used_percent: 42, resets_at: at("2026-10-24T15:00:00Z"), length_mins: 300, rolling: false, note: null },
      { id: "seven_day", used_percent: 61, resets_at: at("2026-10-26T09:30:00Z"), length_mins: 10080, rolling: false, note: null },
      { id: "Weekly (claude-opus-4-5)", used_percent: 12, resets_at: at("2026-10-26T09:30:00Z"), length_mins: null, rolling: false, note: null },
    ]);
  });

  it("a report with rate_limits null is no_scope, never 0%", () => {
    const r = parseClaudeReport(fixture("null-report"));
    expect(r).toEqual({ ok: false, reason: "no_scope", retryAfterS: null, hint: null });
  });

  it("a percent of 1.7e9 and one of -3 are dropped; the window beside them stays", () => {
    const r = parseClaudeReport(fixture("out-of-range"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map(w => w.id)).toEqual(["Weekly (claude-sonnet-4-5)"]);
  });

  it("a changed shape is unknown_screen, with a redacted head of the last line: no token, no URL", () => {
    const r = parseClaudeReport(fixture("changed-shape"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_screen");
    expect(r.hint).toBeTruthy();
    expect(r.hint).not.toContain("sk-ant");
    expect(r.hint).not.toContain("stats.example.test");
    expect(r.hint).not.toContain("http");
    expect(r.hint!.length).toBeLessThanOrEqual(120);
  });

  it("an unknown report shape is unknown_screen too", () => {
    const r = parseClaudeReport(fixture("unknown-shape"));
    expect(r).toEqual({ ok: false, reason: "unknown_screen", retryAfterS: null, hint: null });
  });
});

describe("the claude cases of AT-38", () => {
  it("a window whose percent is null is dropped, never read as a number", () => {
    const r = parseClaudeReport(fixture("null-percent"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map(w => w.id)).toEqual(["five_hour"]);
  });

  it("a timestamp in the percent field is out of range, so the window is dropped", () => {
    const r = parseClaudeReport(fixture("timestamp-percent"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows.map(w => w.id)).toEqual(["seven_day"]);
  });

  it("an expired window keeps its past reset time; dropping it is the hub's merge, not the parse", () => {
    const r = parseClaudeReport(fixture("expired"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const five = r.windows.find(w => w.id === "five_hour");
    expect(five?.used_percent).toBe(87);
    expect(five?.resets_at).toBe(at("2026-10-24T11:00:00Z"));
    expect(five!.resets_at!).toBeLessThan(at("2026-10-24T15:00:00Z"));
  });

  it("a 429 with a retry-after carries it in whole seconds; without one it is null", () => {
    const withRetry = parseClaudeReport(fixture("rate-limited-retry"));
    expect(withRetry).toEqual({ ok: false, reason: "rate_limited", retryAfterS: 120, hint: null });
    const bare = parseClaudeReport(fixture("rate-limited-no-retry"));
    expect(bare).toEqual({ ok: false, reason: "rate_limited", retryAfterS: null, hint: null });
  });

  it("a token without the profile scope reads rate_limits null: no_scope (AT-35's reason)", () => {
    expect(parseClaudeReport(fixture("null-report"))).toEqual({ ok: false, reason: "no_scope", retryAfterS: null, hint: null });
  });
});

describe("the error classes (plan 4.3 item 6)", () => {
  it("login words with 401 are signed_out", () => {
    expect(parseClaudeReport(fixture("signed-out"))).toEqual({ ok: false, reason: "signed_out", retryAfterS: null, hint: null });
  });

  it("organization words are refused", () => {
    expect(parseClaudeReport(fixture("refused"))).toEqual({ ok: false, reason: "refused", retryAfterS: null, hint: null });
  });
});
