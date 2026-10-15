// A Codex subscription's usage windows, read through the installed CLI's app server (ADR-0028 decision 5; ADR-0024's
// bridge on one machine). `codex app-server` speaks JSON-RPC on stdio, one object per line without the "jsonrpc" field; a
// client sends `initialize` (clientInfo) and then the `initialized` notification before anything else. The answer to
// `account/rateLimits/read` is { rateLimits: { primary, secondary, planType, … }, rateLimitsByLimitId, … }; a window is
// { usedPercent, windowDurationMins, resetsAt }, resetsAt in Unix seconds.
// https://learn.chatgpt.com/docs/app-server (read 2026-10-15). The shape is the one `codex app-server
// generate-json-schema` writes for codex-cli 0.161.0 (v2/GetAccountRateLimitsResponse.json, 2026-10-15).
// The app server is experimental, "aren't supported for production workloads" (same page): an answer in any other shape
// is "unavailable", never a guess. Its stderr is never read, and the caller hands it childEnv (no key variable).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CONNECTION_WORDS } from "@morndo/protocol";

export const CODEX_USAGE_TIMEOUT_MS = 15_000;
const INITIALIZE_ID = 0;
const READ_ID = 1;
const FIVE_HOURS = 300;
const SEVEN_DAYS = 10_080;

export type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type CodexLimits = { primary: CodexWindow | null; secondary: CodexWindow | null; planType: string | null };
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
  return { primary, secondary, planType };
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
  if (five.length <= 1 && week.length <= 1 && five.length + week.length === windows.length) {
    const [f] = five;
    const [w] = week;
    return { session_id: sessionId, model, rate_limits: { ...(f ? { five_hour: row(f) } : {}), ...(w ? { seven_day: row(w) } : {}) } };
  }
  return { session_id: sessionId, model, limits: windows.map(w => ({ label: windowLabel(w.windowDurationMins), ...row(w) })) };
}

function problemOf(error: unknown): string {
  const text = isObject(error) && typeof error.message === "string" ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return text === "" ? "codex app-server refused the read" : `codex app-server: ${text}`;
}

// Starts the app server in its own process group, reads once, and stops the group whatever happened.
export function readCodexLimits(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number }): Promise<CodexReading> {
  const script = input.bin.endsWith(".mjs") || input.bin.endsWith(".js");
  const argv = [...(script ? [input.bin] : []), "app-server", "--listen", "stdio://"];
  return new Promise(resolve => {
    const child = spawn(script ? process.execPath : input.bin, argv, { env: input.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (reading: CodexReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      resolve(reading);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: "codex app-server did not answer in time" }), input.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS);
    const send = (message: object): void => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on("error", () => { /* the child went early; close says so */ });
    child.on("error", error => finish({
      ok: false,
      problem: (error as NodeJS.ErrnoException).code === "ENOENT" ? `${input.bin} is not on PATH` : "codex app-server could not start",
    }));
    child.on("close", () => finish({ ok: false, problem: "codex app-server exited before it answered" }));
    lines.on("line", line => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isObject(message)) return;
      if (message.id === INITIALIZE_ID) {
        if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: READ_ID, params: { excludeResetCreditDetails: true } });
        return;
      }
      if (message.id !== READ_ID) return;   // notifications, and anything else the server says
      if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
      const limits = limitsFromResult(message.result);
      if (!limits) { finish({ ok: false, problem: "codex app-server answered in a shape this reader does not know" }); return; }
      if (!limits.primary && !limits.secondary) { finish({ ok: false, problem: "Codex reported no usage window" }); return; }
      finish({ ok: true, limits });
    });
    send({ method: "initialize", id: INITIALIZE_ID, params: { clientInfo: { name: "morndo", title: "Morndo", version: input.version } } });
  });
}
