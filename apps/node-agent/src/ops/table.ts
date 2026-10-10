// Every op of the protocol (plan Contracts: OpName), wired to this node's tmux, Claude Code files, disk and database.
import { join } from "node:path";
import type Database from "better-sqlite3";
import { paneLock, sessionRegistry, stampServer, terminalAdapter, tmuxAdapter, type PaneLock } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { AgentPaths } from "../paths.ts";
import type { DoneKeys } from "./done-keys.ts";
import { ok, read, type OpTable } from "./executor.ts";
import { fileOps } from "./file-ops.ts";
import type { Inventory } from "./inventory.ts";
import { laneOps } from "./lane-ops.ts";
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
  registry: ReturnType<typeof sessionRegistry>;
  now: () => number;
  guard?: (g: GuardInput) => boolean;
  lock?: (path: string, waitS: number) => PaneLock;
};

export function claudeDir(home: string): string { return join(home, ".claude"); }

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
      node: config.node, policy, inventory: d.inventory,
      tmux: tmuxAdapter({ socket: policy.tmuxSocket, session: policy.session }),
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
    ...laneOps({ node: config.node, policy, inventory: d.inventory, home: config.home, stateDir: paths.stateDir, stamp: stampServer }),
    ...worktreeOps({ repoRoots: policy.repoRoots, home: config.home, stateDir: paths.stateDir }),
  };
}
