// A Z.ai quota answer, mapped (S7, plan 4.6, AT-39): the pure half only — the status, the Retry-After header and the
// body in, limit windows or the one closed-list reason out. Driving the HTTP call stays in the operator's collector,
// outside this repository (plan section 6). Windows are told by their `unit` and `number` alone (unit 3 is hours,
// unit 6 is weeks), never by array order or a sort on the reset: the weekly and the 5-hour entries swap order near
// the end of a week. The credit windows refresh after use, so every window this reader maps is rolling. Made-up
// shapes only in tests and fixtures.
import { takePercent, type UsageReason } from "@morndo/domain";
import { hintOf, type ReadingWindow } from "./usage-claude.ts";

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

const SIGN_IN_CODES = [401, 403, 1000, 1001, 1003, 1005];
const RATE_CODES = [1302];
const PLAN_ENDED_CODES = [1309, 1314];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// The hint of an unknown shape (the usage-claude rule): the fixed shape `unknown shape ${hash}` and nothing else —
// the hash the first 8 hex characters of the sha256 of the body's first 120 characters as JSON, enough to tell two
// broken shapes apart, never enough to repeat a word the provider printed.
const shapeHint = (body: unknown): string => hintOf(JSON.stringify(body) ?? "");

// The Retry-After header as whole seconds: only a non-negative integer counts, anything else (an HTTP date, a word)
// is no number at all.
const retrySeconds = (v: string | null): number | null => {
  if (v === null || !/^\d+$/.test(v)) return null;
  return Number(v);
};

// The used percent of one limit: `percentage` when the entry carries a number, else `currentValue * 100 / usage`
// when `usage` is a positive number — then through the domain's takePercent, so an out-of-range or epoch-like value
// is no number (that window is dropped, never shown as 0%).
const percentOf = (entry: Record<string, unknown>): number | null => {
  if (typeof entry.percentage === "number") return takePercent(entry.percentage);
  const current = entry.currentValue;
  const usage = entry.usage;
  if (typeof current === "number" && Number.isFinite(current) && typeof usage === "number" && Number.isFinite(usage) && usage > 0)
    return takePercent((current * 100) / usage);
  return null;
};

// The two named windows (plan 4.1): 300 minutes is the 5-hour one and 10080 the weekly one, whatever the entry's own
// numbers; any other length names the window by its minutes; no length at all is the plain `Limit` id, with
// `unit<u>/<n>` appended when the entry gave both numbers. Cut to the wire's own 40 characters.
const FIVE_HOURS = 300;
const SEVEN_DAYS = 10_080;
const ID_LIMIT = 40;
const idOf = (unit: number, n: number): { id: string; lengthMins: number | null } => {
  const lengthMins = unit === 3 ? n * 60 : unit === 6 ? n * 10080 : null;
  if (lengthMins === FIVE_HOURS) return { id: "five_hour", lengthMins };
  if (lengthMins === SEVEN_DAYS) return { id: "seven_day", lengthMins };
  if (lengthMins !== null) return { id: `Window ${lengthMins} min`, lengthMins };
  return { id: `Limit unit${unit}/${n}`.slice(0, ID_LIMIT), lengthMins: null };
};

export function parseZaiQuota(answer: ZaiQuotaAnswer): ZaiReadResult {
  const { status, retryAfter, body } = answer;
  // The failure classes, in their order: the sign-in ones first (an HTTP 200 carrying a sign-in `code` is one), then the
  // rate limit with the provider's own retry word, then an unknown page, then the codes the provider lists for a plan
  // that has ended or a rate limit, and only then the network and server faults. The codes are Z.ai's own error table
  // (https://docs.z.ai/api-reference/api-code, read 2026-10-24: 1000, 1001, 1003 and 1005 are authentication, 1302 a
  // rate limit, 1309 and 1314 an expired package); the table is the model API's, and that the quota call shares it is
  // unverified — a code nobody listed stays the transient `unreachable`, never a guess at a cause.
  const code = isObject(body) && typeof body.code === "number" ? body.code : null;
  if (status === 401 || status === 403 || (code !== null && SIGN_IN_CODES.includes(code)))
    return { ok: false, reason: "signed_out", retryAfterS: null, hint: null };
  if (status === 429 || (code !== null && RATE_CODES.includes(code)))
    return { ok: false, reason: "rate_limited", retryAfterS: retrySeconds(retryAfter), hint: null };
  if (status === 404) return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: shapeHint(body) };
  if (code !== null && PLAN_ENDED_CODES.includes(code))
    return { ok: false, reason: "plan_ended", retryAfterS: null, hint: null };
  if ((isObject(body) && body.success === false) || status >= 500)
    return { ok: false, reason: "unreachable", retryAfterS: null, hint: null };
  const limits = isObject(body) && isObject(body.data) && Array.isArray(body.data.limits) ? body.data.limits : null;
  if (limits === null || limits.length === 0)
    return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: shapeHint(body) };
  // Every entry of a type this reader knows, with the id and length its own unit and number give it. CREDIT_LIMIT is
  // accepted wherever TOKENS_LIMIT was; anything else is no limit this reader knows. A tokens limit with neither
  // unit nor number is the legacy 5-hour window: it only fills an id no explicit entry claims, so it never shadows
  // the explicit 5-hour entry whichever comes first in the array.
  type Known = { entry: Record<string, unknown>; id: string; lengthMins: number | null; legacy: boolean };
  const known: Known[] = [];
  for (const entry of limits) {
    if (!isObject(entry)) continue;
    if (entry.type !== "CREDIT_LIMIT" && entry.type !== "TOKENS_LIMIT") continue;
    const unit = typeof entry.unit === "number" && Number.isFinite(entry.unit) ? entry.unit : null;
    const n = typeof entry.number === "number" && Number.isFinite(entry.number) ? entry.number : null;
    if (unit === null && n === null) known.push({ entry, id: "five_hour", lengthMins: FIVE_HOURS, legacy: true });
    else if (unit !== null && n !== null) known.push({ entry, ...idOf(unit, n), legacy: false });
    else known.push({ entry, id: "Limit", lengthMins: null, legacy: false });       // a missing unit or number: no length
  }
  // Limits but none of them a limit this reader knows: nothing was read, the screen is not in a shape it knows.
  if (known.length === 0) return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: shapeHint(body) };
  // Two explicit entries claiming one id: the first by array order wins and the other is dropped, never both; a
  // legacy entry is kept only when no explicit one claimed its id.
  const claimed = new Set<string>();
  const kept = new Set<Known>();
  for (const k of known) if (!k.legacy && !claimed.has(k.id)) { claimed.add(k.id); kept.add(k); }
  for (const k of known) if (k.legacy && !claimed.has(k.id)) { claimed.add(k.id); kept.add(k); }
  const windows: ReadingWindow[] = [];
  const missing: string[] = [];
  for (const k of known) {
    if (!kept.has(k)) continue;
    const usedPercent = percentOf(k.entry);
    if (usedPercent === null) {
      missing.push(k.id);                      // dropped, never shown as 0%; the hub shows it as missing
      continue;
    }
    // A reset in the past is read as it is: the hub's staleness rules judge it, not the parser.
    const resets = typeof k.entry.nextResetTime === "number" && Number.isFinite(k.entry.nextResetTime) ? Math.floor(k.entry.nextResetTime / 1000) : null;
    windows.push({ id: k.id, used_percent: usedPercent, resets_at: resets, length_mins: k.lengthMins, rolling: true, note: null });
  }
  // Limits it knows by type but cannot read at all (a percent that is a string, say): the shape has changed, which is an
  // unknown screen, never an ok read with nothing in it.
  if (windows.length === 0) return { ok: false, reason: "unknown_screen", retryAfterS: null, hint: shapeHint(body) };
  // The named ids no entry gave are missing, never a failure (the hub shows a missing weekly entry as missing).
  for (const named of ["five_hour", "seven_day"]) if (!claimed.has(named) && !missing.includes(named)) missing.push(named);
  return { ok: true, windows, missing };
}

export function zaiReadingBody(parsed: Extract<ZaiReadResult, { ok: true }>, o: { node: string | null; now: number }): ZaiReadingBody {
  // A pure mapping of an ok result, no lease: the collector's own token and timing drive the read, never this.
  return { source: "vendor-api", node: o.node, captured_at: Math.floor(o.now / 1000), every_s: 300, plan: null, windows: parsed.windows };
}
