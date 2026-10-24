// The first-party error classifier (ADR-0036, plan 3.1): what a refusal from the provider means to a key pool. Fixtures follow the
// error pages as read on 2026-10-25 (platform.claude.com/docs/en/api/errors and .../rate-limits); request ids are made up. Claude
// Code's own printed lines are not documented, so those fixtures are synthetic and say so. A malformed request must never exhaust a key.
import { describe, expect, it } from "vitest";
import type { Outcome } from "@morndo/domain";
import { VendorCatalog } from "@morndo/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinClassifiers } from "../src/adapters/classifiers.ts";
import { anthropicClassifier, signalFromBody, signalFromText } from "../src/adapters/outcome-anthropic.ts";

const body = (type: string, message: string, details?: Record<string, string>): string =>
  JSON.stringify({ type: "error", error: { type, message, ...(details ? { details } : {}) }, request_id: "req_011TESTTESTTESTTEST" });
const CREDIT = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const CODE_LINE = "Credit balance too low · Add funds: https://platform.claude.com/settings/billing";
const LIMIT = "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const WORKSPACE_LIMIT = "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
const CAP = "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.";
const classify = (status: number | null, text: string | null, retryAfter: string | null = null): Outcome =>
  anthropicClassifier.classify(signalFromBody(status, text, retryAfter));

describe("the classifier, one fixture per row of the table", () => {
  it.each<[string, number, string, Outcome]>([
    ["400 with the credit message", 400, body("invalid_request_error", CREDIT), { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["402 with the credit message", 402, body("invalid_request_error", CREDIT), { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["400 with Claude Code's shorter line as the message", 400, body("invalid_request_error", CODE_LINE), { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["402 billing_error, whatever the text", 402, body("billing_error", "There is an issue with your billing or payment information."), { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["400 spend limit with its date", 400, body("invalid_request_error", LIMIT), { kind: "exhausted", reason: "spend-limit", resumeAt: Date.UTC(2026, 10, 1) }],
    ["400 workspace spend limit with its date", 400, body("invalid_request_error", WORKSPACE_LIMIT), { kind: "exhausted", reason: "spend-limit", resumeAt: Date.UTC(2026, 10, 1) }],
    ["400 spend limit with no date", 400, body("invalid_request_error", "You have reached your specified API usage limits."), { kind: "exhausted", reason: "spend-limit", resumeAt: null }],
    ["429 enforced_spend_limit_reached (the tier's monthly cap)", 429, body("rate_limit_error", CAP, { error_code: "enforced_spend_limit_reached" }), { kind: "failing", reason: "cap" }],
    ["429 for rate, no retry-after", 429, body("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit."), { kind: "limited", retryAfterMs: null }],
    ["401 authentication_error", 401, body("authentication_error", "invalid x-api-key"), { kind: "failing", reason: "rejected" }],
    ["403 permission_error", 403, body("permission_error", "Your API key does not have permission to use the specified resource."), { kind: "failing", reason: "denied" }],
    ["403 with an account on hold", 403, body("permission_error", "This organization is disabled: account_on_hold"), { kind: "failing", reason: "held" }],
    ["529 overloaded", 529, body("overloaded_error", "Overloaded"), { kind: "unknown" }],
    ["500 api_error", 500, body("api_error", "Internal server error"), { kind: "unknown" }],
    ["504 timeout_error", 504, body("timeout_error", "Request timed out"), { kind: "unknown" }],
    ["404 not_found_error", 404, body("not_found_error", "The requested resource could not be found."), { kind: "unknown" }],
    ["413 request_too_large", 413, body("request_too_large", "Request exceeds the maximum allowed number of bytes."), { kind: "unknown" }],
    ["400 for a bad max_tokens: a malformed request never exhausts a key", 400, body("invalid_request_error", "max_tokens: Input should be greater than or equal to 1"), { kind: "unknown" }],
    ["400 that only mentions credit in passing", 400, body("invalid_request_error", "messages.0.content: do not include your credit card number"), { kind: "unknown" }],
  ])("%s", (_name, status, text, expected) => {
    expect(classify(status, text)).toEqual(expected);
  });

  it("a 2xx is ok from a Messages request", () => {
    expect(classify(200, "{}")).toEqual({ kind: "ok", evidence: "messages" });
  });

  it("a 429 with retry-after is limited for that long; a spend-limit 429 never carries one but a rate-limit 429 may", () => {
    expect(classify(429, body("rate_limit_error", "slow down"), "30")).toEqual({ kind: "limited", retryAfterMs: 30_000 });
    expect(classify(429, body("rate_limit_error", "slow down"), "not-a-number")).toEqual({ kind: "limited", retryAfterMs: null });
  });

  it("a network error (no status, no text) is unknown", () => {
    expect(classify(null, null)).toEqual({ kind: "unknown" });
  });

  it("negative control: a classifier that treats any 400 as exhausted gets the bad max_tokens fixture wrong", () => {
    const lazy = (status: number | null): Outcome => (status === 400 ? { kind: "exhausted", reason: "credit", resumeAt: null } : { kind: "unknown" });
    expect(lazy(400)).not.toEqual(classify(400, body("invalid_request_error", "max_tokens: Input should be greater than or equal to 1")));
  });
});

describe("signalFromBody keeps a bounded signal, never the text", () => {
  it("cuts the message at 256 characters, keeps the status, the error type and the code, and parses the date", () => {
    const long = `${LIMIT} ${"x".repeat(1000)}`;
    const s = signalFromBody(400, body("invalid_request_error", long), null);
    expect(s.status).toBe(400);
    expect(s.kind).toBe("invalid_request_error");
    expect((s.text ?? "").length).toBeLessThanOrEqual(256);
    expect(s.resumeDate).toBe("2026-11-01");
    const cap = signalFromBody(429, body("rate_limit_error", CAP, { error_code: "enforced_spend_limit_reached" }), null);
    expect(cap.code).toBe("enforced_spend_limit_reached");
    expect(signalFromBody(429, body("rate_limit_error", "x"), "12").retryAfterSeconds).toBe(12);
  });
  it("takes a body that is not JSON as text with no type", () => {
    expect(signalFromBody(502, "<html>bad gateway</html>", null)).toMatchObject({ status: 502, kind: null, text: "<html>bad gateway</html>" });
    expect(classify(502, "<html>bad gateway</html>")).toEqual({ kind: "unknown" });
  });
});

describe("signalFromText: what Claude Code prints (synthetic: its format is not documented)", () => {
  const sig = (text: string) => anthropicClassifier.classify(signalFromText(text));
  it("reads an API error line with its JSON body", () => {
    expect(sig(`API Error: 400 ${body("invalid_request_error", CREDIT)}`)).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
    expect(sig(`API Error: 400 ${body("invalid_request_error", LIMIT)}`)).toEqual({ kind: "exhausted", reason: "spend-limit", resumeAt: Date.UTC(2026, 10, 1) });
    expect(sig(`API Error: 401 ${body("authentication_error", "invalid x-api-key")}`)).toEqual({ kind: "failing", reason: "rejected" });
    expect(sig(`API Error: 429 ${body("rate_limit_error", CAP, { error_code: "enforced_spend_limit_reached" })}`)).toEqual({ kind: "failing", reason: "cap" });
  });
  it("reads the shorter lines it prints without a status", () => {
    expect(sig(CODE_LINE)).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
    expect(sig(`some output\n${CODE_LINE}\nmore output`)).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
    expect(sig("Credit balance is too low")).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
    expect(sig("account_on_hold")).toEqual({ kind: "failing", reason: "held" });
    expect(sig("authentication_failed")).toEqual({ kind: "failing", reason: "held" });
  });
  it("is unknown for output that says nothing about a refusal, and keeps no text of it", () => {
    expect(sig("Done. All tests passed.")).toEqual({ kind: "unknown" });
    expect(sig("")).toEqual({ kind: "unknown" });
    expect(signalFromText("Done. sk-planted-secret-0001")).toMatchObject({ status: null, kind: null, text: null });
  });
  it("a 400 line for another reason stays unknown", () => {
    expect(sig(`API Error: 400 ${body("invalid_request_error", "max_tokens: Input should be greater than or equal to 1")}`)).toEqual({ kind: "unknown" });
  });
  it("the excerpt it keeps is bounded", () => {
    const s = signalFromText(`${"y".repeat(5000)} ${CODE_LINE} ${"z".repeat(5000)}`);
    expect((s.text ?? "").length).toBeLessThanOrEqual(256);
    expect(anthropicClassifier.classify(s)).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
  });
});

describe("the catalog names the classifier as data", () => {
  const presets = VendorCatalog.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json"), "utf8")));
  it("only the first-party preset hosts a key pool, with a dated terms revision and a terms line", () => {
    const hosts = presets.filter(p => p.keyPool !== undefined);
    expect(hosts.map(p => p.id)).toEqual(["anthropic"]);
    const pool = hosts[0]?.keyPool;
    expect(pool?.errorDialect).toBe("anthropic");
    expect(pool?.termsRevision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(pool?.termsLine).toMatch(/spend limit/);
    expect(pool?.termsLine).toMatch(/hold/);
    expect(pool?.termsLine.length).toBeGreaterThan(100);
  });
  it("the built-in classifiers cover exactly the dialects the catalog names", () => {
    expect(builtinClassifiers.for("anthropic")).toBe(anthropicClassifier);
    expect(builtinClassifiers.for("openai-responses")).toBeNull();
    for (const p of presets) if (p.keyPool) expect(builtinClassifiers.for(p.keyPool.errorDialect), p.id).not.toBeNull();
  });
});
