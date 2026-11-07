// `morndo job …` (ADR-0017): the hub runs the node-agent's job program with an argument list and no shell — as it runs
// the updater's program (design §4.8) — and leaves with its exit code. The job CLI is a program the hub starts, never a
// module it links (§4.7 test 2: no other app imports apps/node-agent), so this file names its path and nothing else of
// it.
import { join } from "node:path";
import { runProgram } from "./program.ts";

export function runJobProgram(args: readonly string[]): Promise<number> {
  return runProgram(join(import.meta.dirname, "../../../node-agent/src/job-main.ts"), args);
}
