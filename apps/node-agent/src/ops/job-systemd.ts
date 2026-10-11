// The user-manager probe (design §3). Exit 0 means later jobs can be transient units. Any failure means the child
// supervisor. Flags below are from the systemd 255 manuals, read 2026-10-10:
// --collect unloads the unit after it completes, including when it failed
// (systemd-run(1), https://www.freedesktop.org/software/systemd/man/255/systemd-run.html).
// --property=Type=exec returns success only once the command has been started (same page).
// --expand-environment=no disables manager expansion of "$" (same page; added in 254).
// --remain-after-exit keeps the service after it terminates so its runtime information can be read (same page).
// RemainAfterExit= considers the service active after its processes have exited
// (systemd.service(5), https://www.freedesktop.org/software/systemd/man/255/systemd.service.html).
// RuntimeMaxSec= terminates a service that stays active longer than the span and marks it failed (same page).
// KillMode=control-group kills every process in the unit's control group when the unit stops, and TimeoutStopSec=
// is how long that stop waits before SIGKILL
// (systemd.kill(5), https://www.freedesktop.org/software/systemd/man/255/systemd.kill.html).
// StandardOutput=append: appends to a file
// (systemd.exec(5), https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html).
// UnsetEnvironment= is applied last, so it removes assignments inherited from the user manager and names the
// manager itself would add (systemd.exec(5), same page, read 2026-10-10).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProbeResult = { ok: true } | { ok: false; reason: string };

// systemctl --timestamp=unix needs systemd 251. --timestamp= arrived in 247 without a unix choice;
// 251 added it (systemd NEWS, CHANGES WITH 251: "systemctl's --timestamp= option gained a new choice
// unix, to show timestamp as unix times"; /usr/share/doc/systemd/NEWS.gz on this machine, read 2026-10-10).
// https://github.com/systemd/systemd/blob/v251/NEWS
const SYSTEMD_UNIX_TIMESTAMP = 251;

export async function probeUserManager(toolEnv?: NodeJS.ProcessEnv): Promise<ProbeResult> {
  try {
    const version = await run("systemctl", ["--version"], 10_000, toolEnv);
    const major = systemdMajor(version);
    if (major === null || major < SYSTEMD_UNIX_TIMESTAMP) {
      return { ok: false, reason: `systemd ${major ?? "unknown"} is older than ${SYSTEMD_UNIX_TIMESTAMP}` };
    }
  } catch (e) {
    return { ok: false, reason: probeReason(e) };
  }
  try {
    await run("systemd-run", [
      "--user", "--collect", "--wait", "--quiet",
      "--property=Type=exec", "--expand-environment=no",
      "true",
    ], 15_000, toolEnv);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: probeReason(e) };
  }
}

function systemdMajor(text: string): number | null {
  const match = /^systemd\s+(\d+)/.exec(text);
  if (!match || match[1] === undefined) return null;
  const major = Number(match[1]);
  return Number.isInteger(major) ? major : null;
}

export type UnitState = {
  load: string;
  active: string;
  sub: string;
  result: string;
  execCode: number;
  execStatus: number;
  mainPid: number;
  remain: boolean;
  startedUsec: number;
  exitedUsec: number;
  startedWall: string;
  exitedWall: string;
};

export function unitOf(id: string): string {
  return `morndo-job-${id}.service`;
}

export type UnitLook =
  | { kind: "absent" }
  | { kind: "unknown" }
  | { kind: "found"; view: UnitState };

export async function showUnit(id: string, toolEnv?: NodeJS.ProcessEnv): Promise<UnitLook> {
  let text: string;
  try {
    text = await run("systemctl", [
      "--user", "show", "--timestamp=unix",
      "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "Result",
      "-p", "ExecMainCode", "-p", "ExecMainStatus", "-p", "MainPID", "-p", "RemainAfterExit",
      "-p", "ExecMainStartTimestamp", "-p", "ExecMainExitTimestamp",
      "-p", "ExecMainStartTimestampMonotonic", "-p", "ExecMainExitTimestampMonotonic",
      unitOf(id),
    ], 10_000, toolEnv);
  } catch { return { kind: "unknown" }; }
  const fields = parseShow(text);
  if (!fields.LoadState || fields.LoadState === "not-found") return { kind: "absent" };
  return {
    kind: "found",
    view: {
      load: fields.LoadState,
      active: fields.ActiveState ?? "",
      sub: fields.SubState ?? "",
      result: fields.Result ?? "",
      execCode: Number(fields.ExecMainCode ?? "0"),
      execStatus: Number(fields.ExecMainStatus ?? "0"),
      mainPid: Number(fields.MainPID ?? "0"),
      remain: fields.RemainAfterExit === "yes",
      startedUsec: Number(fields.ExecMainStartTimestampMonotonic ?? "0"),
      exitedUsec: Number(fields.ExecMainExitTimestampMonotonic ?? "0"),
      startedWall: fields.ExecMainStartTimestamp ?? "",
      exitedWall: fields.ExecMainExitTimestamp ?? "",
    },
  };
}

// Monotonic timestamps are microseconds on CLOCK_MONOTONIC. Their difference is the process run, which stays
// correct when the agent was down. The wall-clock pair is requested on the same show so a missing monotonic
// reading can fall back to ExecMainStartTimestamp and ExecMainExitTimestamp (`@` seconds from --timestamp=unix).
export function runMs(view: UnitState, startedAt: number | null, now = Date.now()): number {
  if (Number.isFinite(view.startedUsec) && Number.isFinite(view.exitedUsec)
    && view.startedUsec > 0 && view.exitedUsec >= view.startedUsec) {
    return Math.round((view.exitedUsec - view.startedUsec) / 1000);
  }
  const started = unixMs(view.startedWall);
  const exited = unixMs(view.exitedWall);
  if (started !== null && exited !== null && exited >= started) return exited - started;
  if (startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}

// Status values systemd itself uses when it fails before the command runs (EXIT_CHDIR 200 through
// EXIT_BPF 245). A process that runs and exits with one of these numbers is a real exit: it has a
// start timestamp. systemd.exec(5), https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html
// (read 2026-10-10).
const EXEC_FAILURE = new Set([
  200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219,
  220, 221, 222, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 235, 236, 237, 238, 239, 240, 241,
  242, 243, 245,
]);

export function mainStarted(view: UnitState): boolean {
  if (view.mainPid > 0) return true;
  if (Number.isFinite(view.startedUsec) && view.startedUsec > 0) return true;
  return unixMs(view.startedWall) !== null;
}

// A spawn failure has no main process: an exec-failure status, or Result=exit-code with nothing started.
export function spawnFailed(view: UnitState): boolean {
  if (mainStarted(view) || view.execCode !== 1) return false;
  if (EXEC_FAILURE.has(view.execStatus)) return true;
  return view.result === "exit-code" && view.execStatus >= 200 && view.execStatus <= 255;
}

function unixMs(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^@(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match || match[1] === undefined) return null;
  const frac = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  return Number(match[1]) * 1000 + Number(frac);
}

export async function startJobUnit(job: {
  id: string;
  slice: string;
  cwd: string;
  command: readonly string[];
  logPath: string;
  env: Readonly<Record<string, string>>;
  unset: readonly string[];
  timeoutMs: number | null;
}, toolEnv?: NodeJS.ProcessEnv): Promise<void> {
  const args = [
    "--user", `--unit=morndo-job-${job.id}`, `--slice=${job.slice}`, "--remain-after-exit",
    "--property=Type=exec", "--expand-environment=no", `--working-directory=${job.cwd}`,
    "--property=KillMode=control-group", "--property=TimeoutStopSec=10",
    `--property=StandardOutput=append:${job.logPath}`, `--property=StandardError=append:${job.logPath}`,
  ];
  if (job.timeoutMs !== null && job.timeoutMs > 0) args.push(`--property=RuntimeMaxSec=${job.timeoutMs}ms`);
  for (const key of job.unset) {
    if (key in job.env) continue;
    args.push(`--property=UnsetEnvironment=${key}`);
  }
  for (const [key, value] of Object.entries(job.env)) args.push(`--setenv=${key}=${value}`);
  // The user manager passes its own environment to the process, and UnsetEnvironment= is applied last
  // (systemd.exec(5), https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html, read 2026-10-11).
  // env -i then keeps only the names above: a runner that injects a name after that list was read
  // (JAVA_HOME_* on a hosted image) cannot reach the job.
  const assignments = Object.entries(job.env).map(([key, value]) => `${key}=${value}`);
  args.push("--", "/usr/bin/env", "-i", ...assignments, ...job.command);
  await run("systemd-run", args, 15_000, toolEnv);
}

// Stop of a transient unit unloads it (CollectMode=inactive) and drops ExecMain timestamps.
// systemd.unit(5), https://www.freedesktop.org/software/systemd/man/255/systemd.unit.html (read 2026-10-10).
// kill leaves a RemainAfterExit unit loaded, so the start and exit timestamps can still be read.
// --kill-whom=all is every process in the unit
// (systemctl(1), https://www.freedesktop.org/software/systemd/man/255/systemctl.html, read 2026-10-10).
export async function killJobUnit(id: string, signal: "SIGTERM" | "SIGKILL", toolEnv?: NodeJS.ProcessEnv): Promise<void> {
  await run("systemctl", ["--user", "kill", "--kill-whom=all", `--signal=${signal}`, unitOf(id)], 10_000, toolEnv);
}

// A failed stop throws. Callers that are about to settle the row because of this stop must leave it open
// and try again. reset-failed is separate: a failed unit is cleared by it even when stop did nothing.
export async function stopJobUnit(id: string, toolEnv?: NodeJS.ProcessEnv): Promise<void> {
  await run("systemctl", ["--user", "stop", unitOf(id)], 20_000, toolEnv);
}

export async function resetJobUnit(id: string, toolEnv?: NodeJS.ProcessEnv): Promise<void> {
  try {
    await run("systemctl", ["--user", "reset-failed", unitOf(id)], 10_000, toolEnv);
  } catch { /* a clean stop is not a failed unit */ }
}

function run(file: string, args: string[], timeout: number, toolEnv?: NodeJS.ProcessEnv): Promise<string> {
  return execFileAsync(file, args, {
    encoding: "utf8",
    timeout,
    ...(toolEnv ? { env: toolEnv } : {}),
  }).then(out => out.stdout);
}

// Names systemd adds while starting a service. They are not part of the kept set. UnsetEnvironment= removes them
// after every other source, including the manager's own additions.
const ADDED_BY_SYSTEMD = [
  "INVOCATION_ID", "JOURNAL_STREAM", "MANAGERPID", "SYSTEMD_EXEC_PID",
  "MEMORY_PRESSURE_WATCH", "MEMORY_PRESSURE_WRITE", "NOTIFY_SOCKET",
  "LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES", "WATCHDOG_PID", "WATCHDOG_USEC",
  "DEBUG_INVOCATION",
];

// Names the user manager would hand to the unit, plus the names systemd adds while starting it.
// A failed read throws: the caller must not start the unit, or the job inherits the whole manager environment.
export async function managerEnv(toolEnv?: NodeJS.ProcessEnv): Promise<string[]> {
  const text = await run("systemctl", ["--user", "show-environment"], 10_000, toolEnv);
  const drop = new Set<string>(ADDED_BY_SYSTEMD);
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    drop.add(key);
  }
  return [...drop];
}

function parseShow(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

function probeReason(e: unknown): string {
  if (typeof e !== "object" || e === null) return "probe failed";
  const err = e as { code?: string; status?: number; stderr?: string };
  if (err.code === "ENOENT") return "systemd-run not found";
  const line = typeof err.stderr === "string" ? err.stderr.trim().split("\n")[0] : "";
  if (line) return line;
  if (typeof err.status === "number") return `probe exited ${err.status}`;
  return "probe failed";
}
