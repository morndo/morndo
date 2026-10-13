// Optional transcription settings (design §9). Absent file means the defaults, and the feature is still off until a
// plugin is found. Bad JSON is logged and ignored so the hub still starts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
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

// What the guard asks of the machine, per platform: Linux reads /proc (proc_loadavg(5), MemAvailable in kibibytes).
// macOS has no MemAvailable. vm_stat(1) prints the page size and the page counts (Pages free, Pages inactive,
// Pages speculative; https://keith.github.io/xcode-man-pages/vm_stat.1.html, the macOS man page, read 2026-10-13).
// Those three are the pages the machine can give back. Their sum times the page size is what the guard compares.
// Total memory never changes, so it cannot hold the queue. Only the configured lines are read, so a load-only
// guard never fails on an unreadable meminfo, and a read that throws is the configured line being unanswerable:
// guardNow answers "unknown" for it.
export function readMachine(
  policy: TranscriptionGuard | null,
  o: { platform?: NodeJS.Platform; loadavg?: () => number[]; vmStat?: () => string; loadPath?: string; memPath?: string } = {},
): { load1?: number; memAvailableMiB?: number } {
  const linux = (o.platform ?? process.platform) === "linux";
  const out: { load1?: number; memAvailableMiB?: number } = {};
  if (policy?.load1 !== undefined) {
    out.load1 = linux
      ? Number(readFileSync(o.loadPath ?? "/proc/loadavg", "utf8").trim().split(/\s+/)[0])
      : (o.loadavg ?? loadavg)()[0] ?? Number.NaN;
  }
  if (policy?.memAvailableMiB !== undefined) {
    out.memAvailableMiB = linux
      ? (() => {
        const line = readFileSync(o.memPath ?? "/proc/meminfo", "utf8").split("\n").find(row => row.startsWith("MemAvailable:"));
        return Number(line?.trim().split(/\s+/)[1]) / 1024;
      })()
      : macAvailableMiB(o.vmStat ?? (() => execFileSync("vm_stat", { encoding: "utf8", timeout: 2000 })));
  }
  return out;
}

function macAvailableMiB(vmStat: () => string): number {
  const text = vmStat();
  const page = /page size of (\d+) bytes/.exec(text);
  const pageSize = page ? Number(page[1]) : Number.NaN;
  const pages = (name: string) => {
    const line = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(text);
    return line ? Number(line[1]) : Number.NaN;
  };
  const reclaimable = pages("free") + pages("inactive") + pages("speculative");
  return pageSize > 0 && Number.isFinite(reclaimable) ? (reclaimable * pageSize) / (1024 * 1024) : Number.NaN;
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
