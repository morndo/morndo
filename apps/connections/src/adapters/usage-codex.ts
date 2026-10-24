// A Codex subscription's usage windows, read through the installed CLI's app server (ADR-0028 decision 5; ADR-0024's
// bridge on one machine). `codex app-server` speaks JSON-RPC on stdio, one object per line without the "jsonrpc" field; a
// client sends `initialize` (clientInfo) and then the `initialized` notification before anything else. The answer to
// `account/rateLimits/read` is { rateLimits: { primary, secondary, planType, … }, rateLimitsByLimitId, … }; a window is
// { usedPercent, windowDurationMins, resetsAt }, resetsAt in Unix seconds.
// https://learn.chatgpt.com/docs/app-server (read 2026-10-15). The shape is the one `codex app-server
// generate-json-schema` writes for codex-cli 0.161.0 (v2/GetAccountRateLimitsResponse.json, 2026-10-15).
// The app server is experimental, "aren't supported for production workloads" (same page): an answer in any other shape
// is "unavailable", never a guess. Its stderr is never read, and the caller hands it childEnv (no key variable).
import { CONNECTION_WORDS } from "@morndo/protocol";
import { askAppServer } from "./codex-account.ts";

export const CODEX_USAGE_TIMEOUT_MS = 15_000;
const FIVE_HOURS = 300;
const SEVEN_DAYS = 10_080;

export type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
// `others`: the account's other limits, from rateLimitsByLimitId (v2/GetAccountRateLimitsResponse.json, a map of limit id to
// snapshot; the default limit usually appears there under its own id too, and is not repeated).
export type CodexOther = { limitId: string; name: string | null; primary: CodexWindow | null; secondary: CodexWindow | null };
export type CodexLimits = { primary: CodexWindow | null; secondary: CodexWindow | null; planType: string | null; others: CodexOther[] };
export type CodexReading = { ok: true; limits: CodexLimits } | { ok: false; problem: string };
type Row = { used_percentage: number; resets_at: number | null };
export type CodexUsageBody = {
  session_id: string;
  model: { display_name: string };
  rate_limits?: { five_hour?: Row; seven_day?: Row };
  limits?: (Row & { label: string })[];
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// A window, null when the answer has none, undefined when it is in a shape this reader doesn't know.
function windowOf(v: unknown): CodexWindow | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || typeof v.usedPercent !== "number" || !Number.isFinite(v.usedPercent)) return undefined;
  const mins = v.windowDurationMins;
  const at = v.resetsAt;
  return {
    usedPercent: v.usedPercent,
    windowDurationMins: typeof mins === "number" && Number.isInteger(mins) && mins > 0 ? mins : null,
    resetsAt: typeof at === "number" && Number.isFinite(at) ? at : null,
  };
}

// The read's result as limits, or null when it isn't the 0.161.0 shape.
export function limitsFromResult(result: unknown): CodexLimits | null {
  if (!isObject(result) || !isObject(result.rateLimits)) return null;
  const r = result.rateLimits;
  const primary = windowOf(r.primary);
  const secondary = windowOf(r.secondary);
  if (primary === undefined || secondary === undefined) return null;
  const planType = typeof r.planType === "string" && /^[a-z0-9_]{1,40}$/.test(r.planType) ? r.planType : null;
  const others: CodexOther[] = [];
  const byId = result.rateLimitsByLimitId;
  if (byId !== null && byId !== undefined) {
    if (!isObject(byId)) return null;
    for (const [limitId, snapshot] of Object.entries(byId)) {
      if (limitId === r.limitId) continue;
      if (!isObject(snapshot)) return null;
      const p = windowOf(snapshot.primary);
      const q = windowOf(snapshot.secondary);
      if (p === undefined || q === undefined) return null;
      const name = typeof snapshot.limitName === "string" && snapshot.limitName.trim() !== "" ? snapshot.limitName.trim() : null;
      if (p || q) others.push({ limitId, name, primary: p, secondary: q });
    }
  }
  return { primary, secondary, planType, others };
}

export function windowLabel(mins: number | null): string {
  if (mins === FIVE_HOURS) return CONNECTION_WORDS.windows.fiveHour;
  if (mins === SEVEN_DAYS) return CONNECTION_WORDS.windows.sevenDay;
  if (mins === null) return "Window";
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

// The status-line JSON (ADR-0016): a 5-hour and a 7-day window as rate_limits; any other set as named limits, which Home
// then shows instead of its two fixed rows. Percentages and resets are the CLI's own.
export function usageReport(limits: CodexLimits, sessionId: string): CodexUsageBody {
  const windows = [limits.primary, limits.secondary].filter((w): w is CodexWindow => w !== null);
  const row = (w: CodexWindow): Row => ({ used_percentage: w.usedPercent, resets_at: w.resetsAt });
  const five = windows.filter(w => w.windowDurationMins === FIVE_HOURS);
  const week = windows.filter(w => w.windowDurationMins === SEVEN_DAYS);
  const model = { display_name: limits.planType ? `Codex (${limits.planType})` : "Codex" };
  if (limits.others.length > 0) {
    // Another limit may be the one that binds: every window goes out by name, the others under their limit's name.
    const named = limits.others.flatMap(o => [o.primary, o.secondary].filter((w): w is CodexWindow => w !== null).map(w => ({ label: `${o.name ?? o.limitId}: ${windowLabel(w.windowDurationMins)}`, ...row(w) })));
    return { session_id: sessionId, model, limits: [...windows.map(w => ({ label: windowLabel(w.windowDurationMins), ...row(w) })), ...named] };
  }
  if (five.length <= 1 && week.length <= 1 && five.length + week.length === windows.length) {
    const [f] = five;
    const [w] = week;
    return { session_id: sessionId, model, rate_limits: { ...(f ? { five_hour: row(f) } : {}), ...(w ? { seven_day: row(w) } : {}) } };
  }
  return { session_id: sessionId, model, limits: windows.map(w => ({ label: windowLabel(w.windowDurationMins), ...row(w) })) };
}

// Reads once through the shared app-server client: it stops the process group whatever happened.
export async function readCodexLimits(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number }): Promise<CodexReading> {
  // `excludeResetCreditDetails` is in GetAccountRateLimitsParams of 0.161.0's schema ("Skip the separate reset-credit detail
  // lookup for background usage polls"), so a usage poll leaves the credit details out.
  const asked = await askAppServer({ ...input, timeoutMs: input.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS }, [
    { method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } },
  ]);
  if (!asked.ok) return asked;
  const limits = limitsFromResult(asked.results[0]);
  if (!limits) return { ok: false, problem: "codex app-server answered in a shape this reader does not know" };
  if (!limits.primary && !limits.secondary && limits.others.length === 0) return { ok: false, problem: "Codex reported no usage window" };
  return { ok: true, limits };
}

// S6 (plan 4.6): the reading body a codex account posts to the hub's readings route — the same windows the status-line
// report carries, plus who is behind the account (a digest, never an id) and Codex's own limit flags. Epoch seconds
// here, as on the whole readings wire. Round 1: a stub.
export type CodexReadingBody = {
  source: "app-server";
  node: string | null;
  captured_at: number;            // seconds
  every_s: number;
  plan: string | null;
  identity: string | null;
  windows: { id: string; used_percent: number; resets_at: number | null; length_mins: number | null; rolling: false; note: null }[];
  ordinary_usage_allowed?: boolean | null;
  rate_limit_reached_type?: string | null;
};
export function codexReadingBody(limits: CodexLimits, o: {
  identity: string | null; ordinaryUsageAllowed: boolean | null; rateLimitReachedType: string | null; now: number; node: string | null;
}): CodexReadingBody {
  void limits; void o;
  throw new Error("not implemented");
}

// The adaptive read interval (AT-42), from the highest used percent over every window: 15 minutes idle, 5 from 75%,
// 2 from 90%, once a minute from 99% — never faster than once a minute. Round 1: a stub.
export function everyFor(maxPercent: number | null): number {
  void maxPercent;
  throw new Error("not implemented");
}

// A pushed `account/rateLimits/updated` notification (S6): an update in the same snapshot shape `account/rateLimits/read`
// answers with, mapped to the same reading body — flagged pushed, no lease, because a push is nobody's rationed read.
// Round 1: a stub; the long-lived client that would deliver these notifications is not built in this slice.
export function codexPushedReading(update: unknown, o: { identity: string | null; now: number; node: string | null }): CodexReadingBody & { pushed: true } {
  void update; void o;
  throw new Error("not implemented");
}
