// Detached helper for one job (ADR-0017, design §3). It is not a shell. It runs the command vector in its own
// session, writes <id>.exit once the command's process group is gone, and applies the timeout itself so a timeout
// still fires while the agent is down. SIGTERM means cancel.
import { spawn } from "node:child_process";
import { chmodSync, constants, existsSync, openSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { capStep, type CapSight } from "./job-cap.ts";
import { writeProcessFile } from "./job-identity.ts";
import { MAX_TIMER_MS } from "./job-limits.ts";
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
  let childCode: number | null = null;
  let childExited = false;
  stop = async (kind: "cancelled" | "timed_out" | "capped") => {
    if (stopping || wrote) return;
    stopping = kind;
    // Design §5: a capped command keeps its own code only when its main process ended before this stop. Exits that
    // arrive from here on are not recorded (the exit handler checks `stopping`), so a SIGTERM handler that exits 0
    // still leaves no code.
    const endedFirst = childExited;
    if (child.pid !== undefined) await killGroup(child.pid);
    const durationMs = Math.max(0, Date.now() - started);
    write(kind === "capped"
      ? { outcome: "exited", exitCode: endedFirst ? childCode : null, durationMs }
      : { outcome: kind, exitCode: 137, durationMs });
    process.exit(0);
  };
  child.on("error", () => {
    if (stopping || wrote) return;
    write({ outcome: "exited", exitCode: null, durationMs: 0, error: "did_not_start" });
    process.exit(0);
  });
  child.on("exit", (code, signal) => {
    if (stopping || wrote) return;
    childExited = true;
    childCode = code !== null ? code : signal === "SIGKILL" ? 137 : signal === "SIGTERM" ? 143 : null;
  });
  // Design §5: this helper owns the cap. A .cap file from the supervisor counts as a sighting, never as a stop.
  let sight: CapSight | null = null;
  const linger = setInterval(() => {
    if (stopping || wrote) return;
    if (childExited && (child.pid === undefined || gone(child.pid))) {
      clearInterval(linger);
      write({ outcome: "exited", exitCode: childCode, durationMs: Math.max(0, Date.now() - started) });
      process.exit(0);
      return;
    }
    // The note is read before the size, and only for the first sighting. The supervisor writes it after the
    // log is already at the cap, so this stat includes those bytes. One stat per look after that.
    let noted = false;
    let size = 0;
    if (spec.logBytes > 0) {
      if (sight === null) noted = existsSync(capRequest(spec.exitPath));
      try { size = statSync(spec.logPath).size; } catch { /* a missing log is not over the cap */ }
    }
    // The grace is timed on the monotonic clock, so a wall-clock step neither stretches nor ends it.
    const step = capStep(sight, size, spec.logBytes, performance.now(), noted);
    if (step.kind === "under") return;
    if (step.kind === "grace" && !childExited) { sight = step.sight; return; }
    // setImmediate runs after this turn's poll phase, where libuv hands over a child exit the kernel already reported,
    // so an exit that came before this decision is seen by stop().
    setImmediate(() => { void stop?.("capped"); });
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
