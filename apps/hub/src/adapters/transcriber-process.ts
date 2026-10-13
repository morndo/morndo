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
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }, KILL_AFTER_MS);
  hard.unref?.();
  return hard;
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
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "morndo-tx-")));
  return new Promise(resolve => {
    const child = spawn(program, args, {
      cwd: tmp, env: childEnv(tmp), detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
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
    // The answer can be ready before the process has exited: an abort rejects at once, and the SIGKILL
    // timer stays until close so a child that ignores SIGTERM is still taken. Clearing it here would cancel that.
    const settle = (run: Run) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(run);
    };
    const reap = () => {
      if (hard) clearTimeout(hard);
      hard = null;
      onLeader(null);
      rmSync(tmp, { recursive: true, force: true });
    };
    const onAbort = () => {
      aborted = true;
      if (pid !== undefined) hard = killGroup(pid);
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
        if (pid !== undefined) hard = killGroup(pid);
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
  let leader: number | null = null;
  let detail = "";
  const setLeader = (pid: number | null) => { leader = pid; };

  return {
    group: () => leader === null ? [] : groupOf(leader),
    detail: () => detail,
    async probe(): Promise<TranscriberProbe> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_MS);
      try {
        const run = await runProgram(program, ["probe", "--json"], ac.signal, setLeader);
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
      const run = await runProgram(program, args, input.signal, setLeader);
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
