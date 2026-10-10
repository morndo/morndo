// Where the node agent keeps its files (spec §5.5, §6). Configuration lives under ~/.config/morndo-node: config.json
// (written by `morndo-node join`), policy.json (the owner's to edit) and the node's private key. State lives under
// ~/.local/state/morndo-node: the database, the hook relay's file copies, the upload inbox, the job socket, and the
// status the running agent reports. Every path derives from one home directory, so a test runs the whole agent in a temporary one.
import { join } from "node:path";

export type AgentPaths = {
  configDir: string; configFile: string; policyFile: string; keyPath: string;
  stateDir: string; dbPath: string; statusFile: string; relayFilesDir: string; inboxDir: string; jobSock: string;
};

export function agentPaths(home: string): AgentPaths {
  const configDir = join(home, ".config", "morndo-node");
  const stateDir = join(home, ".local", "state", "morndo-node");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    policyFile: join(configDir, "policy.json"),
    keyPath: join(configDir, "node-key.pem"),
    stateDir,
    dbPath: join(stateDir, "agent.db"),
    statusFile: join(stateDir, "status.json"),
    relayFilesDir: join(stateDir, "relay-files"),
    inboxDir: join(stateDir, "inbox"),
    jobSock: join(stateDir, "job.sock"),
  };
}
