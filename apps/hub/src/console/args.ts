// `serve`, `pair`, `devices`, `revoke` and `agent-token` answer `--help` before main.ts reads settings or the database:
// `revoke --help` is usage, not a device named "--help". A command this file does not know is left to run.
import { AGENT_SCOPES } from "@morndo/protocol";

export type ConsoleArgs =
  | { kind: "run" }
  | { kind: "help"; usage: string }
  | { kind: "refused"; command: string; why: string; synopsis: string };

const AGENT_USAGE = `usage: morndo agent-token new <name> --role manager|worker [--scope ${AGENT_SCOPES.join("|")}]
       morndo agent-token list
       morndo agent-token revoke <id>`;
const AGENT_SYNOPSIS = `usage: morndo agent-token new <name> --role manager|worker [--scope ${AGENT_SCOPES.join("|")}] | list | revoke <id>`;

const asksForHelp = (args: readonly string[]) => args.includes("--help") || args.includes("-h");
const run = (): ConsoleArgs => ({ kind: "run" });
const refused = (command: string, why: string, synopsis: string): ConsoleArgs => ({ kind: "refused", command, why, synopsis });

// No positional arguments. A word that starts with "-" is an option the command does not have; anything else is just extra.
function noArguments(command: string, synopsis: string, args: readonly string[]): ConsoleArgs {
  const first = args[0];
  if (first === undefined) return run();
  const why = first.startsWith("-") ? `unknown option "${first}".` : `takes no arguments, got "${first}".`;
  return refused(command, why, synopsis);
}

function bare(command: string, blurb: string, args: readonly string[]): ConsoleArgs {
  const synopsis = `usage: morndo ${command}`;
  if (asksForHelp(args)) return { kind: "help", usage: `${synopsis}\n${blurb}` };
  return noArguments(command, synopsis, args);
}

// Exactly one id. `--help` is already decided. An option is refused before a count, so `revoke d1 --bogus` names the option.
function oneId(command: string, synopsis: string, args: readonly string[], noun: "device id" | "id"): ConsoleArgs {
  if (args.length === 0) return refused(command, noun === "device id" ? "needs a device id." : "needs an id.", synopsis);
  const option = args.find(a => a.startsWith("-"));
  if (option !== undefined) return refused(command, `unknown option "${option}".`, synopsis);
  if (args.length > 1) return refused(command, `expected one ${noun}, got ${args.length} arguments.`, synopsis);
  return run();
}

// The name, `--role` and any number of `--scope` (U15: the closed list's words, as main.ts reads them) may come in any
// order. A word that starts with "-" is never a name.
function agentNew(args: readonly string[]): ConsoleArgs {
  let role: string | undefined;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--role") {
      if (role !== undefined) return refused("agent-token", `unknown option "--role".`, AGENT_SYNOPSIS);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) { role = value; i++; }
      continue;
    }
    if (a === "--scope") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return refused("agent-token", `--scope needs one of: ${AGENT_SCOPES.join(", ")}.`, AGENT_SYNOPSIS);
      if (!(AGENT_SCOPES as readonly string[]).includes(value)) return refused("agent-token", `unknown scope "${value}"; the scopes are: ${AGENT_SCOPES.join(", ")}.`, AGENT_SYNOPSIS);
      i++;
      continue;
    }
    if (a.startsWith("-")) return refused("agent-token", `unknown option "${a}".`, AGENT_SYNOPSIS);
    names.push(a);
  }
  if (role !== "manager" && role !== "worker") return refused("agent-token", "needs --role manager or --role worker.", AGENT_SYNOPSIS);
  if (names.length === 0) return refused("agent-token", "needs a name.", AGENT_SYNOPSIS);
  if (names.length !== 1) return refused("agent-token", `expected one name, got ${names.length}.`, AGENT_SYNOPSIS);
  return run();
}

function agentToken(args: readonly string[]): ConsoleArgs {
  // `--help` wins wherever it sits, so `new --help` is usage and not a missing role.
  if (asksForHelp(args)) return { kind: "help", usage: AGENT_USAGE };
  const [sub, ...rest] = args;
  if (sub === undefined) return refused("agent-token", "needs new, list or revoke.", AGENT_SYNOPSIS);
  if (sub.startsWith("-")) return refused("agent-token", `unknown option "${sub}".`, AGENT_SYNOPSIS);
  if (sub === "new") return agentNew(rest);
  if (sub === "list") return noArguments("agent-token", AGENT_SYNOPSIS, rest);
  if (sub === "revoke") return oneId("agent-token", AGENT_SYNOPSIS, rest, "id");
  return refused("agent-token", `unknown command "${sub}".`, AGENT_SYNOPSIS);
}

// `argv` is `process.argv.slice(2)`: the command, then its arguments. No command is `serve`.
export function parseConsoleArgs(argv: string[]): ConsoleArgs {
  const [command = "serve", ...args] = argv;
  switch (command) {
    case "serve": return bare("serve", "Runs the hub.", args);
    case "pair": return bare("pair", "Shows a one-time QR code to pair a device.", args);
    case "devices": return bare("devices", "Lists paired devices.", args);
    case "revoke": {
      const synopsis = "usage: morndo revoke <device id>";
      if (asksForHelp(args)) return { kind: "help", usage: synopsis };
      return oneId("revoke", synopsis, args, "device id");
    }
    case "agent-token": return agentToken(args);
    default: return run();
  }
}
