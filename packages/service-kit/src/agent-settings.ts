// The settings a lane's command needs (T-318, P1): the hub's address (MORNDO_HUB, file agent-hub), this machine's node
// name (MORNDO_NODE, agent-node), the agent token (MORNDO_AGENT_TOKEN, agent-lanes.token or agent-manager.token) and
// the lane's own name (MORNDO_LANE, the tmux window's name) — read from ~/.config/morndo when the environment has
// none, which is what the per-machine wrapper scripts did by hand. The environment always wins; a value that is empty
// after trim counts as unset, as the wrappers' `[ -z … ]` did. A file's value is its first line, trimmed; a missing
// file, a blank first line or a read that fails all mean "not set", and neither a file's content nor why it could not
// be read is ever said anywhere: a token file's content is a secret, and its path is this machine's layout.
//
// The token follows the lane: a lane named exactly `manager` (from the environment or the window) reads only
// agent-manager.token, every other lane — or no lane known — reads only the one the workers share,
// agent-lanes.token; the manager's file is never opened for a lane that is not the manager. The lane itself is asked
// of tmux about THIS pane (`display-message -p -t "$TMUX_PANE" '#W'`), never the session's active window: without -t a
// lane would act as whichever window is on screen, and could be handed the manager's token.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentEnv = { [name: string]: string | undefined };

// Where the settings come from: the home the files sit under, a file reader that answers null for one it cannot read,
// and the lane's name (the tmux window's). A test brings its own versions of all three.
export type AgentSettingsIo = { home: string; readText: (path: string) => Promise<string | null>; lane: () => Promise<string | null> };

// A value counts as set only when it is there and not blank (the wrappers' `[ -z … ]`).
const set = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

// One settings file's first line, trimmed; null for a file that is missing, blank or cannot be read — all the same
// "not set", with nothing of it said.
async function firstLine(io: AgentSettingsIo, name: string): Promise<string | null> {
  try {
    const text = await io.readText(join(io.home, ".config/morndo", name));
    if (text === null) return null;
    const value = (text.split("\n")[0] ?? "").trim();
    return value === "" ? null : value;
  } catch {
    return null;   // never the error, never the content
  }
}

// The environment with MORNDO_HUB, MORNDO_NODE, MORNDO_AGENT_TOKEN and MORNDO_LANE filled in where it has none of
// them: a new object, the input unchanged. Nothing is read while nothing is missing, and of the files, only those for
// the values that are.
export async function withAgentSettings(env: AgentEnv, io: AgentSettingsIo): Promise<AgentEnv> {
  const got: AgentEnv = { ...env };
  // The lane the token follows: the environment's own when it has one (the window is not asked at all), else the
  // window's, which becomes MORNDO_LANE when it answers a name.
  let lane: string | null = set(env.MORNDO_LANE) ? env.MORNDO_LANE!.trim() : null;
  if (lane === null) {
    const window = await io.lane();
    if (window !== null && window.trim() !== "") {
      lane = window.trim();
      got.MORNDO_LANE = lane;
    }
  }
  if (!set(env.MORNDO_HUB)) {
    const hub = await firstLine(io, "agent-hub");
    if (hub !== null) got.MORNDO_HUB = hub;
  }
  if (!set(env.MORNDO_NODE)) {
    const node = await firstLine(io, "agent-node");
    if (node !== null) got.MORNDO_NODE = node;
  }
  if (!set(env.MORNDO_AGENT_TOKEN)) {
    const token = await firstLine(io, lane === "manager" ? "agent-manager.token" : "agent-lanes.token");
    if (token !== null) got.MORNDO_AGENT_TOKEN = token;
  }
  return got;
}

const askTmux = (args: string[]): Promise<string | null> => new Promise(resolve => {
  execFile("tmux", args, { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
});

// The name of the tmux window this command runs in, asked about its own pane ($TMUX_PANE): the pane's window, not the
// session's active one. Null outside tmux, with no pane named, when tmux fails, or when the answer is blank.
export async function laneFromTmux(env: AgentEnv, tmux: (args: string[]) => Promise<string | null> = askTmux): Promise<string | null> {
  if (!set(env.TMUX) || !set(env.TMUX_PANE)) return null;
  const name = ((await tmux(["display-message", "-p", "-t", env.TMUX_PANE!, "#W"])) ?? "").trim();
  return name === "" ? null : name;
}

// The io of the real machine: the home directory, a reader that turns any failure into "not set", and the tmux window's
// name for this process's environment.
export function agentSettingsIo(env: AgentEnv): AgentSettingsIo {
  return {
    home: set(env.HOME) ? env.HOME! : homedir(),
    readText: async path => { try { return await readFile(path, "utf8"); } catch { return null; } },
    lane: () => laneFromTmux(env),
  };
}
