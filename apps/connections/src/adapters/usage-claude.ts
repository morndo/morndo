// A Claude subscription's usage windows, read the documented way (plan 4.4): the unmodified CLI's own headless
// `/usage`, run under the account's own config directory — never the OAuth usage endpoint, never a token, never a
// credentials file. This module is the pure half: it maps the report's stream-json lines to reading windows, or to
// the one closed-list reason the read failed. `claude -p /usage --output-format stream-json --verbose
// --no-session-persistence` prints newline-delimited events (a system init, hook events, an assistant message whose
// event carries the report under a `usage_report` key, a final result); wherever the report sits in the event, the
// parse searches the event's JSON for that key. The type is experimental, so an answer outside the shape is
// "unknown_screen", never a guess, and `rate_limits: null` (a setup-token login has no usage scope) is "no_scope",
// never 0%. `extra_usage` is ignored in this slice. Made-up shapes only in tests and fixtures.
import type { UsageReason } from "@morndo/domain";

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

// Maps the report: `percent` goes through the domain's takePercent (out of range or not a number: that window is
// dropped, never clamped); `resets_at` is ISO 8601 to epoch seconds (unparseable: null). An `is_error` result or
// error text is classified by its words: login/sign in/401/403/authentication -> signed_out, organization/not
// allowed -> refused, 429/rate limit -> rate_limited (retryAfterS from a "retry after N" number), anything else
// unknown_screen with a redacted head of the last stdout line as the hint.
export function parseClaudeReport(lines: readonly string[]): ClaudeReadResult {
  void lines;
  throw new Error("not implemented");
}
