// Whether a recorded pid is still that process. The record is the start tick (field 22 of /proc/<pid>/stat, starttime
// in clock ticks since boot) and this boot's id.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (read 2026-10-10)
// Without a boot id it is the start itself, as the range node-ops reads (processStart: /proc, else `ps -o lstart`). A pid
// file with no start record is unknown: it is never signalled, and the job is lost only after the grace below. A
// refused signal is processAlive's answer, checked once.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, writeFileSync } from "node:fs";
import {
  identityFromStat, processAlive, processIdentity, processStart, processStartSync, readText, sameStart, startFromLstart,
  type ProcessIdentity, type ProcessStart, type ProcessStartIo,
} from "@morndo/node-ops";

// How long a pid file may exist before its start record is written. Inside this window the pid is left alone.
export const START_RECORD_GRACE_MS = 5_000;

export type Recorded =
  | { kind: "none" }
  | { kind: "bad" }
  | { kind: "id"; id: ProcessIdentity }
  | { kind: "start"; start: ProcessStart };

// A record written before the start was a range: {"lstart": ms}, the btime or ps start, up to a second and a tick
// (USER_HZ 100) early.
const LEGACY_LSTART_MS = 1_010;

export function readRecorded(text: string | null): Recorded {
  if (text === null) return { kind: "none" };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { kind: "bad" }; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "bad" };
  const rec = value as { ticks?: unknown; bootId?: unknown; earliest?: unknown; latest?: unknown; lstart?: unknown };
  if (typeof rec.ticks === "number" && Number.isInteger(rec.ticks) && rec.ticks >= 0 && typeof rec.bootId === "string" && rec.bootId !== "") {
    return { kind: "id", id: { ticks: rec.ticks, bootId: rec.bootId } };
  }
  if (typeof rec.earliest === "number" && typeof rec.latest === "number" && Number.isFinite(rec.earliest)
    && Number.isFinite(rec.latest) && rec.earliest <= rec.latest) {
    return { kind: "start", start: { earliest: rec.earliest, latest: rec.latest } };
  }
  if (typeof rec.lstart === "number" && Number.isFinite(rec.lstart)) {
    return { kind: "start", start: { earliest: rec.lstart, latest: rec.lstart + LEGACY_LSTART_MS } };
  }
  return { kind: "bad" };
}

const SPAWN_WINDOW_MS = 1_000;

// Writes the identity before returning. A start that cannot lie inside the spawn window is a reused pid and is not
// recorded: the window allows for how far the start's source can be off, and nothing more. The identity and the start
// come from one read of /proc/<pid>/stat, so they describe one process; without a boot id the record is that start.
export function writeProcessFile(path: string, pid: number, spawnedAt: number, io: ProcessStartIo = {}): void {
  const read = io.read ?? readText;
  const stat = Number.isInteger(pid) && pid > 0 ? read(`/proc/${pid}/stat`) : null;
  const start = processStartSync(pid, io, stat);
  if (start === null || start.latest < spawnedAt - SPAWN_WINDOW_MS || start.earliest > spawnedAt + SPAWN_WINDOW_MS) return;
  const ident = stat === null ? null : identityFromStat(stat, read);
  writeFileSync(path, JSON.stringify(ident ?? start), { mode: 0o600 });
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
): Promise<Map<number, ProcessStart | null>> {
  const out = new Map<number, ProcessStart | null>();
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
    const start = startFromLstart(trimmed.slice(gap + 1));
    if (!out.has(pid) || start === null) continue;
    out.set(pid, start);
  }
  return out;
}

// True when this pid is still the process the record names. No record is unknown, which is not a match.
// `starts` is one ps result for the whole sweep, so a fallback pid is not looked up on its own.
export async function sameProcess(
  pid: number,
  recorded: Recorded,
  starts?: ReadonlyMap<number, ProcessStart | null>,
  io: ProcessStartIo = {},
): Promise<boolean> {
  if (!processAlive(pid)) return false;
  if (recorded.kind === "none" || recorded.kind === "bad") return false;
  if (recorded.kind === "id") {
    const live = processIdentity(pid, io.read);
    return live !== null && live.ticks === recorded.id.ticks && live.bootId === recorded.id.bootId;
  }
  const now = starts?.has(pid) ? starts.get(pid) ?? null : await processStart(pid, io);
  return now !== null && sameStart(now, recorded.start);
}
