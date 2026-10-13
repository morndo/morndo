// The tmux server must not live in the node agent's service cgroup. systemd's default KillMode=control-group kills
// every process in that cgroup when the unit stops (systemd.kill(5)). systemd-run --user --scope runs the server in a
// transient scope of the user manager, in the user root slice, not inside the calling service (systemd-run(1), local
// systemd, --help checked 2026-10-11: --user, --scope, --quiet, --collect). The client exits; the server stays in the
// scope. A later tmux command is only a client.
//
// start-server alone does not stay. exit-empty defaults to on (tmux(1)), so a server with no session exits and --collect
// drops the scope; the next new-session then becomes the server inside the caller. The same client turns exit-empty off
// before it disconnects (";" is tmux's command separator, passed as its own argument; seen on tmux 3.4, 2026-10-11).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);

export function tmuxHostCommand(socket: string | null, scope: boolean): { command: string; args: string[] } {
  const tmuxArgs = tmuxArgv(socket, ["start-server", ";", "set-option", "-s", "exit-empty", "off"]);
  if (!scope) return { command: "tmux", args: tmuxArgs };
  // The command is `tmux`; its -u is an argument, not a systemd-run option (systemd-run takes options only before the command).
  return { command: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", "tmux", ...tmuxArgs] };
}

export async function userManagerUsable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.XDG_RUNTIME_DIR) return false;
  try {
    await run("systemctl", ["--user", "is-active", "--quiet", "default.target"], { timeout: 2000, env });
    return true;
  } catch {
    return false;
  }
}

export type TmuxHost = "scoped" | "in-unit" | "skipped";

// Skipped under a test runner, so a suite on a shared machine never calls systemd-run --user.
export async function hostTmuxServer(opts: {
  socket: string | null;
  env?: NodeJS.ProcessEnv;
  usable?: () => Promise<boolean>;
  exec?: (command: string, args: string[]) => Promise<void>;
}): Promise<TmuxHost> {
  const env = opts.env ?? process.env;
  if (env.NODE_ENV === "test" || env.VITEST) return "skipped";
  // The control run sets this so the server stays in the caller's cgroup and a stop kills it.
  const scope = env.MORNDO_TMUX_NO_SCOPE === "1" ? false : await (opts.usable ?? (() => userManagerUsable(env)))();
  const cmd = tmuxHostCommand(opts.socket, scope);
  const exec = opts.exec ?? (async (command, args) => { await run(command, args, { timeout: 15_000, env }); });
  await exec(cmd.command, cmd.args);
  return scope ? "scoped" : "in-unit";
}
