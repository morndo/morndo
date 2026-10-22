// The control plane's own updater as the hub runs it (updates §8.1, PR 6c): the CLI this tree installs beside the
// hub, ~/.local/bin/morndo-update (MORNDO_UPDATE_BIN names another). `update --status --json` reads; the two
// detached commands start the move and answer at once (PR 6c part 3), so the hub never waits out an update of the
// machine it runs on. Every argument list is UPDATER_ARGS's (packages/protocol, PR 6c round 2 R1): one place, so
// this adapter cannot drift from the updater's own command line — the lists are never spelled here. Run with
// execFile and an argument list, never a shell (Node docs, child_process.execFile, read 2026-10-22). A status that
// doesn't answer, or doesn't fit UpdateStatusSchema, reads as null: the view shows that as it is, and a command to
// the control plane refuses — the hub will not move its own machine on a guess.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { UpdateStatusSchema, UPDATER_ARGS } from "@morndo/protocol";
import type { UpdaterCli } from "../application/updates-ports.ts";

const runFile = promisify(execFile);
const STATUS_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 30_000;

// One run of the binary: its stdout. Injected in the tests; execFile in production, with a timeout so a hung
// updater is an error, not a hub that never answers.
export type UpdaterRunner = (file: string, args: string[], o?: { timeoutMs?: number }) => Promise<{ stdout: string }>;

export function updaterCli(o: { bin?: string; env?: NodeJS.ProcessEnv; run?: UpdaterRunner } = {}): UpdaterCli {
  const env = o.env ?? process.env;
  const bin = o.bin ?? env.MORNDO_UPDATE_BIN ?? join(env.HOME || homedir(), ".local/bin/morndo-update");
  const run: UpdaterRunner = o.run ?? ((file, args, r) => runFile(file, args, { timeout: r?.timeoutMs ?? RUN_TIMEOUT_MS, encoding: "utf8", env }));
  return {
    // Null when the updater did not answer, or its answer didn't fit the schema: no status, shown as that.
    async status() {
      try {
        const { stdout } = await run(bin, UPDATER_ARGS.status, { timeoutMs: STATUS_TIMEOUT_MS });
        const parsed = UpdateStatusSchema.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : null;
      } catch { return null; }
    },
    // The Version the screen pressed rides --staged (R3): the updater applies only it, never a newer one a check
    // staged between the page's look and the press.
    async applyDetached(version: string) { await run(bin, UPDATER_ARGS.apply(version)); },
    async rollbackDetached() { await run(bin, UPDATER_ARGS.rollback); },
  };
}
