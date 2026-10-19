// One way to run the engines CLI and read its exit. The hub and the connections adapter both use it, so a usage
// error, a refusal, a timeout and a full output buffer stay the same in both places.
// Argparse exits 2 and prints usage (argparse docs, read with the engines CLI, 2026-10-09). A refusal is also exit 2,
// with "engines: <why>" and no usage text. Run with an argument list, never a shell
// (Node docs, child_process.execFile, read 2026-10-07).
import { execFile, spawnSync } from "node:child_process";

export const ENGINES_TIMEOUT_MS = 15_000;
// spawnSync's own cap is 1 MiB (node:child_process, maxBuffer). A full engines listing can pass that.
// 8 MiB is the cap here. Past it, spawnSync reports ENOBUFS and signal SIGTERM, and execFile reports
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Both are an output-size failure, not a timeout.
export const ENGINES_MAX_OUTPUT = 8 * 1024 * 1024;

export class EnginesError extends Error {
  kind: "unavailable" | "refused";
  constructor(kind: "unavailable" | "refused", message: string) {
    super(message);
    this.kind = kind;
  }
}

export type EnginesRun = { code: number; stdout: string; stderr: string };

// `signal` stops the run: it is killed (SIGKILL), and the promise settles only once it has exited. execFile's own signal
// option calls back at once, before the process is gone (lib/child_process.js, errorhandler, v24.21.0); its callback on
// close comes after the exit ("Called with the output when process terminates", child_process docs, v24.21.0).
export function runEngines(program: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<EnginesRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped(program));
    const stop = () => { child.kill("SIGKILL"); };
    const child = execFile(program, [...args], { env, timeout: ENGINES_TIMEOUT_MS, maxBuffer: ENGINES_MAX_OUTPUT, encoding: "utf8" }, (error, stdout, stderr) => {
      signal?.removeEventListener("abort", stop);
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (signal?.aborted) return reject(stopped(program));
      const failed = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (typeof failed.code === "number" && !failed.killed) return resolve({ code: failed.code, stdout, stderr });
      reject(spawnFailure(program, failed, null));
    });
    signal?.addEventListener("abort", stop, { once: true });
  });
}

const stopped = (program: string) => new EnginesError("unavailable", `${program} was stopped: another engines call failed first`);

export function runEnginesSync(program: string, args: readonly string[], env: NodeJS.ProcessEnv): EnginesRun {
  const result = spawnSync(program, [...args], {
    env, encoding: "utf8", timeout: ENGINES_TIMEOUT_MS, maxBuffer: ENGINES_MAX_OUTPUT, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw spawnFailure(program, result.error as NodeJS.ErrnoException, result.signal);
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function spawnFailure(program: string, error: NodeJS.ErrnoException & { killed?: boolean }, signal: NodeJS.Signals | null): EnginesError {
  if (error.code === "ENOBUFS" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new EnginesError("unavailable", `${program} output exceeded ${ENGINES_MAX_OUTPUT} bytes`);
  }
  const timedOut = signal === "SIGTERM" || error.killed === true || /ETIMEDOUT|timed out/.test(error.message);
  const why = timedOut ? `${program} took longer than ${ENGINES_TIMEOUT_MS / 1000} s` : `${program} can't run (${String(error.code ?? error.message)})`;
  return new EnginesError("unavailable", why);
}

// Exit 0 (or one of `ok`) and its output, else the CLI's own reason.
export function enginesText(run: EnginesRun, okCodes: readonly number[] = [0]): string {
  if (okCodes.includes(run.code)) return run.stdout;
  const why = run.stderr.trim().replace(/^engines:\s*/, "") || `exit ${run.code}`;
  const usage = /^usage:/m.test(run.stderr);
  throw new EnginesError(run.code === 2 && !usage ? "refused" : "unavailable", why);
}

// The kill switch as `option enabled` prints it (JSON): on only for `true`. Any other value is off, so an answer this
// reader doesn't know never turns roles on ("a failure will follow the same execution path as disallowing the
// operation", OWASP, Fail securely, read 2026-10-13); output that isn't JSON is an unavailable CLI. The hub's Engines
// page and the node's lane.start both read it here, so they never disagree.
export function enginesEnabledOf(text: string): boolean {
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new EnginesError("unavailable", "engines option didn't answer in JSON"); }
  return v === true;
}
