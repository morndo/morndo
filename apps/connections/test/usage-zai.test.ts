// The Z.ai quota answer, mapped (AT-39, plan 4.6): windows told by unit and number, never by order; CREDIT_LIMIT
// accepted where TOKENS_LIMIT was; a missing weekly entry missing, not a failure; the failure classes in their
// order; and the reading body the collector posts. Round 1: the parser is a stub, so every test here is red with
// "not implemented". Made-up values only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UsageReadingsBody } from "@morndo/protocol";
import { parseZaiQuota, zaiReadingBody, type ZaiReadResult } from "../src/adapters/usage-zai.ts";

const FIVE_RESET_MS = 1_793_460_000_000;            // 2026-10-28T09:20:00Z, made up
const WEEK_RESET_MS = 1_793_620_000_000;            // 2026-10-30T05:46:40Z, made up
const five = { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: FIVE_RESET_MS };
const week = { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 61, nextResetTime: WEEK_RESET_MS };
const okBody = (limits: unknown[]) => ({ code: 0, success: true, data: { limits } });
const answer = (o: { status?: number; retryAfter?: string | null; body?: unknown } = {}): { status: number; retryAfter: string | null; body: unknown } =>
  ({ status: o.status ?? 200, retryAfter: o.retryAfter ?? null, body: o.body ?? okBody([five, week]) });

const FIVE_WINDOW = { id: "five_hour", used_percent: 42, resets_at: Math.floor(FIVE_RESET_MS / 1000), length_mins: 300, rolling: true, note: null };
const WEEK_WINDOW = { id: "seven_day", used_percent: 61, resets_at: Math.floor(WEEK_RESET_MS / 1000), length_mins: 10080, rolling: true, note: null };

// The two orders a week's end swaps between: the same ids, lengths and values either way.
const byId = (r: ZaiReadResult) => {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error("not ok");
  return Object.fromEntries(r.windows.map(w => [w.id, w]));
};
const reasonOf = (r: ZaiReadResult): string | null => (r.ok ? null : r.reason);

describe("maps the quota answer by unit and number (AT-39)", () => {
  it("the 5-hour entry first and the weekly entry first map to the same windows", () => {
    const a = parseZaiQuota(answer({ body: okBody([five, week]) }));
    const b = parseZaiQuota(answer({ body: okBody([week, five]) }));
    expect(a.ok).toBe(true);
    expect(a).toMatchObject({ ok: true, missing: [] });
    expect(byId(a)).toEqual({ five_hour: FIVE_WINDOW, seven_day: WEEK_WINDOW });
    expect(byId(b)).toEqual(byId(a));
    if (a.ok) expect(a.windows).toHaveLength(2);
    if (b.ok) expect(b.windows).toHaveLength(2);
  });

  it("CREDIT_LIMIT is accepted wherever TOKENS_LIMIT was", () => {
    const r = parseZaiQuota(answer({ body: okBody([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: FIVE_RESET_MS },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 61, nextResetTime: WEEK_RESET_MS },
    ]) }));
    expect(byId(r)).toEqual({ five_hour: FIVE_WINDOW, seven_day: WEEK_WINDOW });
  });

  it("a missing weekly entry lands in missing and is not a failure", () => {
    const r = parseZaiQuota(answer({ body: okBody([five]) }));
    expect(r).toMatchObject({ ok: true, missing: ["seven_day"] });
    if (!r.ok) return;
    expect(r.windows).toEqual([FIVE_WINDOW]);
  });

  it("an unknown unit gives length null and the plain Limit id; other lengths name the window by their minutes", () => {
    const r = parseZaiQuota(answer({ body: okBody([
      { type: "CREDIT_LIMIT", unit: 9, number: 2, percentage: 30, nextResetTime: FIVE_RESET_MS },
      { type: "CREDIT_LIMIT", unit: 3, number: 2, percentage: 12, nextResetTime: FIVE_RESET_MS },
    ]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([
      { id: "Limit unit9/2", used_percent: 30, resets_at: Math.floor(FIVE_RESET_MS / 1000), length_mins: null, rolling: true, note: null },
      { id: "Window 120 min", used_percent: 12, resets_at: Math.floor(FIVE_RESET_MS / 1000), length_mins: 120, rolling: true, note: null },
    ]);
    expect(r.missing).toEqual(["five_hour", "seven_day"]);
  });

  it("a TOKENS_LIMIT entry without unit and number is the legacy 5-hour window", () => {
    const r = parseZaiQuota(answer({ body: okBody([{ type: "TOKENS_LIMIT", percentage: 42, nextResetTime: FIVE_RESET_MS }]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([FIVE_WINDOW]);
  });

  it("an entry with no readable percent at all is dropped to missing, and an all-unreadable answer is still ok", () => {
    const r = parseZaiQuota(answer({ body: okBody([{ type: "CREDIT_LIMIT", unit: 3, number: 5, nextResetTime: FIVE_RESET_MS }]) }));
    expect(r).toEqual({ ok: true, windows: [], missing: ["five_hour", "seven_day"] });
  });
});

describe("the values of one window", () => {
  it("a percent that is a timestamp is dropped to missing, never shown as a number", () => {
    const r = parseZaiQuota(answer({ body: okBody([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 1_793_456_000, nextResetTime: FIVE_RESET_MS },
      week,
    ]) }));
    expect(r).toMatchObject({ ok: true, missing: ["five_hour"] });
    if (!r.ok) return;
    expect(r.windows).toEqual([WEEK_WINDOW]);
  });

  it("percentage absent but currentValue and usage present gives their ratio; a non-positive usage gives nothing", () => {
    const r = parseZaiQuota(answer({ body: okBody([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, currentValue: 30, usage: 200, nextResetTime: FIVE_RESET_MS },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, currentValue: 5, usage: 0, nextResetTime: WEEK_RESET_MS },
    ]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([{ ...FIVE_WINDOW, used_percent: 15 }]);
    expect(r.missing).toEqual(["seven_day"]);
  });

  it("two entries claiming one id: the first by array order wins and the other is dropped", () => {
    const r = parseZaiQuota(answer({ body: okBody([
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 42, nextResetTime: FIVE_RESET_MS },
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 90, nextResetTime: FIVE_RESET_MS },
    ]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([FIVE_WINDOW]);
  });

  it("a reset in the past is read as it is; the hub's staleness rules judge it, not the parser", () => {
    const past = 1_700_000_000_000;
    const r = parseZaiQuota(answer({ body: okBody([{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 87, nextResetTime: past }]) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.windows).toEqual([{ ...FIVE_WINDOW, used_percent: 87, resets_at: 1_700_000_000 }]);
  });
});

describe("the failure classes, in their order", () => {
  it("status 401 and 403 are signed_out", () => {
    expect(parseZaiQuota(answer({ status: 401, body: okBody([]) }))).toMatchObject({ ok: false, reason: "signed_out" });
    expect(parseZaiQuota(answer({ status: 403, body: okBody([]) }))).toMatchObject({ ok: false, reason: "signed_out" });
  });

  it("an HTTP 200 whose body carries code 401 is a sign-in failure: signed_out", () => {
    const r = parseZaiQuota(answer({ body: { code: 401, success: false, data: { limits: [] } } }));
    expect(r).toEqual({ ok: false, reason: "signed_out", retryAfterS: null, hint: null });
  });

  it("a 429 carries Retry-After as whole seconds; no header, or an HTTP date, gives null", () => {
    expect(parseZaiQuota(answer({ status: 429, retryAfter: "120", body: null }))).toEqual({ ok: false, reason: "rate_limited", retryAfterS: 120, hint: null });
    expect(parseZaiQuota(answer({ status: 429, body: null }))).toEqual({ ok: false, reason: "rate_limited", retryAfterS: null, hint: null });
    expect(parseZaiQuota(answer({ status: 429, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT", body: null }))).toEqual({ ok: false, reason: "rate_limited", retryAfterS: null, hint: null });
    // only a non-negative whole number counts: a sign, a fraction, an exponent or an empty word is no number at all
    for (const word of ["-5", "1.5", "1e3", "", " 7", "0x10"])
      expect(parseZaiQuota(answer({ status: 429, retryAfter: word, body: null }))).toEqual({ ok: false, reason: "rate_limited", retryAfterS: null, hint: null });
    expect(parseZaiQuota(answer({ status: 429, retryAfter: "0", body: null }))).toEqual({ ok: false, reason: "rate_limited", retryAfterS: 0, hint: null });
  });

  it("success false and a status of 500 or more are unreachable", () => {
    expect(parseZaiQuota(answer({ body: { code: 0, success: false, data: { limits: [] } } }))).toEqual({ ok: false, reason: "unreachable", retryAfterS: null, hint: null });
    expect(parseZaiQuota(answer({ status: 503, body: okBody([five]) }))).toEqual({ ok: false, reason: "unreachable", retryAfterS: null, hint: null });
  });

  it("a body with no data.limits, an empty one, or a non-object body is unknown_screen with the fixed hashed hint", () => {
    const noLimits = { code: 0, success: true, data: {} };
    const r = parseZaiQuota(answer({ body: noLimits }));
    expect(r).toEqual({ ok: false, reason: "unknown_screen", retryAfterS: null, hint: `unknown shape ${createHash("sha256").update(JSON.stringify(noLimits).slice(0, 120)).digest("hex").slice(0, 8)}` });
    expect(reasonOf(parseZaiQuota(answer({ body: okBody([]) })))).toBe("unknown_screen");
    expect(reasonOf(parseZaiQuota(answer({ body: "busy" })))).toBe("unknown_screen");
  });

  it("the unknown-shape hint carries no word of the body", () => {
    const body = { error: "zorpquat overflow in the quota meter", trace: "quux-123" };
    const r = parseZaiQuota(answer({ body }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_screen");
    expect(r.hint).toBe(`unknown shape ${createHash("sha256").update(JSON.stringify(body).slice(0, 120)).digest("hex").slice(0, 8)}`);
    expect(r.hint).not.toContain("zorpquat");
    expect(r.hint).not.toContain("quux");
  });
});

describe("the reading body", () => {
  it("an ok result maps to the vendor-api reading body, and the wire accepts it", () => {
    const parsed = parseZaiQuota(answer());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const body = zaiReadingBody(parsed, { node: "pc", now: 1_700_000_012_345 });
    expect(body).toEqual({
      source: "vendor-api", node: "pc", captured_at: 1_700_000_012, every_s: 300, plan: null,
      windows: [FIVE_WINDOW, WEEK_WINDOW],
    });
    expect(UsageReadingsBody.safeParse(body).success).toBe(true);
  });
});
