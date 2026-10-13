// An isolated tmux server for tests (`tmux -L test-<uuid>`, never the owner's), shared by node-ops', the agent's and the
// fleet drills' tests. Its commands pass -u (tmux-cli.ts). kill() returns only once the server is gone: kill-server
// returns before the server has exited, and the socket is already gone while the process is still a zombie (its parent
// reaps it a moment later). A server started at once on the same socket can meet the dying one ("server exited
// unexpectedly", seen with tmux 3.3a). kill() asks that socket for #{pid} and waits, yielding the event loop, until
// tmux says no server runs there and process.kill(pid, 0) fails. A parent that never reaps gives up quickly. Then it
// removes the socket file, which tmux leaves behind. Each command gets the environment as it is at that moment (a test
// may set PATH for the server it starts), minus TMUX and TMUX_PANE, so a test run from inside a tmux pane (a lane
// running the suite) behaves as anywhere else.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

export type TestTmux = { socket: string; tmux(...args: string[]): string; kill(): Promise<void> };

export function isolatedTmux(): TestTmux {
  const socket = `test-${randomUUID()}`;
  const env = () => {
    const e = { ...process.env };
    delete e.TMUX;
    delete e.TMUX_PANE;
    return e;
  };
  const tmux = (...args: string[]) => execFileSync("tmux", ["-u", "-L", socket, ...args], { encoding: "utf8", env: env() });
  const gone = () => {
    try { execFileSync("tmux", ["-L", socket, "list-sessions"], { stdio: "pipe", env: env() }); return false; }
    catch (e) { return /no server running|error connecting/.test(String((e as { stderr?: unknown }).stderr)); }
  };
  const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
  // #{pid} is the server pid on this socket (tmux(1) formats). process.kill(pid, 0) checks it is still there.
  const serverPid = () => {
    try {
      const out = execFileSync("tmux", ["-u", "-L", socket, "display-message", "-p", "#{pid}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env() });
      const pid = Number(out.trim());
      if (!Number.isInteger(pid) || pid <= 0) return 0;
      try { process.kill(pid, 0); return pid; } catch { return 0; }
    } catch { return 0; }
  };
  // "dead": the pid has left the table. "foreign": it was reused or cannot be signalled, so waiting will not help.
  const fate = (pid: number) => {
    try { process.kill(pid, 0); return "alive" as const; }
    catch (e) { return (e as { code?: string }).code === "ESRCH" ? "dead" as const : "foreign" as const; }
  };
  const kill = async () => {
    const pid = serverPid();
    try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", env: env() }); } catch { /* no server */ }
    for (let i = 0; i < 25 && !gone(); i++) await pause(20);
    for (let i = 0; pid > 0 && i < 10 && fate(pid) === "alive"; i++) await pause(20);
    // tmux(1): the socket is in TMUX_TMPDIR, else /tmp, under tmux-<uid>.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
  };
  return { socket, tmux, kill };
}
