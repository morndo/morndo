// Where the node agent keeps its files (spec §5.5, §6). Configuration lives under ~/.config/morndo-node: config.json
// (written by `morndo-node join`), policy.json (the owner's to edit), the node's private key and board-token (the token the
// reply style ask reads the hub's board with: a file only its owner can read, never an environment variable). State lives under
// ~/.local/state/morndo-node: the database, the hook relay's file copies, the upload inbox, the job socket, Memory's
// skills as memory.sync staged and committed them (memory/, ADR-0031: what the hub sends again, so state rather than
// data, beside the node's other files and under the same deny root), copies of the drafts the deliverer stashed (drafts/,
// #64), the status the running agent reports, and the fleet view it keeps for the node's updater to follow
// (updates §6.7). Every path derives from one home directory, so a test runs the whole agent in a temporary one.
import { join } from "node:path";

export type AgentPaths = {
  configDir: string; configFile: string; policyFile: string; keyPath: string; boardTokenFile: string;
  stateDir: string; dbPath: string; statusFile: string; relayFilesDir: string; inboxDir: string; jobSock: string; memoryDir: string; draftsDir: string;
  fleetViewFile: string;
};

export function agentPaths(home: string): AgentPaths {
  const configDir = join(home, ".config", "morndo-node");
  const stateDir = join(home, ".local", "state", "morndo-node");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    policyFile: join(configDir, "policy.json"),
    keyPath: join(configDir, "node-key.pem"),
    boardTokenFile: join(configDir, "board-token"),
    stateDir,
    dbPath: join(stateDir, "agent.db"),
    statusFile: join(stateDir, "status.json"),
    relayFilesDir: join(stateDir, "relay-files"),
    inboxDir: join(stateDir, "inbox"),
    jobSock: join(stateDir, "job.sock"),
    memoryDir: join(stateDir, "memory"),
    draftsDir: join(stateDir, "drafts"),
    fleetViewFile: join(stateDir, "fleet-view.json"),
  };
}
