// A Z.ai quota answer, mapped (S7, plan 4.6, AT-39): the pure half only — the status, the Retry-After header and the
// body in, limit windows or the one closed-list reason out. Driving the HTTP call stays in the operator's collector,
// outside this repository (plan section 6). Windows are told by their `unit` and `number` alone (unit 3 is hours,
// unit 6 is weeks), never by array order or a sort on the reset: the weekly and the 5-hour entries swap order near
// the end of a week. The credit windows refresh after use, so every window this reader maps is rolling. Made-up
// shapes only in tests and fixtures.
import type { UsageReason } from "@morndo/domain";
import type { ReadingWindow } from "./usage-claude.ts";

// One quota answer as the collector hands it over: the HTTP status, the Retry-After header verbatim (whole seconds
// only; an HTTP date is not supported), and the parsed body.
export type ZaiQuotaAnswer = { status: number; retryAfter: string | null; body: unknown };

// The read's result: the windows it can see plus the ids of the two named ones no entry gave (`missing`, shown by
// the hub as missing, never a failure), or the one reason it cannot see anything.
export type ZaiReadResult =
  | { ok: true; windows: ReadingWindow[]; missing: string[] }
  | { ok: false; reason: UsageReason; retryAfterS: number | null; hint: string | null };

// The reading body a Z.ai collector posts to the hub's readings route: a pure mapping of an ok result, no lease.
// Epoch seconds here, as on the whole readings wire.
export type ZaiReadingBody = {
  source: "vendor-api";
  node: string | null;
  captured_at: number;            // seconds
  every_s: 300;
  plan: null;
  windows: ReadingWindow[];
};

export function parseZaiQuota(answer: ZaiQuotaAnswer): ZaiReadResult {
  void answer;
  throw new Error("not implemented");
}

export function zaiReadingBody(parsed: Extract<ZaiReadResult, { ok: true }>, o: { node: string | null; now: number }): ZaiReadingBody {
  void parsed; void o;
  throw new Error("not implemented");
}
