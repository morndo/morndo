// The headless Claude usage report, mapped (AT-31, AT-38's claude cases; plan 4.4): the kinds the report names, the
// windows they become, the null report that is no scope and never 0%, the bad values dropped, and every failure
// class. The fixtures under fixtures/usage/claude are made-up report lines, never a real account's values.
import { createHash } from "node:crypto";
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

  // The fix round (2026-10-24, finding 5): an unknown_screen hint is never free text from the CLI. It is the fixed
  // shape `unknown shape ${hash}`, the hash the first 8 hex characters of the sha256 of the last stdout line's first
  // 120 characters. Red against the code before the fix: the hint is the redacted head, free text still.
  it("a changed shape is unknown_screen, with the fixed hashed hint: no token, no URL, no free text", () => {
    const lines = fixture("changed-shape");
    const r = parseClaudeReport(lines);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_screen");
    expect(r.hint).toBe(`unknown shape ${createHash("sha256").update(lines[lines.length - 1]!.slice(0, 120)).digest("hex").slice(0, 8)}`);
    expect(r.hint).not.toContain("sk-ant");
    expect(r.hint).not.toContain("stats.example.test");
  });

  it("an unknown report shape is unknown_screen too", () => {
    const r = parseClaudeReport(fixture("unknown-shape"));
    expect(r).toEqual({ ok: false, reason: "unknown_screen", retryAfterS: null, hint: null });
  });

  it("a leaky line yields only the fixed shape: no name, no token, no URL, no UUID (finding 5)", () => {
    const lines = fixture("leaky");
    const r = parseClaudeReport(lines);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_screen");
    expect(r.hint).toBe(`unknown shape ${createHash("sha256").update(lines[lines.length - 1]!.slice(0, 120)).digest("hex").slice(0, 8)}`);
    expect(r.hint).not.toContain("Jack");
    expect(r.hint).not.toContain("sk-ant");
    expect(r.hint).not.toContain("stats.example.test");
    expect(r.hint).not.toContain("123e4567");
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
    expect(five?.resets_at).toBe(at("2026-10-20T11:00:00Z"));
    expect(five!.resets_at!).toBeLessThan(at("2026-10-20T15:00:00Z"));
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

  // The fix round (2026-10-24, finding 5): an unclassifiable error's hint is the fixed shape too — the error's own
  // words (a name, a UUID) never reach the hub. Red against the code before the fix: the hint is the redacted head of
  // the error text, and a name and a UUID survive it.
  it("an unclassifiable error's hint is the fixed shape, never the error's own words", () => {
    const r = parseClaudeReport(fixture("error-leak"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_screen");
    expect(r.hint).toMatch(/^unknown shape [0-9a-f]{8}$/);
    expect(r.hint).not.toContain("Dave");
    expect(r.hint).not.toContain("123e4567");
  });
});
