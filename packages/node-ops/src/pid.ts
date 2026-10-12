// Whether a pid is a live process. `process.kill(pid, 0)` checks without signalling; pid 0 would signal the whole
// process group, so it is refused. EPERM means the process exists and this user may not signal it, which is alive.
// https://nodejs.org/api/process.html#processkillpid-signal (read 2026-10-08).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => { process.kill(p, s); }): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// When this process started, in ms since the epoch, or null when it cannot be read.
// Linux: /proc/<pid>/stat field 22 is starttime in clock ticks since boot, plus btime from /proc/stat.
// btime does not change while this process runs, so it is read once.
// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html and https://man7.org/linux/man-pages/man5/proc.5.html (read 2026-10-08).
// CLK_TCK is getconf CLK_TCK (POSIX sysconf(_SC_CLK_TCK)). A failed getconf is not remembered: the next call tries again.
// Where /proc does not yield a time: `ps -o lstart=` (second resolution, C locale), awaited so the poll is not blocked.
// https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback (read 2026-10-08).
// https://man7.org/linux/man-pages/man1/ps.1.html (read 2026-10-08).
export type ProcessStartIo = {
  read?: (path: string) => string | null;
  ps?: (pid: number) => string | null | Promise<string | null>;
  hz?: number | null;
  getconf?: () => string | Promise<string>;
};

export type ProcessIdentity = { ticks: number; bootId: string };

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

export function startMsFromProc(stat: string, procStat: string, hz: number): number | null {
  const boot = btimeSec(procStat);
  const ticks = startTicksFromStat(stat);
  if (boot === null || ticks === null || !Number.isInteger(hz) || hz <= 0) return null;
  return boot * 1000 + Math.round((ticks * 1000) / hz);
}

// When the process started, in ms since the epoch, from its age on the boot clock: the first field of /proc/uptime less
// its starttime, both CLOCK_BOOTTIME, taken from `nowMs`, the wall clock read beside /proc/uptime. The kernel prints
// uptime to the hundredth of a second and starttime in ticks, so this is good to about 10 ms; btime is whole seconds
// (getboottime64 printed as tv_sec), so startMsFromProc can be up to a second early.
// fs/proc/uptime.c, fs/proc/array.c, fs/proc/stat.c, kernel/time/timekeeping.c (Linux v6.12, read 2026-10-12);
// https://man7.org/linux/man-pages/man5/proc_uptime.5.html (read 2026-10-12).
export function startMsFromUptime(stat: string, uptime: string, hz: number, nowMs: number): number | null {
  const ticks = startTicksFromStat(stat);
  const field = uptime.trim().split(/\s+/)[0] ?? "";
  if (ticks === null || !/^\d+(\.\d+)?$/.test(field) || !Number.isInteger(hz) || hz <= 0 || !Number.isFinite(nowMs)) return null;
  return nowMs - Math.round(Number(field) * 1000 - (ticks * 1000) / hz);
}

export function lstartMs(text: string): number | null {
  const ms = Date.parse(text.trim());
  return Number.isFinite(ms) ? ms : null;
}

function btimeSec(procStat: string): number | null {
  const line = procStat.split("\n").find(l => l.startsWith("btime "));
  if (!line) return null;
  const boot = Number(line.slice("btime ".length).trim());
  if (!Number.isFinite(boot) || boot <= 0) return null;
  return boot;
}

let cachedHz: number | undefined;
let cachedBoot: number | undefined;
let cachedBootId: string | undefined;

// Tests isolate the module caches. A hub process keeps them for its lifetime.
export function resetProcessStartCache(): void {
  cachedHz = undefined;
  cachedBoot = undefined;
  cachedBootId = undefined;
}

async function clockHz(getconf?: () => string | Promise<string>): Promise<number | null> {
  if (cachedHz !== undefined) return cachedHz;
  try {
    const n = Number(String(await (getconf ?? defaultGetconf)()).trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    cachedHz = n;
    return n;
  } catch {
    return null;
  }
}

function bootSeconds(read: (path: string) => string | null): number | null {
  if (cachedBoot !== undefined) return cachedBoot;
  const text = read("/proc/stat");
  if (text === null) return null;
  const boot = btimeSec(text);
  if (boot === null) return null;
  cachedBoot = boot;
  return boot;
}

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8"); }
  catch { return null; }
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

// The live process's start tick and this boot's id, or null when either cannot be read. No wall clock.
export function processIdentity(pid: number, read: (path: string) => string | null = readText): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const stat = read(`/proc/${pid}/stat`);
  if (stat === null) return null;
  const ticks = startTicksFromStat(stat);
  if (ticks === null) return null;
  const bootId = bootIdOf(read);
  if (bootId === null) return null;
  return { ticks, bootId };
}

async function defaultGetconf(): Promise<string> {
  const { stdout } = await execFileAsync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  return String(stdout);
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

export async function processStartedMs(pid: number, io: ProcessStartIo = {}): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const read = io.read ?? readText;
  const hz = io.hz === undefined ? await clockHz(io.getconf) : io.hz;
  if (hz !== null) {
    const stat = read(`/proc/${pid}/stat`);
    const boot = bootSeconds(read);
    if (stat !== null && boot !== null && Number.isInteger(hz) && hz > 0) {
      const ticks = startTicksFromStat(stat);
      if (ticks !== null) return boot * 1000 + Math.round((ticks * 1000) / hz);
    }
  }
  const line = await (io.ps ?? psLstart)(pid);
  if (line === null) return null;
  return lstartMs(line);
}
