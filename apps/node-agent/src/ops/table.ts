// Every op of the protocol (plan Contracts: OpName), wired to this node's tmux, Claude Code files, disk and database.
// Fleet clients:
// - lane.deliver and delivery.cancel go to the deliverer;
// - pane.capture and pane.keys by name use the policy's tmux server;
// - lane.start and lane.stop use the policy's launcher and protected names; they type /exit through the executor, and
//   queue a first prompt with the deliverer.
// The deliverer and the executor are made from this table, so it reaches them late (runtime.ts), by the time an op runs.
import { join } from "node:path";
import type Database from "better-sqlite3";
import { paneLock, stampServer, terminalAdapter, type PaneLock, type SessionSource, type Tmux } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { Deliverer, PaneView } from "../deliveries/deliverer.ts";
import type { AgentPaths } from "../paths.ts";
import { deliveryOps } from "./delivery-ops.ts";
import type { DoneKeys } from "./done-keys.ts";
import { ok, read, type OpTable, type Reply, type Request } from "./executor.ts";
import { fileOps } from "./file-ops.ts";
import type { Inventory } from "./inventory.ts";
import { laneOps, type LaneWaits } from "./lane-ops.ts";
import { nodeOpener, relayRef } from "./node-files.ts";
import { paneOps, type GuardInput } from "./pane-ops.ts";
import { transcriptOps } from "./transcript-ops.ts";
import type { UploadInbox } from "./upload-inbox.ts";
import { worktreeOps } from "./worktree-ops.ts";

export type OpsDeps = {
  config: AgentConfig;
  paths: AgentPaths;
  db: Database.Database;
  doneKeys: DoneKeys;
  inventory: Inventory;
  inbox: UploadInbox;
  registry: SessionSource;
  now: () => number;
  guard?: (g: GuardInput) => boolean;
  lock?: (path: string, waitS: number) => PaneLock;
  tmux: Tmux;                                              // the policy's tmux server
  panes: PaneView;                                         // the deliverer's view (lane.deliver reads it first)
  deliverer: () => Deliverer;                              // late: made from the executor this table goes into
  send: (req: Request) => Promise<Reply>;                  // late: that executor (lane.stop's /exit and its answer)
  laneWaits?: Partial<LaneWaits>;
};

export function claudeDir(home: string): string { return join(home, ".claude"); }
// Where the engine layer's lanes record themselves: its own variable (lane.py ENGINES_SESSIONS), else its default.
export function enginesSessionsDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.ENGINES_SESSIONS || join(home, ".local", "share", "engines", "sessions");
}

export function buildOps(d: OpsDeps): OpTable {
  const { config, paths } = d;
  const policy = config.policy;
  return {
    "inventory.get": read(async () => {
      const s = await d.inventory.refresh();
      return ok<"inventory.get">({ panes: s.panes, invVersion: s.invVersion });
    }),
    "op.status": read(async a => ok<"op.status">(d.doneKeys.status(a.key))),
    ...paneOps({
      node: config.node, policy, inventory: d.inventory, tmux: d.tmux,
      terminal: terminalAdapter({ socket: policy.tmuxSocket }),
      sessions: () => d.registry.byPane(),
      lock: d.lock ?? ((path, waitS) => paneLock(path, waitS)),
      now: d.now,
      ...(d.guard ? { guard: d.guard } : {}),
    }),
    ...transcriptOps({ transcriptPath: sid => d.registry.transcriptPath(sid) }),
    ...fileOps({
      open: nodeOpener({ home: config.home, stateDir: paths.stateDir, configDir: paths.configDir, inboxDir: paths.inboxDir, ...(policy.fileRoots ? { fileRoots: policy.fileRoots } : {}) }),
      relayRef: relayRef(d.db),
      inbox: d.inbox,
    }),
    ...laneOps({
      node: config.node, policy, inventory: d.inventory, home: config.home, stateDir: paths.stateDir, stamp: stampServer,
      tmux: d.tmux, send: d.send, deliver: a => d.deliverer().enqueue(a),
      ...(d.laneWaits ? { waits: d.laneWaits } : {}),
    }),
    ...worktreeOps({ repoRoots: policy.repoRoots, home: config.home, stateDir: paths.stateDir }),
    ...deliveryOps({ deliverer: d.deliverer, panes: d.panes, policy }),
  };
}
