// A Claude subscription's usage windows, read the documented way (plan 4.4): the unmodified CLI's own headless
// `/usage`, run under the account's own config directory — never the OAuth usage endpoint, never a token, never a
// credentials file. This module is the mapping half: it maps the report's stream-json lines to reading windows, or
// to the one closed-list reason the read failed. `claude -p /usage --tools "" --output-format stream-json --verbose
// --no-session-persistence` prints newline-delimited events (a system init, hook events, an assistant message whose
// event carries the report under a `usage_report` key, a final result); wherever the report sits in the event, the
// parse searches the event's JSON for that key. The type is experimental, so an answer outside the shape is
// "unknown_screen", never a guess, and `rate_limits: null` (a setup-token login has no usage scope) is "no_scope",
// never 0%. An unknown_screen's hint is never the CLI's own words — only the fixed shape `unknown shape ${hash}`
// (fix round 2026-10-24, finding 5), so no name, token, address or UUID of a screen this reader does not know can
// reach the hub. `extra_usage` is ignored in this slice. Made-up shapes only in tests and fixtures.
import { createHash } from "node:crypto";
import { takePercent, type UsageReason } from "@morndo/domain";

// One window of the report, as a reading posts it (U14): epoch seconds here, milliseconds in the domain. `session`
// is the 5-hour window (300 minutes), `weekly_all` the weekly one (10080); a `weekly_scoped` window is titled with
// its model scope and claims no length — the hub names a window of 10080 minutes the weekly one, so a scoped weekly
// window must not claim that length.
export type ReadingWindow = {
  id: string;
  used_percent: number;
  resets_at: number | null;
  length_mins: number | null;
  rolling: boolean;
  note: string | null;
};

// The read's result: the windows it can see, or the one reason it cannot (with the provider's own retry word when it
// gave one, in whole seconds).
export type ClaudeReadResult =
  | { ok: true; windows: ReadingWindow[] }
  | { ok: false; reason: UsageReason; retryAfterS: number | null; hint: string | null };

// The kinds the report names (plan 4.4): what each becomes as a reading window. A `weekly_scoped` window's id is
// `Weekly (<model>)` cut to 40 characters (the wire's own limit), with no length of its own.
const KINDS: Record<string, { id: string; lengthMins: number | null } | "scoped"> = {
  session: { id: "five_hour", lengthMins: 300 },
  weekly_all: { id: "seven_day", lengthMins: 10_080 },
  weekly_scoped: "scoped",
};
const ID_LIMIT = 40;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// The value of the `usage_report` key anywhere in the event's JSON (the report sits in the assistant message's
// event, but the type is experimental, so the place it sits is not relied on), or undefined when there is none.
// Where an event carries more than one, the last in document order is the report.
function findReport(v: unknown): unknown {
  let found: unknown;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "usage_report" && isObject(value)) found = value;
      else walk(value);
    }
  };
  walk(v);
  return found;
}

// The hint of an unknown screen (fix round 2026-10-24, finding 5): the fixed shape `unknown shape ${hash}` and
// nothing else — the hash the first 8 hex characters of the sha256 of the last stdout line's first 120 characters,
// enough to tell two broken shapes apart, never enough to repeat a word the CLI printed.
const HINT_HEAD = 120;
export function hintOf(lastLine: string): string {
  return `unknown shape ${createHash("sha256").update(lastLine.slice(0, HINT_HEAD)).digest("hex").slice(0, 8)}`;
}

// The report's own window: `percent` goes through the domain's takePercent (out of range or not a number: that
// window is dropped, never clamped); `resets_at` is ISO 8601 to epoch seconds (unparseable: null).
function windowOf(row: unknown): ReadingWindow | null {
  if (!isObject(row)) return null;
  const kind = KINDS[typeof row.kind === "string" ? row.kind : ""];
  if (kind === undefined) return null;
  const usedPercent = takePercent(row.percent);
  if (usedPercent === null) return null;
  let id: string;
  let lengthMins: number | null;
  if (kind === "scoped") {
    const model = isObject(row.scope) && typeof row.scope.model === "string" ? row.scope.model.trim() : "";
    if (model === "") return null;                       // a scoped window with no model names nothing
    id = `Weekly (${model})`.slice(0, ID_LIMIT);
    lengthMins = null;
  } else {
    id = kind.id;
    lengthMins = kind.lengthMins;
  }
  const resets = typeof row.resets_at === "string" ? Date.parse(row.resets_at) : Number.NaN;
  return { id, used_percent: usedPercent, resets_at: Number.isFinite(resets) ? Math.floor(resets / 1000) : null, length_mins: lengthMins, rolling: false, note: null };
}

// An `is_error` result's own words, classified (plan 4.3 item 6): the login words are signed_out, the organization
// words refused, the rate-limit words rate_limited with the provider's own retry word when it gave one, anything
// else unknown_screen with the fixed hashed hint of the last line.
function classifyError(text: string, lastLine: string): ClaudeReadResult {
  const words = text.toLowerCase();
  if (words.includes("login") || words.includes("sign in") || words.includes("401") || words.includes("403") || words.includes("authentication"))
    return { ok: false, reason: "signed_out", retryAfterS: null, hint: null };
  if (words.includes("organization") || words.includes("not allowed"))
    return { ok: false, reason: "refused", retryAfterS: null, hint: null };
  if (words.includes("429") || words.includes("rate limit")) {
    const retry = /retry[- ]after\s+(\d+)/.exec(words);
    return { ok: false, reason: "rate_limited", retryAfterS: retry !== null ? Number(retry[1]) : null, hint: null };
  }
  return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: hintOf(lastLine) };
}

// Maps the report: `percent` goes through the domain's takePercent (out of range or not a number: that window is
// dropped, never clamped); `resets_at` is ISO 8601 to epoch seconds (unparseable: null). An `is_error` result or
// error text is classified by its words: login/sign in/401/403/authentication -> signed_out, organization/not
// allowed -> refused, 429/rate limit -> rate_limited (retryAfterS from a "retry after N" number), anything else
// unknown_screen with a redacted head of the last stdout line as the hint.
export function parseClaudeReport(lines: readonly string[]): ClaudeReadResult {
  let report: unknown;
  let errorText: string | null = null;
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }   // a line that is not JSON carries no report and no error
    if (isObject(event) && event.is_error === true) {
      const text = typeof event.result === "string" ? event.result : "";
      errorText = text;                                     // the last error result is the one that ended the run
    }
    const found = findReport(event);
    if (found !== undefined) report = found;                // the last report in the stream is the report
  }
  const last = lines.length > 0 ? lines[lines.length - 1]! : "";
  if (errorText !== null) return classifyError(errorText, last);
  if (report === undefined) {
    // Nothing this reader knows: only the fixed hashed hint of the last line (finding 5) — never its own words.
    return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: hintOf(last) };
  }
  const rateLimits = (report as Record<string, unknown>).rate_limits;
  if (rateLimits === null) return { ok: false, reason: "no_scope", retryAfterS: null, hint: null };
  if (!isObject(rateLimits) || !Array.isArray(rateLimits.limits))
    return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: null };
  const windows: ReadingWindow[] = [];
  for (const row of rateLimits.limits) {
    const w = windowOf(row);
    if (w !== null) windows.push(w);
  }
  return { ok: true, windows };
}
