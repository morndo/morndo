// The first-party error dialect (ADR-0037): a refusal becomes a key-pool outcome. A body is the error document
// {type:"error", error:{type, message, details?}, request_id}. A printed line is undocumented, so the text reader
// accepts the same words wherever they sit. A signal keeps at most 256 characters of that text; the outcome keeps none.
import type { Outcome } from "@morndo/domain";
import type { OutcomeClassifier, ProviderSignal } from "../application/ports.ts";

const TEXT_LIMIT = 256;

// "You will regain access on YYYY-MM-DD …" — the date is read from the whole message, not from the cut excerpt.
const RESUME_DATE = /regain access on (\d{4}-\d{2}-\d{2})/;
const API_ERROR = /API Error:\s*(\d{3})(?!\d)/;
const ERROR_TYPE = /"type"\s*:\s*"([A-Za-z0-9_]+_error)"/;
const ERROR_CODE = /"error_code"\s*:\s*"([A-Za-z0-9_]+)"/;
const MESSAGE = /"message"\s*:\s*"(?:\\.|[^"\\])*"/;
// Only the identifiers: ordinary words ("authentication failed" from git or ssh) in a run's output say nothing about the key.
const HELD = /account_on_hold|authentication_failed/i;
const CREDIT = /credit balance (?:is )?too low/i;
const SPEND = /you have reached your specified (?:workspace )?API usage limits/i;
const SPEND_CODE = /enforced_spend_limit_reached/i;

const TEXT_HITS: readonly RegExp[] = [API_ERROR, ERROR_TYPE, ERROR_CODE, MESSAGE, CREDIT, SPEND, HELD, SPEND_CODE];

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

function firstHit(output: string): number | null {
  let at: number | null = null;
  for (const pattern of TEXT_HITS) {
    const found = pattern.exec(output);
    if (found && (at === null || found.index < at)) at = found.index;
  }
  return at;
}

export function signalFromText(output: string): ProviderSignal {
  const at = firstHit(output);
  if (at === null) return { status: null, kind: null, text: null, retryAfterSeconds: null, code: null, resumeDate: null };
  const statusText = API_ERROR.exec(output)?.[1];
  return {
    status: statusText === undefined ? null : Number(statusText),
    kind: ERROR_TYPE.exec(output)?.[1] ?? null,
    text: clip(output, at),
    retryAfterSeconds: null,
    code: ERROR_CODE.exec(output)?.[1] ?? null,
    resumeDate: resumeDateIn(output),
  };
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
    if (matches(signal.text, HELD)) return { kind: "failing", reason: "held" };
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
