// The hub's process host for a protocol-1 transcriber (ADR-0021; design §5). It spawns the executable with an
// argument vector, never a shell, and reads one JSON document back. The child gets a fresh working directory and
// only PATH, HOME, LANG and TMPDIR. A cancel or a timeout signals the process group: SIGTERM, then SIGKILL after
// 10 seconds, the same escalation as a job cancel.
//
// Node 24, fetched 2026-10-13:
// - child_process.spawn: shell defaults to false; detached on non-Windows makes the child the leader of a new
//   process group (https://nodejs.org/docs/latest-v24.x/api/child_process.html).
// - os.setPriority: PRIORITY_BELOW_NORMAL is nice 10 on Linux
//   (https://nodejs.org/docs/latest-v24.x/api/os.html).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type EngineText, type Result, type TranscriptionProblem } from "@morndo/domain";
import {
  parseProbe, parseRun, problemFromExit,
  type AbortHandle, type TranscribeInput, type Transcriber, type TranscriberProbe,
} from "@morndo/protocol";
import { redact } from "./log.ts";

const STDOUT_CAP = 1024 * 1024;
const STDERR_CAP = 4 * 1024;
const KILL_AFTER_MS = 10_000;
const PROBE_MS = 5_000;

export type ProcessHost = Transcriber & {
  /** Pids of the run in progress: the plugin, then any child it has started. Empty when nothing is running. */
  group(): readonly number[];
  /** Redacted stderr of the last finished run. Empty when the run produced text. Never the document. */
  detail(): string;
};

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function childrenOf(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    return raw === "" ? [] : raw.split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function groupOf(leader: number): number[] {
  const seen = new Set<number>();
  const stack = [leader];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    for (const child of childrenOf(pid)) stack.push(child);
  }
  return [leader, ...[...seen].filter(pid => pid !== leader)];
}

function killGroup(pid: number): ReturnType<typeof setTimeout> | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  const hard = setTimeout(() => {
    // Only when the group still exists: signal 0 is ESRCH once it is gone, and the pid may have been reused.
    if (!groupAlive(pid)) return;
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }, KILL_AFTER_MS);
  hard.unref?.();
  return hard;
}

// Whether any process still holds the process group: signal 0 to the pgid is ESRCH once the group is gone
// (kill(2), fetched 2026-10-13).
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch { return false; }
}

type Run = { code: number | null; stdout: string; stderr: string; capped: boolean; aborted: boolean };

function childEnv(tmp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { TMPDIR: tmp };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

function runProgram(program: string, args: string[], signal: AbortHandle, onLeader: (pid: number | null) => void): Promise<Run> {
  // The working directory is made before anything can fail inside the promise, and a throw here (no space, a
  // symlink loop in tmpdir) still rejects the caller's await: what was made is removed on the way out.
  let tmp = "";
  try {
    const made = mkdtempSync(join(tmpdir(), "morndo-tx-"));
    tmp = made;
    tmp = realpathSync(made);
  }
  catch (e) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(program, args, {
        cwd: tmp, env: childEnv(tmp), detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
    }
    catch (e) {
      // spawn throws synchronously on a bad argument (an empty program): the directory is the host's to remove.
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    const pid = child.pid;
    if (pid !== undefined && pid > 0) {
      onLeader(pid);
      try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the run still proceeds */ }
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let capped = false;
    let aborted = false;
    let settled = false;
    let hard: ReturnType<typeof setTimeout> | null = null;
    let escalated = false;
    // One escalation per run (a stdout cap and then an abort is still one group): a second would arm a second
    // timer nothing clears, and it would signal a pgid the kernel may have reused.
    const escalate = () => {
      if (escalated || pid === undefined) return;
      escalated = true;
      hard = killGroup(pid);
    };
    // The answer can be ready before the process has exited: an abort rejects at once, and the SIGKILL timer
    // outlives the leader's stdio while any process still holds the group, so a member that ignores SIGTERM and
    // holds no pipe is still taken. It is cleared only once the group is gone.
    const settle = (run: Run) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(run);
    };
    const reap = () => {
      if (hard && (pid === undefined || !groupAlive(pid))) {
        clearTimeout(hard);
        hard = null;
      }
      onLeader(null);
      rmSync(tmp, { recursive: true, force: true });
    };
    const onAbort = () => {
      aborted = true;
      escalate();
      settle({ code: null, stdout: "", stderr: "", capped: false, aborted: true });
    };
    signal.addEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (capped || aborted) return;
      if (stdout.length + chunk.length > STDOUT_CAP) {
        capped = true;
        escalate();
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length >= STDERR_CAP) return;
      stderr = Buffer.concat([stderr, chunk.subarray(0, STDERR_CAP - stderr.length)]);
    });
    child.on("error", () => {
      reap();
      settle({ code: null, stdout: "", stderr: stderr.toString("utf8"), capped, aborted });
    });
    child.on("close", code => {
      reap();
      if (aborted || signal.aborted) {
        settle({ code: null, stdout: "", stderr: "", capped: false, aborted: true });
        return;
      }
      settle({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), capped, aborted: false });
    });
  });
}

export function processTranscriber(program: string): ProcessHost {
  // One leader per run. A probe during a run is its own process: it never becomes the run's leader, and its close
  // takes nothing away — group() answers for the runs in progress (design §5), so a probe that starts and ends
  // while a run lives must change nothing it says.
  const runs = new Set<number>();
  let detail = "";
  const leaderOf = () => {
    let mine: number | null = null;
    return (pid: number | null) => {
      if (pid === null) {
        if (mine !== null) runs.delete(mine);
        mine = null;
        return;
      }
      mine = pid;
      runs.add(pid);
    };
  };

  return {
    group: () => {
      const seen = new Set<number>();
      for (const pid of runs) for (const member of groupOf(pid)) seen.add(member);
      return [...seen];
    },
    detail: () => detail,
    async probe(): Promise<TranscriberProbe> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_MS);
      try {
        // A probe holds no leader slot: it is not a run, whatever /api/me asks while one is going.
        const run = await runProgram(program, ["probe", "--json"], ac.signal, () => {});
        if (run.aborted) return { ready: false, reason: "not_ready", detail: "probe_timeout" };
        if (run.code === null) return { ready: false, reason: "missing", detail: "missing" };
        if (run.code !== 0) return { ready: false, reason: "not_ready", detail: redact(run.stderr).slice(0, STDERR_CAP) || "probe_failed" };
        const parsed = parseProbe(run.stdout);
        if (!parsed.ok) return { ready: false, reason: "protocol", detail: "bad_output" };
        if (!parsed.value.ready) return { ready: false, reason: "not_ready", detail: parsed.value.missing.join(",") };
        const doc = parsed.value;
        return {
          ready: true, engine: doc.engine, engineVersion: doc.engineVersion, model: doc.model,
          languages: doc.languages, maxSeconds: doc.maxSeconds,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async transcribe(input: TranscribeInput): Promise<Result<EngineText, TranscriptionProblem>> {
      const args = [
        "run", "--input", input.path, "--language", input.language,
        "--threads", String(input.threads), "--max-seconds", String(input.maxSeconds), "--json",
      ];
      const track = leaderOf();
      const run = await runProgram(program, args, input.signal, track);
      if (run.aborted) {
        detail = "";
        throw abortError();
      }
      if (run.capped || run.code === null) {
        detail = "bad_output";
        return err("bad_output");
      }
      const problem = problemFromExit(run.code);
      if (problem) {
        detail = redact(run.stderr).slice(0, STDERR_CAP);
        return err(problem);
      }
      const parsed = parseRun(run.stdout);
      if (!parsed.ok) {
        detail = "bad_output";
        return err("bad_output");
      }
      detail = "";
      const doc = parsed.value;
      return ok({ language: doc.language, durationMs: doc.durationMs, segments: doc.segments });
    },
  };
}
