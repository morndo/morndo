// A whole agent on a temporary HOME: joined to a scripted fake fleet (through `join`, as an owner would), its relay on
// a random port, its tmux an isolated server, with short intervals so the tests run fast.
import { join as joinPath } from "node:path";
import type { Flight } from "@morndo/service-kit";
import { startAgent, type RunningAgent } from "../src/agent.ts";
import type { RetryOptions } from "../src/conn/retry.ts";
import { loadConfig, type AgentConfig } from "../src/config.ts";
import { join } from "../src/join.ts";
import { writeFileAtomic } from "../src/atomic-write.ts";
import { agentPaths } from "../src/paths.ts";
import type { CommandRunner } from "../src/ops/update-ops.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import type { FakeFleet } from "./fake-fleet.ts";
import { captureLog } from "./helpers.ts";

export async function joinedConfig(home: string, fleet: FakeFleet, socket: string, hub?: string): Promise<AgentConfig> {
  await join({ home, joinString: fleet.joinString("pc") });
  const paths = agentPaths(home);
  const stored = loadConfig(home);
  writeFileAtomic(paths.configFile, JSON.stringify({ node: stored.node, fleetUrl: stored.fleetUrl, fleetKey: stored.fleetKey, keyPath: stored.keyPath, dbPath: stored.dbPath, relayPort: 0, ...(hub ? { hub } : {}) }));
  writeFileAtomic(paths.policyFile, JSON.stringify({ tmuxSocket: socket }));
  return loadConfig(home);
}

export async function runAgent(config: AgentConfig, o: { pollMs?: number; healthMs?: number; instanceId?: string; hooks?: TestHooks; diskBudgetBytes?: number; retry?: RetryOptions; flight?: Flight; stopWaitMs?: number; runCommand?: CommandRunner; walSync?: () => Promise<void>; walSyncTimeoutMs?: number; replayRetryMs?: number } = {}) {
  const logged = captureLog();
  const agent: RunningAgent = await startAgent({
    config, log: logged.log, retry: o.retry ?? { baseMs: 20, capMs: 100 }, pollMs: o.pollMs ?? 100, healthMs: o.healthMs ?? 200, statusMs: 100,
    ...(o.instanceId ? { instanceId: o.instanceId } : {}),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.diskBudgetBytes !== undefined ? { diskBudgetBytes: o.diskBudgetBytes } : {}),
    ...(o.flight ? { flight: o.flight } : {}),
    ...(o.stopWaitMs !== undefined ? { stopWaitMs: o.stopWaitMs } : {}),
    ...(o.runCommand ? { runCommand: o.runCommand } : {}),
    ...(o.walSync ? { walSync: o.walSync } : {}),
    ...(o.walSyncTimeoutMs !== undefined ? { walSyncTimeoutMs: o.walSyncTimeoutMs } : {}),
    ...(o.replayRetryMs !== undefined ? { replayRetryMs: o.replayRetryMs } : {}),
  });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${agent.relayPort}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { agent, post, lines: logged.lines };
}

export const dbFiles = (config: AgentConfig) => [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, joinPath(config.dbPath, "..", "status.json")];
