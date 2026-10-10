// The op side of the agent, assembled: inventory, done keys, upload inbox, session registry and the executor over
// every op, and the wall clock the node reports. agent.ts runs it behind the fleet connection; the tests drive the
// executor directly. Three test hooks act here (test-hooks.ts): noDoneKeys, noExpect and clockOffsetMs.
import type Database from "better-sqlite3";
import { sessionRegistry, stampServer, type PaneLock } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { agentPaths } from "../paths.ts";
import { wallClock, type TestHooks } from "../test-hooks.ts";
import { DoneKeys } from "./done-keys.ts";
import { OpExecutor } from "./executor.ts";
import { Inventory } from "./inventory.ts";
import type { GuardInput } from "./pane-ops.ts";
import { jobOps, type JobControl } from "./job-ops.ts";
import { buildOps, claudeDir } from "./table.ts";
import { UploadInbox } from "./upload-inbox.ts";

export type OpsRuntime = {
  inventory: Inventory;
  doneKeys: DoneKeys;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  executor: OpExecutor;
  now: () => number;                                      // the wall clock the node reports (clockOffsetMs included)
  bindJobs(control: JobControl): void;
};

export type RuntimeOptions = {
  config: AgentConfig;
  db: Database.Database;
  log: Logger;
  guard?: (g: GuardInput) => boolean;                     // a test replaces the expectation check to show what it prevents
  hooks?: TestHooks;
  afterStarted?: (key: string) => boolean;                // the executor's hook after a committed `started` (agent.ts)
  lock?: (path: string, waitS: number) => PaneLock;       // a test's slow lock; node-ops' paneLock otherwise
  room?: () => number;                                    // bytes still free in the node's disk budget (agent.ts)
};

const acceptAny = () => true;

export function createOpsRuntime(o: RuntimeOptions): OpsRuntime {
  const { config } = o;
  const hooks = o.hooks ?? {};
  const now = wallClock(hooks);
  const paths = agentPaths(config.home);
  const registry = sessionRegistry(claudeDir(config.home));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer,
  });
  const doneKeys = new DoneKeys(o.db, Date.now, { disabled: hooks.noDoneKeys === true });
  const inbox = new UploadInbox({ dir: paths.inboxDir, ...(o.room ? { room: o.room } : {}) });
  const guard = o.guard ?? (hooks.noExpect ? acceptAny : undefined);
  const ops = buildOps({ config, paths, db: o.db, doneKeys, inventory, inbox, registry, now, ...(guard ? { guard } : {}), ...(o.lock ? { lock: o.lock } : {}) });
  const executor = new OpExecutor({
    ops, allowed: new Set(config.policy.ops), doneKeys, invVersion: () => inventory.invVersion, log: o.log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
  });
  return {
    inventory, doneKeys, inbox, registry, executor, now,
    bindJobs: control => { Object.assign(ops, jobOps(control)); },
  };
}
