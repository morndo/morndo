// update.apply (updates §5.4, §8.3): the fleet asks this node to move to a Version, and the node's whole part is to
// start the updater's apply unit — never to run the updater itself, never inside the agent's own unit, never a shell.
// - Linux: `systemctl --user start --no-block morndo-update-apply@<version>.service` — queued, not waited on; the
//   unit's own run reports what became of it. `--no-block` (systemd.unit(5) "no-block" of systemctl start, read
//   2026-10-21) is the point: the answer says the start was queued, not that the apply ran. The attempt id the
//   request carries (§5.4) goes there by apply.env, not by the instance name: a unit instance is one string.
// - macOS: launchd has no transient units, so the apply runs as a detached child of the updater launcher, as the
//   launchd ServiceManager starts one (updates §5, U19): no terminal's hangup takes the walk along. Detached and
//   unref'd, so the agent waits only for the spawn, the mirror of --no-block.
// The answer is `{ accepted: true }` once the start was queued; a failed start is an op error, internal with
// executed "no" (the default `internal` is "maybe", wrong for a start that never ran). What became of the apply
// arrives with the next health (state applying, rolled_back, …), never in this answer.
// The runner is a port so the tests see the exact command without a systemctl; the presence checks of §7 live here
// too: the launcher and the unit file (or the launchd plist) decide whether this node may say CAP_UPDATE at all.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UpdateStateFileSchema, type NodeUpdateHealth, type OpArgs, type OpResult } from "@morndo/protocol";
import { writeFileAtomicAsync } from "../atomic-write.ts";
import { effect, type EffectContext, type OpTable, type Outcome } from "./executor.ts";

// Starts a program, no shell: resolves once it was started (and, where the start is the whole ask, exited 0);
// rejects when it could not be started. A test replaces it to see the exact words.
export type CommandRunner = (file: string, args: readonly string[]) => Promise<void>;

// The updater's own state file (updates §6.3): the agent reads it, the updater writes it — each side keeps its own
// path; no code of one runs inside the other.
export const updateStateFile = (home: string): string => join(home, ".local/state/morndo-update/state.json");

// Whether the updater is installed here (updates §7): the launcher and the apply unit's template file on Linux, the
// launcher and the update job's plist on macOS. Without both, the node says no CAP_UPDATE and is sent no update.apply.
export function updaterInstalled(home: string): boolean {
  if (!existsSync(join(home, ".local/bin/morndo-update"))) return false;
  return process.platform === "darwin"
    ? existsSync(join(home, "Library/LaunchAgents/com.morndo.update.plist"))
    : existsSync(join(home, ".config/systemd/user/morndo-update-apply@.service"));
}

// The attempt id's own way there (§5.4): a unit instance carries one string (its Version), so on Linux the attempt
// travels by an environment file the unit's template reads — the agent writes it before the start, and a request
// without an attempt removes it, so no apply ever runs under an id a moment too old. On macOS the attempt rides the
// command line, where the whole apply already is.
export const applyEnvFile = (home: string): string => join(home, ".local/state/morndo-update/apply.env");

// The program that starts the apply for one Version, per platform, as one line a test can pin.
export function applyCommand(home: string, version: string, attempt?: string): { file: string; args: readonly string[] } {
  return process.platform === "darwin"
    ? { file: join(home, ".local/bin/morndo-update"), args: attempt === undefined
        ? ["update", "apply", "--version", version]
        : ["update", "apply", "--version", version, "--attempt", attempt] }
    : { file: "systemctl", args: ["--user", "start", "--no-block", `morndo-update-apply@${version}.service`] };
}

// The runner the agent runs with: systemctl's exit is the ask on Linux; on macOS the spawn itself is, so the child is
// unref'd the moment it is there and the agent never holds the apply open.
export const spawnApply: CommandRunner = (file, args) =>
  process.platform === "darwin"
    ? new Promise((resolve, reject) => {
        const child = spawn(file, args, { detached: true, stdio: "ignore" });
        child.on("error", reject);
        child.on("spawn", () => { child.unref(); resolve(); });
      })
    : new Promise((resolve, reject) => {
        const child = spawn(file, args, { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`exit ${code ?? "?"}`))));
      });

// The node's health `update` field (updates §6.3): the updater's state.json minus the moment it was written and the
// soak the fleet itself keeps. A file that is missing, unreadable or not the protocol's own shape is no field at all
// — an older or broken updater never reads as a malformed health.
export function readUpdateHealth(path: string): NodeUpdateHealth | null {
  let bytes: string;
  try { bytes = readFileSync(path, "utf8"); } catch { return null; }
  try {
    const { at: _at, soakMinutes: _soakMinutes, ...health } = UpdateStateFileSchema.parse(JSON.parse(bytes));
    return health;
  } catch { return null; }
}

export type UpdateDeps = {
  home: string;
  run?: CommandRunner;
};

export function updateOps(d: UpdateDeps): Pick<OpTable, "update.apply"> {
  const run = d.run ?? spawnApply;
  return {
    // One at a time: the queue key is the op itself, and a repeat under the same key waits for the first and reads
    // its outcome from the done keys (§5.3) — an apply asked twice is started once.
    "update.apply": effect(() => "update.apply", async (a: OpArgs["update.apply"], ctx: EffectContext):
      Promise<Outcome<"update.apply">> => {
      const ready = ctx.ready();                           // the deadline's last check, before anything is started
      if (ready !== null) return { ok: false, error: ready };
      const command = applyCommand(d.home, a.version, a.attempt);
      try {
        if (process.platform !== "darwin") {
          // The environment file is written (or removed) before the start, so the unit never reads an attempt from
          // an earlier request: the file and the start are one ask, and a failed start leaves the freshest word.
          if (a.attempt === undefined) rmSync(applyEnvFile(d.home), { force: true });
          else await writeFileAtomicAsync(applyEnvFile(d.home), `MORNDO_ATTEMPT=${a.attempt}\n`);   // its fsync off the loop (T-532)
        }
        await run(command.file, command.args);
        const result: OpResult["update.apply"] = { accepted: true };
        return { ok: true, result };
      } catch (e) {
        // Nothing ran: the queueing of the apply unit failed, not the apply. Safe to ask again.
        return { ok: false, error: { code: "internal", executed: "no", message: `starting the apply for ${a.version} failed: ${(e as Error).message}` } };
      }
    }),
  };
}
