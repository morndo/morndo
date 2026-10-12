// Whether a recorded pid is still that process. The record is the start tick (field 22 of /proc/<pid>/stat, starttime
// in clock ticks since boot) and this boot's id.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (read 2026-10-10)
// Where /proc does not yield them, it is `ps -o lstart`. A pid file with no start record is unknown: it is never
// signalled, and the job is lost only after the grace below. A refused signal is processAlive's answer, checked once.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { processAlive, processIdentity, processStartedMs, startMsFromProc, type ProcessIdentity } from "@morndo/node-ops";

// How long a pid file may exist before its start record is written. Inside this window the pid is left alone.
export const START_RECORD_GRACE_MS = 5_000;

export type Recorded =
  | { kind: "none" }
  | { kind: "bad" }
  | { kind: "id"; id: ProcessIdentity }
  | { kind: "lstart"; ms: number };

export function readRecorded(text: string | null): Recorded {
  if (text === null) return { kind: "none" };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { kind: "bad" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "bad" };
  const rec = value as { ticks?: unknown; bootId?: unknown; lstart?: unknown };
  if (typeof rec.ticks === "number" && Number.isInteger(rec.ticks) && rec.ticks >= 0 && typeof rec.bootId === "string" && rec.bootId !== "") {
    return { kind: "id", id: { ticks: rec.ticks, bootId: rec.bootId } };
  }
  if (typeof rec.lstart === "number" && Number.isFinite(rec.lstart)) return { kind: "lstart", ms: rec.lstart };
  return { kind: "bad" };
}

const SPAWN_WINDOW_MS = 1_000;

// CLK_TCK does not change. A failed getconf is not remembered: the next call tries again.
let clockHz: number | undefined;

function ticksPerSec(): number | null {
  if (clockHz !== undefined) return clockHz;
  try {
    const n = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    clockHz = n;
    return n;
  } catch { return null; }
}

// What writeProcessFile reads: a /proc file's text, null when it cannot be read, and the wall clock. Tests pass both.
export type ProcessFileIo = { read?: (path: string) => string | null; now?: () => number };

const readText = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

function observedStartMs(pid: number, read: (path: string) => string | null): number | null {
  try {
    const hz = ticksPerSec();
    if (hz === null) throw new Error("clk");
    const stat = read(`/proc/${pid}/stat`);
    const proc = read("/proc/stat");
    if (stat === null || proc === null) throw new Error("proc");
    const ms = startMsFromProc(stat, proc, hz);
    if (ms !== null) return ms;
  } catch { /* the ps line below is the fallback */ }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

// Writes the identity before returning. A start outside the spawn window is a reused pid and is not recorded.
export function writeProcessFile(path: string, pid: number, spawnedAt: number, io: ProcessFileIo = {}): void {
  const read = io.read ?? readText;
  const before = processIdentity(pid, read);
  const started = observedStartMs(pid, read);
  const after = processIdentity(pid, read);
  if (before && after && (before.ticks !== after.ticks || before.bootId !== after.bootId)) return;
  if (started === null || Math.abs(started - spawnedAt) > SPAWN_WINDOW_MS) return;
  const ident = before ?? after;
  const text = ident ? JSON.stringify(ident) : JSON.stringify({ lstart: started });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const execFileAsync = promisify(execFile);

async function defaultPsStarts(pids: readonly number[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=", "-o", "lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    return String(stdout);
  } catch { return null; }
}

// One `ps` for every pid that has no /proc identity. Missing lines stay null.
export async function psStarts(
  pids: readonly number[],
  ps: (pids: readonly number[]) => Promise<string | null> = defaultPsStarts,
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  const wanted = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
  for (const pid of wanted) out.set(pid, null);
  if (wanted.length === 0) return out;
  const text = await ps(wanted);
  if (text === null) return out;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const gap = trimmed.indexOf(" ");
    if (gap < 0) continue;
    const pid = Number(trimmed.slice(0, gap));
    const ms = Date.parse(trimmed.slice(gap + 1).trim());
    if (!out.has(pid) || !Number.isFinite(ms)) continue;
    out.set(pid, ms);
  }
  return out;
}

// True when this pid is still the process the record names. No record is unknown, which is not a match.
// `starts` is one ps result for the whole sweep, so a fallback pid is not looked up on its own.
export async function sameProcess(
  pid: number,
  recorded: Recorded,
  starts?: ReadonlyMap<number, number | null>,
): Promise<boolean> {
  if (!processAlive(pid)) return false;
  if (recorded.kind === "none" || recorded.kind === "bad") return false;
  if (recorded.kind === "id") {
    const live = processIdentity(pid);
    return live !== null && live.ticks === recorded.id.ticks && live.bootId === recorded.id.bootId;
  }
  const ms = starts?.has(pid) ? starts.get(pid) ?? null : await processStartedMs(pid);
  return ms !== null && Math.floor(ms / 1000) === Math.floor(recorded.ms / 1000);
}
