// The first-party error dialect (ADR-0037): a refusal becomes a key-pool outcome. A body is the error document
// {type:"error", error:{type, message, details?}, request_id}. A failed headless run is read only through the agent CLI's own structured
// result (readRunFailure), never through free text, which holds the model's and the tools' words too (review F1). A signal keeps at most
// 256 characters of the provider's message; the outcome keeps none.
import type { Outcome } from "@morndo/domain";
import type { OutcomeClassifier, ProviderSignal } from "../application/ports.ts";

const TEXT_LIMIT = 256;

// "You will regain access on YYYY-MM-DD …" — the date is read from the whole message, not from the cut excerpt.
const RESUME_DATE = /regain access on (\d{4}-\d{2}-\d{2})/;
// Only the identifiers: ordinary words ("authentication failed" from git or ssh) in a run's output say nothing about the key.
const HELD = /account_on_hold|authentication_failed/i;
export const CREDIT = /credit balance (?:is )?too low/i;
export const SPEND = /you have reached your specified (?:workspace )?API usage limits/i;

function resumeDateIn(text: string): string | null {
  return RESUME_DATE.exec(text)?.[1] ?? null;
}

function clip(text: string, at = 0): string {
  const start = at < 0 ? 0 : at;
  return text.slice(start, start + TEXT_LIMIT);
}

function seconds(header: string | null): number | null {
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// The error document, or null when the body is not that JSON. A miss is plain text, not a guessed type.
function errorBody(body: string): { kind: string; message: string; code: string | null } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const root = record(parsed);
  const error = root ? record(root.error) : null;
  if (!error || typeof error.type !== "string" || typeof error.message !== "string") return null;
  const details = record(error.details);
  const code = details && typeof details.error_code === "string" ? details.error_code : null;
  return { kind: error.type, message: error.message, code };
}

export function signalFromBody(status: number | null, body: string | null, retryAfter: string | null): ProviderSignal {
  const retryAfterSeconds = seconds(retryAfter);
  if (body === null) return { status, kind: null, text: null, retryAfterSeconds, code: null, resumeDate: null };
  const error = errorBody(body);
  if (!error) {
    return { status, kind: null, text: clip(body), retryAfterSeconds, code: null, resumeDate: resumeDateIn(body) };
  }
  return {
    status, kind: error.kind, text: clip(error.message), retryAfterSeconds, code: error.code,
    resumeDate: resumeDateIn(error.message),
  };
}

// The `error` codes of a StopFailure hook that are no refusal of the key: their text is never read.
const NOT_THE_KEY = new Set(["server_error", "overloaded", "max_output_tokens", "model_not_found", "oauth_org_not_allowed", "cloud_credential_error"]);
const HOOK_TEXT_LIMIT = 4096;
// The agent CLI's own prefixes, anchored at the start: "API Error: 402 …", "Failed to authenticate. API Error: 403 …", "API Error: Request rejected (429) · …".
const HOOK_STATUS = /^(?:Failed to authenticate\. )?API Error: (?:Request rejected \()?(\d{3})\b/;
const HOOK_HINT_STATUS: Readonly<Record<string, number>> = { authentication_failed: 401, rate_limit: 429, account_on_hold: 403 };

// The JSON a `StopFailure` hook gets on stdin (spike S2, 2026-10-26), read into the signal a provider's answer gives. The `error` code is a hint: a 402
// and a spend limit arrive as `unknown`, so the text is read for every code that can be a refusal of the key. The status comes only from the CLI's
// own prefix. Nothing else of the payload is kept: not error_details, the transcript path, the session, nor the message beyond the clipped excerpt.
export function signalFromHook(value: unknown): ProviderSignal | null {
  const root = record(value);
  if (!root || root.hook_event_name !== "StopFailure") return null;
  const { error, last_assistant_message: message } = root;
  if (typeof error !== "string" || typeof message !== "string" || message.length > HOOK_TEXT_LIMIT) return null;
  if (NOT_THE_KEY.has(error)) return null;
  const status = Number(HOOK_STATUS.exec(message.slice(0, 120))?.[1] ?? HOOK_HINT_STATUS[error] ?? NaN);
  const text = error === "account_on_hold" ? `account_on_hold ${message}` : message;
  return {
    status: Number.isNaN(status) ? null : status,
    kind: status === 402 ? "billing_error" : null,
    text: clip(text),
    retryAfterSeconds: null,
    code: null,
    resumeDate: resumeDateIn(message),
  };
}

export type RunFailure = { signal: ProviderSignal; beforeWork: boolean };

// The agent CLI prints one JSON value: a result record, or a list of records whose result is last. Anything else is not a refusal.
export function readRunFailure(stdout: string): RunFailure | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const row = resultRecord(parsed);
  if (!row || row.type !== "result" || row.is_error !== true) return null;
  const status = typeof row.api_error_status === "number" && Number.isInteger(row.api_error_status) ? row.api_error_status : null;
  if (status === null && row.terminal_reason !== "api_error") return null;
  const text = typeof row.result === "string" ? row.result : null;
  return {
    signal: {
      status,
      kind: null,
      text: text === null ? null : clip(text),
      retryAfterSeconds: null,
      code: null,
      resumeDate: text === null ? null : resumeDateIn(text),
    },
    beforeWork: beforeWork(row),
  };
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return record(value);
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const row = record(value[i]);
    if (row?.type === "result") return row;
  }
  return null;
}

function beforeWork(row: Record<string, unknown>): boolean {
  if (row.total_cost_usd !== 0) return false;
  if (typeof row.num_turns !== "number" || !(row.num_turns <= 1)) return false;
  if ("modelUsage" in row) {
    const usage = record(row.modelUsage);
    if (!usage || Object.keys(usage).length > 0) return false;
  }
  if ("usage" in row) {
    const usage = record(row.usage);
    if (!usage || usage.input_tokens !== 0 || usage.output_tokens !== 0) return false;
  }
  return true;
}

function resumeAt(resumeDate: string | null): number | null {
  if (resumeDate === null) return null;
  const at = Date.parse(`${resumeDate}T00:00:00Z`);
  return Number.isNaN(at) ? null : at;
}

function matches(text: string | null, pattern: RegExp): boolean {
  return text !== null && pattern.test(text);
}

// Order is the contract: a success is ok before any phrase, a hold before a 401/403, a named 429 before a plain one.
export const anthropicClassifier: OutcomeClassifier = {
  classify(signal): Outcome {
    const { status } = signal;
    if (status !== null && status >= 200 && status <= 299) return { kind: "ok", evidence: "messages" };
    // A hold is the provider's word on a 401 or 403, or on a structured result that names no status; a 400 that echoes the words is the caller's text.
    if ((status === null || status === 401 || status === 403) && matches(signal.text, HELD)) return { kind: "failing", reason: "held" };
    if ((status === null || status === 400 || status === 402) && matches(signal.text, CREDIT)) {
      return { kind: "exhausted", reason: "credit", resumeAt: null };
    }
    if (status === 402 && signal.kind === "billing_error") return { kind: "exhausted", reason: "credit", resumeAt: null };
    if ((status === null || status === 400) && matches(signal.text, SPEND)) {
      return { kind: "exhausted", reason: "spend-limit", resumeAt: resumeAt(signal.resumeDate) };
    }
    if (status === 429 && signal.code === "enforced_spend_limit_reached") return { kind: "failing", reason: "cap" };
    if (status === 429) {
      const retryAfterMs = signal.retryAfterSeconds === null ? null : signal.retryAfterSeconds * 1000;
      return { kind: "limited", retryAfterMs };
    }
    if (status === 401) return { kind: "failing", reason: "rejected" };
    if (status === 403) return { kind: "failing", reason: "denied" };
    return { kind: "unknown" };
  },
};
