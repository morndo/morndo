// A bin run as a child with its stdout a pipe (https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io,
// read 2026-10-20).
//   runOnPipe: a reader that takes nothing for a moment, as a busy consumer would, so a bin that exits at once is cut
//     every time.
//   runIntoHead: the shell pipeline `bin | head -c 100`. Node's own "pipe" stdio is a socket pair whose buffers grow and
//     shrink, so a reader closing early is only sometimes an EPIPE for the bin; a real pipe holds 64 KiB and always is.
import { spawn } from "node:child_process";

export type PipeRun = { code: number | null; stdout: string; stderr: string };

export function runOnPipe(args: readonly string[], env: NodeJS.ProcessEnv): Promise<PipeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => err.push(c));
    let reading = false;
    const drain = () => { for (let c; reading && (c = child.stdout.read() as Buffer | null) !== null;) out.push(c); };
    child.stdout.on("readable", drain);
    setTimeout(() => { reading = true; drain(); }, 300);
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

// The bin's own exit code (pipefail) and what it said on stderr; its stdout went to head.
export function runIntoHead(args: readonly string[], env: NodeJS.ProcessEnv): Promise<PipeRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", 'set -o pipefail; "$0" "$@" | head -c 100 >/dev/null', process.execPath, "--no-warnings", ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
    const err: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout: "", stderr: Buffer.concat(err).toString("utf8") }));
  });
}
