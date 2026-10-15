// A pool member's account as the CLI's app server tells it (ADR-0029, §6.6). One app-server process per ask: `initialize`
// and the `initialized` notification, then the calls one after the other, then the process group is stopped whatever happened.
// `codex app-server` speaks JSON-RPC on stdio, one object per line without the "jsonrpc" field.
// https://learn.chatgpt.com/docs/app-server (read 2026-10-15). Shapes: `codex app-server generate-json-schema`, codex-cli
// 0.161.0 (v2/GetAccountResponse.json, v2/GetAccountRateLimitsResponse.json, 2026-10-15). The app server is experimental:
// an answer in another shape is "unavailable", never a guess. Its stderr is never read, and callers hand it childEnv.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import type { Reading } from "@morndo/domain";

const DEFAULT_TIMEOUT_MS = 15_000;
const UNPAID = new Set(["free", "go", "unknown"]);

export type AppServerInput = { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number; stopAfter?: (results: readonly unknown[]) => boolean };
export type Asked = { ok: true; results: unknown[] } | { ok: false; problem: string };
type Call = { method: string; params: object };
type Body = Omit<Reading, "member" | "at">;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function problemOf(error: unknown): string {
  const text = isObject(error) && typeof error.message === "string" ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return text === "" ? "codex app-server refused the read" : `codex app-server: ${text}`;
}

// `stopAfter` ends the ask early, once the answers so far are enough (a signed-out account has no limits to read).
export function askAppServer(input: AppServerInput, calls: readonly Call[]): Promise<Asked> {
  const script = input.bin.endsWith(".mjs") || input.bin.endsWith(".js");
  const argv = [...(script ? [input.bin] : []), "app-server", "--listen", "stdio://"];
  return new Promise(resolve => {
    const child = spawn(script ? process.execPath : input.bin, argv, { env: input.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    const lines = createInterface({ input: child.stdout });
    const results: unknown[] = [];
    let settled = false;
    const finish = (answer: Asked): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: "codex app-server did not answer in time" }), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const send = (message: object): void => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
    const sendCall = (): void => { const call = calls[results.length]; if (call) send({ method: call.method, id: results.length + 1, params: call.params }); };
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
      if (message.id === 0) {
        if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
        send({ method: "initialized", params: {} });
        sendCall();
        return;
      }
      if (message.id !== results.length + 1) return;   // notifications, and anything else the server says
      if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
      results.push(message.result);
      if (results.length >= calls.length || input.stopAfter?.(results)) { finish({ ok: true, results }); return; }
      sendCall();
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "morndo", title: "Morndo", version: input.version } } });
  });
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

function windowsOf(snapshot: Record<string, unknown>): Body["windows"] | null {
  const out: { usedPercent: number; minutes: number | null; resetsAt: number | null }[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = snapshot[key];
    if (w === null || w === undefined) continue;
    if (!isObject(w) || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent)) return null;
    const mins = w.windowDurationMins;
    const at = w.resetsAt;
    out.push({
      usedPercent: w.usedPercent,
      minutes: typeof mins === "number" && Number.isInteger(mins) && mins > 0 ? mins : null,
      resetsAt: typeof at === "number" && Number.isFinite(at) ? at * 1000 : null,
    });
  }
  return out;
}

function creditsOf(summary: unknown): Body["credits"] | undefined {
  if (summary === null || summary === undefined) return null;
  if (!isObject(summary) || typeof summary.availableCount !== "number" || !Number.isFinite(summary.availableCount)) return undefined;
  const rows = Array.isArray(summary.credits) ? summary.credits : [];
  const expiries = rows.flatMap(row => (isObject(row) && row.status === "available" && typeof row.expiresAt === "number" ? [row.expiresAt * 1000] : []));
  return { available: summary.availableCount, expiresAt: expiries.length > 0 ? Math.min(...expiries) : null };
}

const SIGNED_OUT: Body = { signedIn: false, identity: null, plan: null, paid: null, windows: [], allowed: null, credits: null };

// The two answers as a reading, or null when they aren't the 0.161.0 shapes. The email is used for the identity digest only
// when the backend names no account id, and is never kept (PL12).
export function readingFromAnswers(account: unknown, limits: unknown): Body | null {
  if (!isObject(account) || !("account" in account)) return null;
  const who = account.account;
  if (who === null || (isObject(who) && who.type !== "chatgpt")) return SIGNED_OUT;
  if (!isObject(who) || typeof who.planType !== "string" || !/^[a-z0-9_]{1,40}$/.test(who.planType)) return null;
  if (!isObject(limits) || !isObject(limits.rateLimits)) return null;
  const windows = windowsOf(limits.rateLimits);
  const credits = creditsOf(limits.rateLimitResetCredits);
  if (windows === null || credits === undefined) return null;
  const id = typeof limits.accountId === "string" && limits.accountId !== "" ? limits.accountId : typeof who.email === "string" && who.email !== "" ? who.email : null;
  const allowed = typeof limits.ordinaryUsageAllowed === "boolean" ? limits.ordinaryUsageAllowed : null;
  return { signedIn: true, identity: id === null ? null : digest(id), plan: who.planType, paid: !UNPAID.has(who.planType), windows, allowed, credits };
}

// Reset-credit details are asked for here (`excludeResetCreditDetails: false`), so each credit's expiry arrives.
export async function readCodexAccount(input: Omit<AppServerInput, "stopAfter">): Promise<{ ok: true; reading: Body } | { ok: false; problem: string }> {
  const signedOut = (results: readonly unknown[]): boolean => readingFromAnswers(results[0], null)?.signedIn === false;
  const asked = await askAppServer({ ...input, stopAfter: results => results.length === 1 && signedOut(results) }, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/rateLimits/read", params: { excludeResetCreditDetails: false } },
  ]);
  if (!asked.ok) return asked;
  const reading = readingFromAnswers(asked.results[0], asked.results[1]);
  return reading ? { ok: true, reading } : { ok: false, problem: "codex app-server answered in a shape this reader does not know" };
}
