// Whether a pid is a live process. `process.kill(pid, 0)` checks without signalling; pid 0 would signal the whole
// process group, so it is refused. EPERM means the process exists and this user may not signal it, which is alive.
// https://nodejs.org/api/process.html#processkillpid-signal (read 2026-10-08).
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => { process.kill(p, s); }): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// When a process started, as the range of ms since the epoch that holds its true start: the sources below read the
// start at different resolutions, and a range says how far each can be off, so a window check, a stored start and a
// later comparison (sameStart) all allow for the same error. processStart and processStartSync take the best source
// this host has: /proc/uptime less starttime (about 20 ms), then btime plus starttime (up to a second early), then
// `ps -o lstart=` (whole seconds). CLK_TCK is getconf CLK_TCK (POSIX sysconf(_SC_CLK_TCK)), read once per process.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html, proc_uptime.5.html, proc_stat.5.html,
// https://man7.org/linux/man-pages/man1/ps.1.html (read 2026-10-12).
export type ProcessStart = { earliest: number; latest: number };

export type ProcessStartIo = {
  read?: (path: string) => string | null;
  now?: () => number;
  hz?: number | null;
  getconf?: () => string;
  ps?: (pid: number) => string | null | Promise<string | null>;
};

export type ProcessIdentity = { ticks: number; bootId: string };

// A file's text, or null when it cannot be read.
export function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch { return null; }
}

// Field 22 of /proc/<pid>/stat, the starttime in clock ticks since boot. The command name is in parentheses
// and may contain spaces, so the fields after the last `)` start at field 3 and starttime is the 20th of those.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html (read 2026-10-09).
export function startTicksFromStat(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const ticks = Number(stat.slice(close + 1).trim().split(/\s+/)[19]);
  if (!Number.isInteger(ticks) || ticks < 0) return null;
  return ticks;
}

// Whether two ranges can hold the same start: as far as their sources can tell, the same process.
export function sameStart(a: ProcessStart, b: ProcessStart): boolean {
  return a.earliest <= b.latest && b.earliest <= a.latest;
}

// The start from its age on the boot clock: the first field of /proc/uptime less starttime, taken from the wall clock.
// `before` and `after` are the wall clock read just before and just after /proc/uptime, so a stall between the two
// reads widens the range instead of moving it. The kernel prints uptime truncated to the hundredth of a second and
// starttime truncated to a tick, and Date.now() is whole ms: the start lies in
// [before - uptime + starttime - 10 ms, after - uptime + starttime + 1 tick + 1 ms].
// Both clocks count time suspended, on every kernel Node.js 24 runs on (Linux >= 4.18 with glibc, >= 3.10 with musl;
// nodejs/node BUILDING.md, v24.x): starttime is the task's boot-based start (real_start_time, "boot based time" in
// v2.6.32 to v5.4, start_boottime from v5.5) and /proc/uptime the boot clock (monotonic_to_bootbased in v2.6.32,
// get_monotonic_boottime in v4.18, ktime_get_boottime_ts64 in v5.4 to v6.12). fs/proc/array.c, fs/proc/uptime.c,
// include/linux/sched.h, kernel/fork.c at those tags (read 2026-10-12).
export function startFromUptime(stat: string, uptime: string, hz: number, before: number, after: number): ProcessStart | null {
  const ticks = startTicksFromStat(stat);
  const field = uptime.trim().split(/\s+/)[0] ?? "";
  if (ticks === null || !/^\d+(\.\d+)?$/.test(field) || !Number.isInteger(hz) || hz <= 0) return null;
  if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) return null;
  const age = Math.round(Number(field) * 1000) - (ticks * 1000) / hz;
  return { earliest: Math.floor(before - age - 10), latest: Math.ceil(after - age + 1000 / hz + 1) };
}

// The start from btime, the boot time /proc/stat prints in whole seconds (getboottime64 as tv_sec, fs/proc/stat.c),
// plus starttime: up to a second and a tick early.
export function startFromBtime(stat: string, procStat: string, hz: number): ProcessStart | null {
  const line = procStat.split("\n").find(l => l.startsWith("btime "));
  const boot = line ? Number(line.slice("btime ".length).trim()) : Number.NaN;
  const ticks = startTicksFromStat(stat);
  if (!Number.isInteger(boot) || boot <= 0 || ticks === null || !Number.isInteger(hz) || hz <= 0) return null;
  const ms = boot * 1000 + (ticks * 1000) / hz;
  return { earliest: Math.floor(ms), latest: Math.ceil(ms + 1000 + 1000 / hz) };
}

// The start from a `ps -o lstart=` line, whole seconds in local time. procps adds two truncated seconds, btime's and
// the start's (pr_lstart: boot_time() + start / Hertz, procps-ng 4.0.4 src/ps/output.c), to starttime's own tick, so
// on Linux it is up to two seconds and a tick early; macOS prints p_starttime.tv_sec (adv_cmds ps/print.c lstarted),
// up to a second early. Both read 2026-10-12.
export function startFromLstart(text: string, platform: NodeJS.Platform = process.platform): ProcessStart | null {
  const ms = Date.parse(text.trim());
  if (!Number.isFinite(ms)) return null;
  return { earliest: ms, latest: ms + (platform === "linux" ? 2_010 : 1_000) };
}

let cachedHz: number | undefined;
let cachedBootId: string | undefined;

// Tests isolate the module caches. A hub process keeps them for its lifetime.
export function resetProcessStartCache(): void {
  cachedHz = undefined;
  cachedBootId = undefined;
}

// CLK_TCK does not change, so a successful read is kept for every caller in this process. A failed getconf is not
// remembered: the next call tries again.
export function clockTicks(getconf: () => string = defaultGetconf): number | null {
  if (cachedHz !== undefined) return cachedHz;
  try {
    const n = Number(String(getconf()).trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    cachedHz = n;
    return n;
  } catch {
    return null;
  }
}

function defaultGetconf(): string {
  return execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
}

// /proc/sys/kernel/random/boot_id is one uuid for this boot. It does not change until reboot, so a successful
// read is kept. A failed read is not, and the next call tries again.
// https://www.kernel.org/doc/Documentation/sysctl/kernel.txt (boot_id, read 2026-10-09).
function bootIdOf(read: (path: string) => string | null): string | null {
  if (cachedBootId !== undefined) return cachedBootId;
  const text = read("/proc/sys/kernel/random/boot_id");
  if (text === null) return null;
  const id = text.trim();
  if (id === "") return null;
  cachedBootId = id;
  return id;
}

// A process's start tick, from one /proc/<pid>/stat text, and this boot's id, or null when either cannot be read.
export function identityFromStat(stat: string, read: (path: string) => string | null = readText): ProcessIdentity | null {
  const ticks = startTicksFromStat(stat);
  if (ticks === null) return null;
  const bootId = bootIdOf(read);
  if (bootId === null) return null;
  return { ticks, bootId };
}

// The live process's start tick and this boot's id, or null when either cannot be read. No wall clock.
export function processIdentity(pid: number, read: (path: string) => string | null = readText): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = read(`/proc/${pid}/stat`);
  return stat === null ? null : identityFromStat(stat, read);
}

// The start from one /proc/<pid>/stat text: from /proc/uptime when it can be read, else from btime.
function procStart(stat: string, io: ProcessStartIo): ProcessStart | null {
  const read = io.read ?? readText;
  const hz = io.hz === undefined ? clockTicks(io.getconf) : io.hz;
  if (hz === null) return null;
  const now = io.now ?? Date.now;
  const before = now();
  const uptime = read("/proc/uptime");
  const after = now();
  const exact = uptime === null ? null : startFromUptime(stat, uptime, hz, before, after);
  if (exact) return exact;
  const procStat = read("/proc/stat");
  return procStat === null ? null : startFromBtime(stat, procStat, hz);
}

function psLstartSync(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return out === "" ? null : out;
  } catch { return null; }
}

async function psLstart(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    const out = String(stdout).trim();
    return out === "" ? null : out;
  } catch { return null; }
}

// When this process started: /proc where it has the process, else ps, without awaiting, for a record taken right
// after a spawn. `stat` is a /proc/<pid>/stat text the caller already read (null: it could not be read).
export function processStartSync(pid: number, io: ProcessStartIo = {}, stat?: string | null): ProcessStart | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const text = stat !== undefined ? stat : (io.read ?? readText)(`/proc/${pid}/stat`);
  const fromProc = text === null ? null : procStart(text, io);
  if (fromProc) return fromProc;
  const line = (io.ps ?? psLstartSync)(pid);
  return typeof line === "string" ? startFromLstart(line) : null;
}

// The same, with ps awaited so a poll is not blocked.
// https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback (read 2026-10-08).
export async function processStart(pid: number, io: ProcessStartIo = {}): Promise<ProcessStart | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const text = (io.read ?? readText)(`/proc/${pid}/stat`);
  const fromProc = text === null ? null : procStart(text, io);
  if (fromProc) return fromProc;
  const line = await (io.ps ?? psLstart)(pid);
  return line === null ? null : startFromLstart(line);
}

// A process's parent: field 4 of /proc/<pid>/stat (the fields after the last `)` start at field 3, so the parent is their
// second), else `ps -o ppid=`. null when the process is gone or the answer is no pid.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html, https://man7.org/linux/man-pages/man1/ps.1.html (read 2026-10-16).
export function parentPid(pid: number, io: { read?: (path: string) => string | null; ps?: (pid: number) => string | null } = {}): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = (io.read ?? readText)(`/proc/${pid}/stat`);
  let raw: string | null = null;
  if (stat !== null) {
    const close = stat.lastIndexOf(")");
    raw = close < 0 ? null : (stat.slice(close + 1).trim().split(/\s+/)[1] ?? null);
  } else {
    raw = (io.ps ?? psParent)(pid);
  }
  const parent = Number(raw);
  return raw !== null && Number.isInteger(parent) && parent > 0 ? parent : null;
}

function psParent(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch { return null; }
}
