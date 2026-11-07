// `morndo update` and `morndo doctor` (design §4.8): the hub runs the updater's program with an argument list and
// no shell — as it runs the engines CLI (ADR-0013) — and leaves with its exit code. The updater is a program the
// hub starts, never a module it links (§4.7 test 2: no other app imports apps/updater), so this file names its
// path and nothing else of it.
import { join } from "node:path";
import { runProgram } from "./program.ts";

export function runUpdaterProgram(args: readonly string[]): Promise<number> {
  return runProgram(join(import.meta.dirname, "../../../updater/src/main.ts"), args);
}
