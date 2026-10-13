// Optional transcription settings (design §9). Absent file means the defaults, and the feature is still off until a
// plugin is found. Bad JSON is logged and ignored so the hub still starts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_RECORDING_SECONDS, TRANSCRIPTION_LIMIT_DEFAULT, type QueueGuard } from "@morndo/domain";

export type TranscriptionGuard = { load1?: number; memAvailableMiB?: number };

export type TranscriptionSettings = {
  limit: number;
  timeoutSec: number | null;
  maxSeconds: number;
  threads: number | null;
  guard: TranscriptionGuard | null;
};

const DEFAULTS: TranscriptionSettings = {
  limit: TRANSCRIPTION_LIMIT_DEFAULT, timeoutSec: null, maxSeconds: MAX_RECORDING_SECONDS, threads: null, guard: null,
};

export function loadTranscriptionSettings(dataDir: string, warn: (line: string) => void = () => {}): TranscriptionSettings {
  let raw: string;
  try { raw = readFileSync(join(dataDir, "transcription.json"), "utf8"); }
  catch { return DEFAULTS; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { warn("transcription: config ignored (bad json)"); return DEFAULTS; }
  if (!parsed || typeof parsed !== "object") return DEFAULTS;
  const block = (parsed as { transcription?: unknown }).transcription;
  if (block === undefined) return DEFAULTS;
  if (!block || typeof block !== "object") { warn("transcription: config ignored"); return DEFAULTS; }
  const t = block as Record<string, unknown>;
  const limit = typeof t.limit === "number" && Number.isInteger(t.limit) && t.limit >= 1 ? t.limit : DEFAULTS.limit;
  const timeoutSec = t.timeoutSec == null ? null : (typeof t.timeoutSec === "number" && Number.isInteger(t.timeoutSec) && t.timeoutSec >= 1 ? t.timeoutSec : null);
  const maxSeconds = typeof t.maxSeconds === "number" && t.maxSeconds >= 1 ? Math.min(Math.floor(t.maxSeconds), MAX_RECORDING_SECONDS) : DEFAULTS.maxSeconds;
  const threads = t.threads == null ? null : (typeof t.threads === "number" && Number.isInteger(t.threads) && t.threads >= 1 ? t.threads : null);
  let guard: TranscriptionGuard | null = null;
  if (t.guard && typeof t.guard === "object") {
    const g = t.guard as Record<string, unknown>;
    const next: TranscriptionGuard = {};
    if (typeof g.load1 === "number" && Number.isFinite(g.load1)) next.load1 = g.load1;
    if (typeof g.memAvailableMiB === "number" && Number.isFinite(g.memAvailableMiB)) next.memAvailableMiB = g.memAvailableMiB;
    if (next.load1 !== undefined || next.memAvailableMiB !== undefined) guard = next;
  }
  return { limit, timeoutSec, maxSeconds, threads, guard };
}

// proc_loadavg(5) and MemAvailable in /proc/meminfo (kibibytes). Read only when a guard is configured.
export function readMachine(loadPath = "/proc/loadavg", memPath = "/proc/meminfo"): { load1?: number; memAvailableMiB?: number } {
  const load1 = Number(readFileSync(loadPath, "utf8").trim().split(/\s+/)[0]);
  const line = readFileSync(memPath, "utf8").split("\n").find(row => row.startsWith("MemAvailable:"));
  const kib = Number(line?.trim().split(/\s+/)[1]);
  return {
    ...(Number.isFinite(load1) ? { load1 } : {}),
    ...(Number.isFinite(kib) ? { memAvailableMiB: kib / 1024 } : {}),
  };
}

export function guardNow(policy: TranscriptionGuard | null, read: () => { load1?: number; memAvailableMiB?: number }): QueueGuard {
  if (!policy) return "off";
  let sample: { load1?: number; memAvailableMiB?: number };
  try { sample = read(); }
  catch { return "unknown"; }
  if (policy.load1 !== undefined && !Number.isFinite(sample.load1)) return "unknown";
  if (policy.memAvailableMiB !== undefined && !Number.isFinite(sample.memAvailableMiB)) return "unknown";
  if (policy.load1 !== undefined && sample.load1! > policy.load1) return "load";
  if (policy.memAvailableMiB !== undefined && sample.memAvailableMiB! < policy.memAvailableMiB) return "memory";
  return "off";
}
