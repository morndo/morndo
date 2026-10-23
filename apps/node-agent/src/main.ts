#!/usr/bin/env node
// morndo-node: this machine's agent in a Morndo fleet (ADR-0012). `join` once, with the string the fleet printed;
// `run` under the service manager; `status` for a person at the machine.
import { homedir, userInfo } from "node:os";
import { startAgent, type RunningAgent } from "./agent.ts";
import { ConfigError, loadConfig, type AgentConfig } from "./config.ts";
import { formatStatus, readStatus } from "./conn/status-file.ts";
import { exitOnCrash } from "./crash.ts";
import { DatabaseFromFuture } from "./db/migrations.ts";
import { DatabaseUnreadable } from "./db/open.ts";
import { NotLocalDisk, buildLabel } from "@morndo/service-kit";
import { hostTmuxServer } from "@morndo/node-ops";
import { JoinError, join } from "./join.ts";
import { log } from "./log.ts";
import { agentPaths } from "./paths.ts";
import { dropAgentTokenEnv } from "./relay/board-token.ts";
import { TestHooksRefused, loadTestHooks, type TestHooks } from "./test-hooks.ts";

const HELP = `morndo-node: this machine's agent in a Morndo fleet.

  morndo-node join '<join string>'   join the fleet once, with the string \`morndo-fleet node add <name>\` printed
  morndo-node run                    run the agent: the connection to the fleet, the ops, the hook relay
  morndo-node status                 what the running agent reports

Files: ~/.config/morndo-node/ (config.json, policy.json, node-key.pem) and ~/.local/state/morndo-node/ (agent.db,
relay-files/, inbox/, status.json). MORNDO_NODE_LOG_LEVEL sets the log level (default info).`;

const EXIT_CONFIG = 78;                     // EX_CONFIG (sysexits.h): the setup needs fixing, a restart won't help
exitOnCrash(log);
const home = process.env.HOME || homedir();
const [cmd = "help", ...args] = process.argv.slice(2);
// The commands' own output, for the person at the machine: not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);

function configOrExit(): AgentConfig {
  try { return loadConfig(home); }
  catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CONFIG);
  }
}

// The account's own home directory, from the password database rather than $HOME (os.userInfo(), test-hooks.ts); ""
// when the account has none.
function accountHome(): string {
  try { return userInfo().homedir; } catch { return ""; }
}

// tmux writes UTF-8 only under a UTF-8 locale (tmux(1), -u). Every tmux call passes -u (node-ops' tmuxArgv), but a tmux
// server that lane.start launches, and the lanes in it, inherit this environment: a service started without a locale
// gets C.UTF-8.
function ensureUtf8Locale() {
  const first = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  if (/utf-?8/i.test(first)) return;
  if (process.env.LC_ALL) log.warn("LC_ALL is set to a locale without UTF-8; tmux output may lose characters");
  else process.env.LC_CTYPE = "C.UTF-8";
}

if (cmd === "--version") {
  print(buildLabel());
  process.exit(0);
}

switch (cmd) {
  case "join": {
    if (args.length !== 1) { process.stderr.write("usage: morndo-node join '<join string>'\n"); process.exit(2); }
    try {
      const joined = await join({ home, joinString: args[0] ?? "" });
      print(`Joined the fleet at ${joined.fleetUrl} as ${joined.node}. Start the agent with: morndo-node run`);
    } catch (e) {
      if (!(e instanceof JoinError)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    break;
  }
  case "run": {
    // First, before tmux is hosted or any lane started: a MORNDO_AGENT_TOKEN in this environment would be inherited by the
    // tmux server and every lane (board-token.ts). The board token is read from its file.
    if (dropAgentTokenEnv()) log.warn(`MORNDO_AGENT_TOKEN was set in the node's environment and is removed from it at start, before tmux and the lanes: the board token is read from ${agentPaths(home).boardTokenFile} (mode 600)`);
    // Test hooks before anything else: with MORNDO_NODE_TEST_HOOKS set outside a test, the agent refuses to start.
    let hooks: TestHooks;
    try { hooks = loadTestHooks(process.env, { home, accountHome: accountHome() }); }
    catch (e) {
      if (!(e instanceof TestHooksRefused)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(EXIT_CONFIG);
    }
    if (Object.keys(hooks).length) log.warn(`test hooks are on (${Object.keys(hooks).join(", ")}): this agent is for tests only`);
    ensureUtf8Locale();
    const config = configOrExit();
    try {
      const hosted = await hostTmuxServer({ socket: config.policy.tmuxSocket });
      log.info(`tmux server: ${hosted}`);
    } catch (e) { log.error("could not start the tmux server outside this service", e); }
    let agent: RunningAgent;
    try { agent = await startAgent({ config, log, hooks }); }
    catch (e) {
      if (e instanceof ConfigError || e instanceof DatabaseUnreadable || e instanceof NotLocalDisk) {
        log.error(e.message);
        process.exit(EXIT_CONFIG);
      }
      if (e instanceof DatabaseFromFuture) {
        log.error(`${config.dbPath} was written by a newer morndo-node (schema version ${e.found}); this one knows up to ${e.known}. Run the newer agent, or restore a backup.`);
        process.exit(EXIT_CONFIG);
      }
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log.error(`the hook relay's port 127.0.0.1:${config.relayPort} is taken (another relay?); set relayPort in ${agentPaths(home).configFile}`);
        process.exit(EXIT_CONFIG);
      }
      throw e;
    }
    log.info(`morndo-node ${config.node}: hook relay on 127.0.0.1:${agent.relayPort}, dialing ${config.fleetUrl} as instance ${agent.instanceId}`);
    const stop = async () => { await agent.stop(); process.exit(0); };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    break;
  }
  case "status": {
    const config = configOrExit();
    print(formatStatus(config, readStatus(agentPaths(home).statusFile)));
    break;
  }
  default:
    print(HELP);
}
