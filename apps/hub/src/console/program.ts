// Starts another app's program with an argument list and no shell, and leaves with its exit code. The hub runs the
// updater's program and the node agent's job program this way (design §4.8): a program it starts, never a module it
// links (§4.7 test 2: no other app imports another), so a caller names a path and nothing else of the program.
import { spawn } from "node:child_process";
import { constants } from "node:os";

export function runProgram(path: string, args: readonly string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path, ...args], {
      stdio: "inherit",   // its output is the person's console output, whatever stream it chose
      shell: false,       // an argument list, never a command line (§4.8)
    });
    // A child that dies by a signal leaves no code of its own: the shell's convention (128 + the signal's number)
    // is what the caller of `morndo update` or `morndo job` understands. One that cannot even start is our own failure
    // (EX_SOFTWARE, 70).
    child.once("error", () => resolve(70));
    child.once("close", (code, signal) => resolve(
      code !== null ? code : 128 + (signal === null ? 0 : constants.signals[signal] ?? 0)));
  });
}
