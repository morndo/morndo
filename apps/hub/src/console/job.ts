// `morndo job …` (ADR-0017): the hub runs the node-agent's job program with an argument list and no shell — as it runs
// the updater's program (design §4.8) — and leaves with its exit code. The job CLI is a program the hub starts, never a
// module it links (§4.7 test 2: no other app imports apps/node-agent), so this file names its path and nothing else of
// it.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";

export function runJobProgram(args: readonly string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "../../../node-agent/src/job-main.ts"), ...args], {
      stdio: "inherit",   // its output is the principal's console's output, whatever stream it chose
      shell: false,       // an argument list, never a command line (§4.8)
    });
    // A child that dies by a signal leaves no code of its own: the shell's convention (128 + the signal's number)
    // is what called `morndo job` understands. One that cannot even start is our own failure (EX_SOFTWARE, 70).
    child.once("error", () => resolve(70));
    child.once("close", (code, signal) => resolve(
      code !== null ? code : 128 + (signal === null ? 0 : constants.signals[signal] ?? 0)));
  });
}
