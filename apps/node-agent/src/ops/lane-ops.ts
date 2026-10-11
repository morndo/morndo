// lane.start and lane.stop (spec §4 "Lane names", §5.3, §8): typed fields only, never free flags or a shell line. A
// lane is a tmux window in the policy's session running Claude Code, and its name is unique on this node (the fleet
// keeps it unique across nodes).
// - tmux runs the command's words directly, without `sh -c`, when it gets more than one (tmux(1) new-window: "shell-command
//   given as multiple arguments and executed directly", read 2026-10-06; seen: an argument "$(id)" arrives as written).
// - tmux expands formats in `-n` names ("#{pane_id}" becomes "%0") and in `-c` directories (a directory
//   "a#{session_name}b" starts the pane in "amainb"; seen on tmux 3.6a, 2026-10-06), and `#(…)` in a format names a shell
//   command, so the name and the directory both go through node-ops' tmuxLiteral ("#" written as "##"), and the
//   session through exactSession (never a prefix match). The command's own words are not expanded (seen: an argument
//   "v#{session_name}w" arrives as written), and account and resume can hold no "#" anyway.
// - The window to stop is targeted by its ID (@N) from the inventory, never by its name.
import { realpathSync, statSync } from "node:fs";
import { formatWorkerId, type OpArgs } from "@morndo/protocol";
import { deniedBy, denyConfigFromEnv, denyRoots, exactSession, hostTmuxServer, resolvedRoots, tmuxLiteral } from "@morndo/node-ops";
import type { Policy } from "../config.ts";
import { effect, fail, ok, type OpTable } from "./executor.ts";
import type { Inventory } from "./inventory.ts";
import { tmuxRun } from "./tmux-panes.ts";

export type LaneDeps = { node: string; policy: Policy; inventory: Inventory; home: string; stateDir: string; stamp: (socket: string | null) => Promise<string | null> };

export function laneCommand(a: OpArgs["lane.start"]): string[] {
  const resume = a.resume === undefined ? [] : ["--resume", a.resume];
  return a.account === undefined ? ["claude", ...resume] : ["claude-as", a.account, ...resume];
}

function realDir(p: string): string | null {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function laneOps(d: LaneDeps): Pick<OpTable, "lane.start" | "lane.stop"> {
  const socket = d.policy.tmuxSocket;
  const session = d.policy.session;
  // The cwd is judged resolved (realDir), so the deny roots are too, at each start: under a HOME that is a symbolic
  // link, "~/.ssh" as given never prefixes the real path of a directory in it (final review M10).
  const deny = () => resolvedRoots(denyRoots(d.home, d.stateDir, denyConfigFromEnv(process.env)));
  const sessionExists = async () => {
    try { await tmuxRun(socket, ["has-session", "-t", exactSession(session)]); return true; }
    catch { return false; }
  };

  return {
    "lane.start": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const cwd = realDir(a.cwd);
      if (!cwd) return fail("bad_args", "cwd is not a directory on this node");
      if (deniedBy(cwd, deny())) return fail("denied", "lanes may not start in that directory");
      const snap = await d.inventory.refresh();
      if (snap.rows.some(r => r.window === a.name)) return fail("name_taken", "a window of that name already exists on this node");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const exists = await sessionExists();
      // A missed startup host must not start the server inside this service's cgroup.
      if (!exists) await hostTmuxServer({ socket });
      const where = exists ? ["new-window", "-d", "-t", `${exactSession(session)}:`] : ["new-session", "-d", "-s", tmuxLiteral(session)];
      const out = await tmuxRun(socket, [...where, "-n", tmuxLiteral(a.name), "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...laneCommand(a)]);
      const pane = /^%(\d{1,9})$/.exec(out.trim());
      if (!pane) return fail("internal", "tmux did not report the new pane");
      const stamp = await d.stamp(socket);
      if (!stamp) return fail("internal", "the tmux server could not be stamped");
      await d.inventory.refresh();                           // so this answer's invVersion already lists the new lane
      return ok<"lane.start">({ workerId: formatWorkerId({ node: d.node, server: stamp, pane: Number(pane[1]) }) });
    }),

    "lane.stop": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const snap = await d.inventory.refresh();
      const windows = [...new Set(snap.lanes.filter(l => l.window === a.name).map(l => l.windowId))];
      if (windows.length === 0) return fail("no_pane", "no lane of that name on this node");
      if (windows.length > 1) return fail("bad_args", "two windows on this node have that name; stop one in tmux");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      await tmuxRun(socket, ["kill-window", "-t", windows[0] as string]);
      await d.inventory.refresh();
      return ok<"lane.stop">({ ok: true });
    }),
  };
}
