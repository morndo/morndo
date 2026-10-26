// What the agent CLI's `StopFailure` hook says (ADR-0037, slice 4, spike S2): a payload is read into the same signal a provider's answer gives, then
// classified by the first-party classifier. Payloads are the ones the real CLI (2.1.310) handed a hook on 2026-10-26 when a local stand-in
// answered with each refusal (test/fixtures/stopfailure, ids and paths replaced). The `error` code is only a hint (a 402 and a spend limit arrive as
// `unknown`); the text is read, and the status only from the CLI's own prefix. Nothing the payload holds beyond the clipped excerpt reaches the signal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Outcome } from "@morndo/domain";
import { anthropicClassifier, signalFromHook } from "../src/adapters/outcome-anthropic.ts";

const saved = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/stopfailure", `${name}.json`), "utf8")) as Record<string, unknown>;
const payload = (error: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ hook_event_name: "StopFailure", session_id: "s", transcript_path: "/work/t.jsonl", cwd: "/work", error, last_assistant_message: text, ...extra });
const classify = (value: unknown): Outcome | null => {
  const signal = signalFromHook(value);
  return signal === null ? null : anthropicClassifier.classify(signal);
};

describe("the saved payloads, one per refusal the real CLI gave", () => {
  it.each<[string, Outcome]>([
    ["credit-refusal-400", { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["billing-402", { kind: "exhausted", reason: "credit", resumeAt: null }],
    ["spend-limit-400", { kind: "exhausted", reason: "spend-limit", resumeAt: Date.UTC(2026, 10, 1) }],
    ["rate-limit-429", { kind: "limited", retryAfterMs: null }],
    ["invalid-key-401", { kind: "failing", reason: "rejected" }],
    ["forbidden-403", { kind: "failing", reason: "denied" }],
    ["account-on-hold-403", { kind: "failing", reason: "held" }],
    ["overloaded-529", { kind: "unknown" }],
  ])("%s", (name, expected) => {
    expect(classify(saved(name))).toEqual(expected);
  });
});

describe("the error code is a hint, the text is what is read", () => {
  it("the same credit text classifies the same under billing_error, unknown and invalid_request", () => {
    for (const error of ["billing_error", "unknown", "invalid_request"]) {
      expect(classify(payload(error, "Credit balance is too low")), error).toEqual({ kind: "exhausted", reason: "credit", resumeAt: null });
    }
  });
  it("a code that is no refusal of the key gives no signal, even with a credit phrase in the text", () => {
    for (const error of ["server_error", "overloaded", "max_output_tokens", "model_not_found", "oauth_org_not_allowed", "cloud_credential_error"]) {
      expect(signalFromHook(payload(error, "Credit balance is too low")), error).toBeNull();
    }
  });
  it("authentication_failed with no status in the text is a refused key (401)", () => {
    expect(classify(payload("authentication_failed", "Invalid API key · Fix external API key"))).toEqual({ kind: "failing", reason: "rejected" });
  });
  it("rate_limit with no status in the text is still limited", () => {
    expect(classify(payload("rate_limit", "Rate limit reached"))).toEqual({ kind: "limited", retryAfterMs: null });
  });
  it("an account_on_hold code is a hold, whatever the text says about it", () => {
    expect(classify(payload("account_on_hold", "API Error: 403 account_on_hold"))).toEqual({ kind: "failing", reason: "held" });
    expect(classify(payload("account_on_hold", "This organization is on hold"))).toEqual({ kind: "failing", reason: "held" });
  });
});

describe("the status is read only from the CLI's own prefix", () => {
  it("a credit phrase after a different status is not exhausted (control: a reader that takes any three digits fails this)", () => {
    const text = "API Error: 500 Internal server error. Reference 400 credit balance is too low";
    expect(classify(payload("unknown", text))).toEqual({ kind: "unknown" });
  });
  it("a status in the middle of the text is not a status", () => {
    const text = "Something odd happened while the tool printed API Error: 402 billing";
    const signal = signalFromHook(payload("unknown", text));
    expect(signal?.status ?? null).toBeNull();
    expect(classify(payload("unknown", text))).toEqual({ kind: "unknown" });
  });
  it("a 402 stands for billing_error; any other status carries no type", () => {
    expect(signalFromHook(saved("billing-402"))).toMatchObject({ status: 402, kind: "billing_error" });
    expect(signalFromHook(saved("spend-limit-400"))).toMatchObject({ status: 400, kind: null });
    expect(signalFromHook(saved("rate-limit-429"))).toMatchObject({ status: 429, kind: null, code: null });
  });
  it("a hold is a hold only on a 401 or 403, or with no status: a 400 that echoes the word is the caller's text", () => {
    expect(classify(payload("unknown", "API Error: 400 account_on_hold"))).toEqual({ kind: "unknown" });
  });
});

describe("what a signal keeps", () => {
  it("only the excerpt the classifier already clips: no transcript path, session, cwd, error_details or message beyond 256 characters", () => {
    const planted = "planted-secret-in-the-hook-payload";
    const long = `Credit balance is too low ${"x".repeat(400)} ${planted}`;
    const signal = signalFromHook(payload("billing_error", long, { error_details: planted, transcript_path: `/work/${planted}.jsonl`, cwd: `/work/${planted}`, session_id: planted }));
    expect(signal).not.toBeNull();
    expect(JSON.stringify(signal)).not.toContain(planted);
    expect(signal?.text?.length ?? 0).toBeLessThanOrEqual(256);
    expect(signal?.resumeDate ?? null).toBeNull();
  });
  it("the spend-limit date is read from the whole message, not from the cut excerpt", () => {
    const text = `API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.`;
    expect(signalFromHook(payload("unknown", text))?.resumeDate).toBe("2026-11-01");
  });
});

describe("what is not a StopFailure refusal gives no signal", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["another event", { hook_event_name: "Stop", error: "billing_error", last_assistant_message: "Credit balance is too low" }],
    ["no event name", { error: "billing_error", last_assistant_message: "Credit balance is too low" }],
    ["no text", { hook_event_name: "StopFailure", error: "billing_error" }],
    ["a text that is not a string", payload("billing_error", "x", { last_assistant_message: 4 })],
    ["an error that is not a string", payload("x", "Credit balance is too low", { error: 7 })],
    ["a text over 4 KB", payload("billing_error", `Credit balance is too low ${"y".repeat(4100)}`)],
  ])("%s", (_name, value) => {
    expect(signalFromHook(value)).toBeNull();
  });
});
