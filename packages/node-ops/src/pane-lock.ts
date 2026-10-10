// One typist at a time in a shared pane. The box's other typists into the manager's pane (kira, lane-events-push) take
// an exclusive flock(2) lock on one file around "look, paste, Enter"; the hub takes the same lock, so a paste of ours
// never merges with theirs into one message. Like kira, through flock(1) (util-linux): a child holds the lock until we
// close its stdin, and lets go by itself after 60 s, so a stuck hub can't block the others.
import { spawn } from "node:child_process";

export type PaneLock = <T>(f: () => Promise<T>) => Promise<T | "busy">;

export function paneLock(path: string, waitS = 20): PaneLock {
  return async <T>(f: () => Promise<T>) => {
    const holder = spawn("flock", ["-x", "-w", String(waitS), path, "-c", "echo held; exec timeout 60 cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
    const held = await new Promise<boolean>(resolve => {
      holder.stdout.once("data", d => resolve(String(d).startsWith("held")));
      holder.once("exit", () => resolve(false));
      holder.once("error", () => resolve(false));
    });
    if (!held) { holder.kill(); return "busy"; }
    try { return await f(); }
    finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const gone = new Promise(r => holder.once("exit", r));
        holder.stdin.end();
        await gone;
      }
    }
  };
}
