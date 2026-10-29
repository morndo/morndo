// What the running agent reports about itself, for `morndo-node status` (spec §5.2: a refused second instance shows the
// conflict in status, and tries again every 5 minutes) and for an updater's node probe (updates design §6.3). The agent
// rewrites ~/.local/state/morndo-node/status.json atomically on every connection change, with every health tick and the
// moment its in-flight work changes; `status` reads it and checks that the writer still lives.
import { readFileSync } from "node:fs";
import { processAlive } from "@morndo/node-ops";
import type { InFlight } from "@morndo/service-kit";
import { writeFileAtomicAsync } from "../atomic-write.ts";

export type ConnState = "stopped" | "connecting" | "online" | "backoff" | "refused" | "conflict" | "unsupported";
export type ConnStatus = {
  state: ConnState;
  since: number;                                         // wall clock, for people
  connEpoch: number | null;
  lastClose: { code: number; reason: string } | null;
  retryInMs: number | null;
};
export type AgentStatus = ConnStatus & {
  node: string; instanceId: string; pid: number; spoolDepth: number; drops: number; jobs?: string;
  version?: string; ready?: boolean; held?: boolean;
  inFlight: InFlight[];                                  // work a restart would interrupt (updates design §6.3)
};

// Async: its fsync runs off the event loop (T-532), so the agent's only thread is never held in it. The caller owns
// the failure (the promise rejects; the agent logs it), so a failing disk cannot disturb the change that caused the write.
export function writeStatus(path: string, s: AgentStatus): Promise<void> {
  return writeFileAtomicAsync(path, `${JSON.stringify(s)}\n`, 0o600);
}

export function readStatus(path: string): AgentStatus | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as AgentStatus; }
  catch { return null; }
}

const STATE_TEXT: Record<ConnState, string> = {
  stopped: "stopped",
  connecting: "connecting to the fleet",
  online: "online",
  backoff: "disconnected; dialing again with backoff",
  refused: "refused by the fleet (revoked, unknown, or a key the fleet doesn't accept). It no longer dials: join again with a new code",
  conflict: "conflict: another agent with this node's key is connected (4409). This one tries again every 5 minutes, and takes over once the other is gone: stop the other agent (a cloned machine?)",
  unsupported: "the fleet does not speak this agent's protocol (4426); retrying hourly: update morndo-node or the fleet",
};

export function formatStatus(config: { node: string; fleetUrl: string }, s: AgentStatus | null, isAlive: (pid: number) => boolean = processAlive): string {
  const lines = [`node      ${config.node}`, `fleet     ${config.fleetUrl}`];
  if (!s || !isAlive(s.pid)) {
    lines.push("agent     not running (start it with: morndo-node run)");
    return lines.join("\n");
  }
  const since = new Date(s.since).toLocaleString();
  lines.push(`state     ${STATE_TEXT[s.state]} (since ${since})`);
  if (s.connEpoch !== null && s.state === "online") lines.push(`epoch     ${s.connEpoch}`);
  if (s.lastClose) lines.push(`closed    ${s.lastClose.code}${s.lastClose.reason ? ` ${s.lastClose.reason}` : ""}`);
  if (s.retryInMs !== null) lines.push(`retry in  ${Math.ceil(s.retryInMs / 1000)} s`);
  lines.push(`instance  ${s.instanceId} (pid ${s.pid})`);
  lines.push(`spool     ${s.spoolDepth} events waiting, ${s.drops} dropped`);
  if (s.jobs) lines.push(`jobs      ${s.jobs}`);
  return lines.join("\n");
}
