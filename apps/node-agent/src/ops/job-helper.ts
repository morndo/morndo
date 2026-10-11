// Detached helper for one job (ADR-0017, design §3). It is not a shell. It runs the command vector in its own
// session, writes <id>.exit once the command's process group is gone, and applies the timeout itself so a timeout
// still fires while the agent is down. SIGTERM means cancel.
import { spawn } from "node:child_process";
import { chmodSync, constants, existsSync, openSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { writeProcessFile } from "./job-identity.ts";
import { FULL_LOG_GRACE_MS, MAX_TIMER_MS } from "./job-limits.ts";
import { fileURLToPath } from "node:url";

type Spec = {
  command: string[];
  cwd: string;
  logPath: string;
  exitPath: string;
  childPath: string;
  timeoutMs: number | null;
  logBytes: number;
  env: Record<string, string>;
};

type ExitBody = {
  outcome: "exited" | "timed_out" | "cancelled";
  exitCode: number | null;
  durationMs: number;
  error?: "did_not_start";
};

const capRequest = (exitPath: string): string =>
  exitPath.endsWith(".exit") ? `${exitPath.slice(0, -5)}.cap` : `${exitPath}.cap`;

const gone = (pid: number): boolean => {
  try { process.kill(-pid, 0); return false; } catch { return true; }
};

// One rule for a command's own end, wherever it is written: its exit code, or the conventional 128 plus the
// signal number when a signal ended it — the same rule the systemd backend reads from ExecMainStatus.
const signalEnd = (signal: string | null): number | null => {
  if (signal === null) return null;
  const n = (osConstants.signals as Record<string, unknown>)[signal];
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 128 ? 128 + n : null;
};

// Once a cap's group kill has waited the group out, how long the exit event may take to arrive before the
// record is written anyway.
const EXIT_SETTLE_MS = 100;

function killGroup(pid: number): Promise<void> {
  return new Promise(resolve => {
    try { process.kill(-pid, "SIGTERM"); } catch { resolve(); return; }
    const finish = () => { clearInterval(watch); clearTimeout(hard); resolve(); };
    const hard = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }, 200);
    const watch = setInterval(() => { if (gone(pid)) finish(); }, 20);
    setTimeout(finish, 1000);
  });
}

async function main(): Promise<void> {
  let early: "cancelled" | null = null;
  let stop: ((kind: "cancelled" | "timed_out" | "capped") => Promise<void>) | null = null;
  process.on("SIGTERM", () => {
    if (stop) void stop("cancelled");
    else early = "cancelled";
  });
  // Tests wait for this before a start-up signal. The supervisor points stdout at /dev/null.
  process.stdout.write("ready\n");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const spec = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Spec;
  const started = Date.now();
  let wrote = false;
  let stopping: "cancelled" | "timed_out" | "capped" | null = null;
  let fullSince: number | null = null;
  const write = (body: ExitBody) => {
    if (wrote) return;
    wrote = true;
    const tmp = `${spec.exitPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, spec.exitPath);
    chmodSync(spec.exitPath, 0o600);
  };
  if (early === "cancelled") {
    write({ outcome: "cancelled", exitCode: null, durationMs: 0 });
    process.exit(0);
  }
  if (existsSync(capRequest(spec.exitPath))) {
    write({ outcome: "exited", exitCode: null, durationMs: 0 });
    process.exit(0);
  }
  const logFd = openSync(spec.logPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
  const spawnedAt = Date.now();
  const child = spawn(spec.command[0] ?? "", spec.command.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (child.pid !== undefined) {
    // The pid file is how a later cancel finds the child. It is written only after the start record, so a
    // helper killed while that record is being taken does not leave a pid the supervisor must not signal.
    const atPath = `${spec.childPath}.at`;
    writeProcessFile(atPath, child.pid, spawnedAt);
    if (existsSync(atPath)) {
      writeFileSync(spec.childPath, String(child.pid), { mode: 0o600 });
      chmodSync(spec.childPath, 0o600);
    }
  }
  stop = async (kind: "cancelled" | "timed_out" | "capped") => {
    if (stopping || wrote) return;
    stopping = kind;
    if (child.pid !== undefined) await killGroup(child.pid);
    if (kind === "capped") {
      // killGroup has waited the group out, so the exit event is a beat away; take it, bounded, rather than
      // poll for it. The exit code is null either way: our signal ended the command, whatever its handler did.
      await Promise.race([exitDone, sleep(EXIT_SETTLE_MS)]);
    }
    const durationMs = Math.max(0, Date.now() - started);
    write(kind === "capped"
      ? { outcome: "exited", exitCode: null, durationMs }
      : { outcome: kind, exitCode: 137, durationMs });
    process.exit(0);
  };
  child.on("error", () => {
    if (stopping || wrote) return;
    write({ outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" });
    process.exit(0);
  });
  let childCode: number | null = null;
  let childExited = false;
  let sawExit: (() => void) | null = null;
  const exitDone = new Promise<void>(resolve => { sawExit = resolve; });
  child.on("exit", (code, signal) => {
    childExited = true;
    childCode = code !== null ? code : signalEnd(signal);
    sawExit?.();
  });
  const linger = setInterval(() => {
    if (stopping || wrote) return;
    if (childExited && (child.pid === undefined || gone(child.pid))) {
      clearInterval(linger);
      write({ outcome: "exited", exitCode: childCode, durationMs: Math.max(0, Date.now() - started) });
      process.exit(0);
      return;
    }
    // A .cap request comes from the supervisor's sweep, which has already waited the grace itself.
    if (existsSync(capRequest(spec.exitPath))) { void stop?.("capped"); return; }
    if (spec.logBytes > 0) {
      let size = 0;
      try { size = statSync(spec.logPath).size; } catch { /* a missing log is not over the cap */ }
      if (size >= spec.logBytes) {
        // A full log alone is no fault: a command that has stopped writing ends on its own moments later, and
        // its own exit code is the truth. Only a log still full after the grace — a command still running,
        // whatever it is doing — is stopped, and then with no exit code, for our signal ends it. Whatever it
        // writes in the meantime stays in the log (the store never rewrites one); the next sweep of the log
        // measures the size that is really there.
        if (fullSince === null) { fullSince = Date.now(); return; }
        if (Date.now() - fullSince < FULL_LOG_GRACE_MS) return;
        void stop?.("capped");
        return;
      }
      fullSince = null;    // under the cap again: the wait starts over
    }
  }, 30);
  if (spec.timeoutMs !== null && spec.timeoutMs > 0 && spec.timeoutMs <= MAX_TIMER_MS) {
    setTimeout(() => { void stop?.("timed_out"); }, spec.timeoutMs);
  }
}

const entry = process.argv[1];
const sameFile = (a: string, b: string) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
};
if (entry && sameFile(fileURLToPath(import.meta.url), entry)) void main();
