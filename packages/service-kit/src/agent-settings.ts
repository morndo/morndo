// The settings a lane's command needs (T-318, P1): the hub's address (MORNDO_HUB, file agent-hub), this machine's node
// name (MORNDO_NODE, agent-node), the agent token (MORNDO_AGENT_TOKEN, agent-lanes.token or agent-manager.token) and
// the lane's own name (MORNDO_LANE, the tmux window's name) — read from ~/.config/morndo when the environment has
// none, which is what the per-machine wrapper scripts did by hand. The environment always wins; an empty value counts
// as unset, as the wrappers' `[ -z … ]` did — and a blank one (whitespace only) counts as unset here too. A file's
// value is its first line, trimmed; a missing file, a blank first line or a read that fails all mean "not set", and
// neither a file's content nor why it could not be read is ever said anywhere: a token file's content is a secret, and
// its path is this machine's layout.
//
// The token follows the lane: the lane named MORNDO_MANAGER_WINDOW (the hub's setting, default `manager`), from the
// environment or the window, reads only agent-manager.token; every other lane — or no lane known — reads only the one
// the workers share, agent-lanes.token. That is a choice of file, as the wrappers made it, not a boundary: every lane
// runs as the same user and can read either file. The lane itself is asked of tmux about THIS pane (`display-message -p
// -t "$TMUX_PANE" '#W'`), never the session's active window: without -t a lane would act as whichever window is on
// screen, and could be handed the manager's token.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentEnv = { [name: string]: string | undefined };

// Where the settings come from: the home the files sit under, a file reader that answers null for one it cannot read
// (and says nothing of why), and the lane's name (the tmux window's). A test brings its own versions of all three.
export type AgentSettingsIo = { home: string; readText: (path: string) => Promise<string | null>; lane: () => Promise<string | null> };

// What a command needs of the settings. By default all three files are looked at, for what is missing; the lane is filled in
// only when the token's file has to be chosen by it (a command that needs MORNDO_LANE itself says `fillLane`).
export type AgentSettingsWant = { skip?: readonly ("hub" | "node")[]; fillLane?: boolean };

// A value counts as set only when it is there and not blank: the wrappers' `[ -z … ]` asked only for empty, and a
// whitespace-only value counts as unset here too.
const set = (value: string | undefined): value is string => value !== undefined && value.trim() !== "";

// Any character a value must not carry: the C0 controls and DEL. Such a value would end up in an HTTP header or an
// error text, where the runtime throws an error that quotes it — so it is treated as not set before it gets there.
const hasControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

// The domain's node name (M3), as the memory CLI checks it: a name from the file that is none is not used, so the CLI
// falls back to the host name as it did before there was a file.
const NODE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// One settings file's first line, trimmed; null for a file that is missing, blank, unreadable or that carries a control
// character (hasControl). A line ending in CRLF still works: the trailing carriage return is removed by the trim.
async function firstLine(io: AgentSettingsIo, name: string): Promise<string | null> {
  const text = await io.readText(join(io.home, ".config/morndo", name));
  if (text === null) return null;
  const value = (text.split("\n")[0] ?? "").trim();
  return value !== "" && !hasControl(value) ? value : null;
}

// The environment with MORNDO_HUB, MORNDO_NODE, MORNDO_AGENT_TOKEN and MORNDO_LANE filled in where it has none of
// them: a new object, the input unchanged. Only the files for values that are missing are read (together), and the
// window is asked only when MORNDO_LANE is missing and the token's file depends on it, or the caller wants the lane.
// The manager's window is the hub's MORNDO_MANAGER_WINDOW (default `manager`).
export async function withAgentSettings(env: AgentEnv, io: AgentSettingsIo, want: AgentSettingsWant = {}): Promise<AgentEnv> {
  const got: AgentEnv = { ...env };
  const needHub = !set(env.MORNDO_HUB) && !want.skip?.includes("hub");
  const needNode = !set(env.MORNDO_NODE) && !want.skip?.includes("node");
  const needToken = !set(env.MORNDO_AGENT_TOKEN);
  let lane: string | null = set(env.MORNDO_LANE) ? env.MORNDO_LANE!.trim() : null;
  const askLane = lane === null && (needToken || want.fillLane === true);
  const [hub, node, window] = await Promise.all([
    needHub ? firstLine(io, "agent-hub") : null,
    needNode ? firstLine(io, "agent-node") : null,
    askLane ? io.lane() : null,
  ]);
  if (hub !== null) got.MORNDO_HUB = hub;
  if (node !== null && NODE_NAME.test(node)) got.MORNDO_NODE = node;
  if (window !== null && window.trim() !== "") {
    lane = window.trim();
    got.MORNDO_LANE = lane;
  }
  if (needToken) {
    const manager = set(env.MORNDO_MANAGER_WINDOW) ? env.MORNDO_MANAGER_WINDOW!.trim() : "manager";
    const token = await firstLine(io, lane === manager ? "agent-manager.token" : "agent-lanes.token");
    if (token !== null) got.MORNDO_AGENT_TOKEN = token;
  }
  return got;
}

// A command that only prints text (help, a prompt, a usage line) needs no settings, and must not wait on tmux for them:
// no arguments, a help flag, or a first word that is one of the command's `offline` words.
export function runsOffline(argv: readonly string[], offline: readonly string[]): boolean {
  if (argv.some(a => a === "--help" || a === "-h")) return true;
  const first = argv.find(a => !a.startsWith("-"));
  return first === undefined || offline.includes(first);
}

const askTmux = (args: string[]): Promise<string | null> => new Promise(resolve => {
  execFile("tmux", args, { encoding: "utf8", timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout));
});

// The name of the tmux window this command runs in, asked about its own pane ($TMUX_PANE) when the environment has one:
// the pane's window, not the session's active one. An environment with TMUX and no TMUX_PANE (a pane lost on the way)
// is asked as before, without `-t`. Null outside tmux, when tmux fails, or when the answer is blank.
export async function laneFromTmux(env: AgentEnv, tmux: (args: string[]) => Promise<string | null> = askTmux): Promise<string | null> {
  if (!set(env.TMUX)) return null;
  const name = ((await tmux(set(env.TMUX_PANE) ? ["display-message", "-p", "-t", env.TMUX_PANE, "#W"] : ["display-message", "-p", "#W"])) ?? "").trim();
  return name === "" ? null : name;
}

// The io of the real machine: the home directory, a reader that turns any failure into "not set", and the tmux window's
// name for this process's environment, asked at most once however often it is wanted (the command's own lookup shares it).
export function agentSettingsIo(env: AgentEnv, tmux?: (args: string[]) => Promise<string | null>): AgentSettingsIo {
  let asked: Promise<string | null> | null = null;
  return {
    home: set(env.HOME) ? env.HOME : homedir(),
    readText: async path => { try { return await readFile(path, "utf8"); } catch { return null; } },
    lane: () => (asked ??= laneFromTmux(env, tmux)),
  };
}
