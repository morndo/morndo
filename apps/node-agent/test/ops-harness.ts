// The agent's op side on a temporary HOME and an isolated tmux server, driven through the executor as the fleet would
// drive it, without a connection. Its deliverer runs a round for each new delivery and when a test kicks it (start()
// adds the 5 s timer); close() stops it. A test that leaves rounds running awaits deliverer.drain() before close().
// laneWaits shortens lane.start's and lane.stop's waits (the shell's prompt, the trust dialog, the lane's end).
import type { PaneLock } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import { DEFAULT_POLICY, type AgentConfig, type Policy } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import type { Reply } from "../src/ops/executor.ts";
import type { LaneWaits } from "../src/ops/lane-ops.ts";
import type { GuardInput } from "../src/ops/pane-ops.ts";
import { createOpsRuntime, type OpsRuntime } from "../src/ops/runtime.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import { captureLog } from "./helpers.ts";

export type Harness = OpsRuntime & {
  config: AgentConfig;
  paths: AgentPaths;
  adb: AgentDb;
  call(op: string, args: unknown, o?: { key?: string; timeoutMs?: number }): Promise<Reply>;
  close(): void;
};

export function opsHarness(o: { home: string; socket: string; node?: string; policy?: Partial<Policy>; guard?: (g: GuardInput) => boolean; hooks?: TestHooks;
  lock?: (path: string, waitS: number) => PaneLock; room?: () => number; emitDelivery?: (d: Delivery) => void; laneWaits?: Partial<LaneWaits> }): Harness {
  const paths = agentPaths(o.home);
  const config: AgentConfig = {
    node: o.node ?? "pc", fleetUrl: "ws://127.0.0.1:9/agent", fleetKey: "AA==", keyPath: paths.keyPath, dbPath: paths.dbPath,
    relayPort: 0, home: o.home, policy: { ...DEFAULT_POLICY, tmuxSocket: o.socket, ...o.policy },
  };
  const adb = openAgentDb(paths.dbPath);
  const runtime = createOpsRuntime({
    config, db: adb.db, log: captureLog().log, ...(o.guard ? { guard: o.guard } : {}), ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.lock ? { lock: o.lock } : {}), ...(o.room ? { room: o.room } : {}), ...(o.emitDelivery ? { emitDelivery: o.emitDelivery } : {}),
    ...(o.laneWaits ? { laneWaits: o.laneWaits } : {}),
  });
  let n = 0;
  return {
    ...runtime, config, paths, adb,
    call: (op, args, c = {}) => runtime.executor.handle({ id: `r${++n}`, op, args, timeoutMs: c.timeoutMs ?? 10_000, ...(c.key !== undefined ? { key: c.key } : {}) }),
    close: () => { runtime.deliverer.stop(); adb.close(); },
  };
}
