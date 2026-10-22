// The control plane's own updater as the hub runs it (updates §8.1, PR 6c): the CLI this tree installs beside the
// hub, ~/.local/bin/morndo-update (MORNDO_UPDATE_BIN names another). `--status --json` reads; `update --yes
// --detach` and `update --rollback --yes --detach` start the move and answer at once (PR 6c part 3), so the hub
// never waits out an update of the machine it runs on. Run with execFile and an argument list, never a shell (Node
// docs, child_process.execFile, read 2026-10-22). A status that doesn't answer, or doesn't fit
// UpdateStatusSchema, reads as null: the view shows that as it is, and a command to the control plane refuses —
// the hub will not move its own machine on a guess.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { UpdateStatusSchema } from "@morndo/protocol";
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
        const { stdout } = await run(bin, ["--status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
        const parsed = UpdateStatusSchema.safeParse(JSON.parse(stdout));
        return parsed.success ? parsed.data : null;
      } catch { return null; }
    },
    async applyDetached() { await run(bin, ["update", "--yes", "--detach"]); },
    async rollbackDetached() { await run(bin, ["update", "--rollback", "--yes", "--detach"]); },
  };
}
