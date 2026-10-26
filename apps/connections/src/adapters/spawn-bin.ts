// Starting a CLI binary for a read, in one place. A script (.mjs or .js) runs through this Node; anything else runs as it is.
// A child that leads a process group of its own can be stopped whole: SIGTERM, then SIGKILL after a short grace, and the caller
// waits for that before it goes on, so a program that exits right after (main.ts) leaves no orphan behind.
import { isAbsolute } from "node:path";

export const STOP_GRACE_MS = 1_000;

export function binCommand(bin: string, args: readonly string[]): { command: string; argv: string[] } {
  const script = bin.endsWith(".mjs") || bin.endsWith(".js");
  return { command: script ? process.execPath : bin, argv: [...(script ? [bin] : []), ...args] };
}

// ENOENT is a missing file, or for a script with a `#!` line a missing interpreter: on PATH only when the name had no directory.
export function notStartedProblem(error: unknown, bin: string): string {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return `${bin} could not be started`;
  return isAbsolute(bin) ? `${bin} could not be started: it is missing, or its interpreter is not on PATH` : `${bin} is not on PATH`;
}

const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; } catch { return false; }
};

// SIGTERM to the group, then SIGKILL when it is still there after `graceMs` (0: at once). Resolves when the group is gone.
export async function stopGroup(pid: number | undefined, graceMs = STOP_GRACE_MS): Promise<void> {
  if (pid === undefined) return;
  const signal = (name: NodeJS.Signals): void => { try { process.kill(-pid, name); } catch { /* already gone */ } };
  signal(graceMs > 0 ? "SIGTERM" : "SIGKILL");
  const until = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  if (groupAlive(pid)) {
    signal("SIGKILL");
    for (let i = 0; i < 50 && groupAlive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
