// The first-party error classifier (ADR-0037, plan 3.1): what a refusal from the provider means to a key pool. Fixtures follow the
// error pages as read on 2026-10-25 (platform.claude.com/docs/en/api/errors and .../rate-limits); request ids are made up. A run's own
// result record is read only as the agent CLI's structured result (review F1): never free text. A malformed request must never exhaust a key.
import { describe, expect, it } from "vitest";
import type { Outcome } from "@morndo/domain";
import { anthropicClassifier, readRunFailure, signalFromBody } from "../src/adapters/outcome-anthropic.ts";

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

// A headless run prints one JSON result (observed 2026-10-25 with agent CLI 2.1.310 against a local stand-in API, no real key). When the
// provider refused, is_error is true, terminal_reason "api_error" and api_error_status the HTTP status; "result" is the CLI's rendering of
// the refusal. A run that did work has a cost, more than one turn or model usage. Only this record is read (review F1).
const record = (over: Record<string, unknown> = {}): string => JSON.stringify({
  type: "result", subtype: "success", is_error: true, api_error_status: 400, terminal_reason: "api_error", num_turns: 1,
  total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0 }, result: "Credit balance is too low", ...over,
});
const readOutcome = (stdout: string): Outcome | null => {
  const failure = readRunFailure(stdout);
  return failure ? anthropicClassifier.classify(failure.signal) : null;
};

describe("the structured result of a failed headless run", () => {
  it("reads the credit refusal, and says the run had done no work", () => {
    const failure = readRunFailure(record());
    expect(failure?.beforeWork).toBe(true);
    expect(failure?.signal).toMatchObject({ status: 400, retryAfterSeconds: null });
    expect(readOutcome(record())).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
  });
  it("reads the spend-limit refusal with the date it names", () => {
    const text = "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.";
    expect(readOutcome(record({ result: text }))).toEqual({ kind: "exhausted", reason: "spend-limit", resumeAt: Date.UTC(2026, 10, 1) });
  });
  it("reads the status alone: 401 rejected, 403 denied, 429 only a rate limit", () => {
    expect(readOutcome(record({ api_error_status: 401, result: "Invalid API key" }))).toEqual({ kind: "failing", reason: "rejected" });
    expect(readOutcome(record({ api_error_status: 403, result: "Forbidden" }))).toEqual({ kind: "failing", reason: "denied" });
    expect(readOutcome(record({ api_error_status: 429, result: "Too many requests" }))).toEqual({ kind: "limited", retryAfterMs: null });
    expect(readOutcome(record({ api_error_status: 500, result: "Internal server error" }))).toEqual({ kind: "unknown" });
  });
  it("a refusal the CLI reports with no status still reads from its text, when the CLI itself says it is an API error", () => {
    expect(readOutcome(record({ api_error_status: null, result: "Credit balance is too low" }))).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
  });
  it("takes the result record when the output is a list of records", () => {
    expect(readOutcome(JSON.stringify([{ type: "system", subtype: "init" }, JSON.parse(record())]))).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
  });

  it("review F3: the run had done work when it cost something, took more than one turn, or used a model", () => {
    for (const over of [{ total_cost_usd: 0.12 }, { num_turns: 3 }, { modelUsage: { "model-a": { inputTokens: 5 } } }, { usage: { input_tokens: 5, output_tokens: 2 } }]) {
      expect(readRunFailure(record(over))?.beforeWork, JSON.stringify(over)).toBe(false);
    }
  });
  it("review F3: a run that does not say what it cost is not known to have done no work", () => {
    const bare = JSON.parse(record()) as Record<string, unknown>;
    delete bare.total_cost_usd;
    expect(readRunFailure(JSON.stringify(bare))?.beforeWork).toBe(false);
    delete bare.num_turns;
    expect(readRunFailure(JSON.stringify(bare))?.beforeWork).toBe(false);
  });

  // Review F1: the model's and the tools' words are in the output too. None of these is the provider's refusal.
  const PROBES = [
    'const E = "authentication_failed";',
    "API Error: 403 forbidden",
    "expected API Error: 401 got 200",
    "Credit balance is too low",
    "account_on_hold",
    "You have reached your specified API usage limits. You will regain access on 9999-12-31 at 00:00 UTC.",
  ];
  it.each(PROBES)("review F1: %s inside the model's or a tool's text changes nothing", probe => {
    expect(readRunFailure(record({ api_error_status: null, terminal_reason: "completed", result: probe }))).toBeNull();     // a failed run, the model said it
    expect(readRunFailure(record({ api_error_status: null, terminal_reason: "max_turns", result: `see:\n${probe}\n` }))).toBeNull();
    expect(readRunFailure(`${probe}\n`)).toBeNull();                                                                       // text output
    expect(readRunFailure(`tests failed\n${probe}\nexit 1\n`)).toBeNull();
    expect(readRunFailure(`${probe}\n${record({ is_error: false, api_error_status: null, terminal_reason: "completed", result: "done" })}`)).toBeNull();
    expect(readRunFailure(JSON.stringify({ type: "assistant", message: probe }))).toBeNull();
  });
  it("review F1: a record-shaped string inside the model's result is only text", () => {
    const fake = '{"type":"result","is_error":true,"api_error_status":401,"terminal_reason":"api_error","result":"Invalid API key"}';
    expect(readRunFailure(record({ api_error_status: null, terminal_reason: "completed", result: fake }))).toBeNull();
    expect(readRunFailure(`tests failed\n${fake}\n`)).toBeNull();                      // text output with the line in it
  });
  it("the CLI's own output has a line break after the record, and is read", () => {
    expect(readOutcome(`${record()}\n`)).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
  });
  it("review F1: only the CLI's own result counts: not a record of another type, not a success, not a status that is a string", () => {
    expect(readRunFailure(record({ type: "assistant" }))).toBeNull();
    expect(readRunFailure(record({ is_error: false }))).toBeNull();
    expect(readRunFailure(record({ api_error_status: "401", terminal_reason: "completed" }))).toBeNull();
    expect(readRunFailure(record({ terminal_reason: "completed", api_error_status: null }))).toBeNull();
  });
  it("review F1: output that is not one JSON value reads as nothing, whatever a line of it says", () => {
    expect(readRunFailure("")).toBeNull();
    expect(readRunFailure("   \n")).toBeNull();
    expect(readRunFailure(`${record()}\n${record({ api_error_status: 401 })}`)).toBeNull();      // two records: not what the CLI prints
    expect(readRunFailure(`${record()} trailing words`)).toBeNull();
  });
});
