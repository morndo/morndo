// The op side of the agent, assembled: inventory, done keys, upload inbox, session registry and the executor over
// every op, and the wall clock the node reports. agent.ts runs it behind the fleet connection; the tests drive the
// executor directly. Test hooks act here (test-hooks.ts): noDoneKeys, noExpect, clockOffsetMs, and for the delivery
// drills killAfterEffect (the executor's afterEffect), noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs.
// Fleet clients (spec §4, §5):
// - the delivery queue: its store in agent.db, and the deliverer typing through this executor;
// - the policy's tmux server, for the deliverer's box checks, pane.capture, pane.keys by name and the launcher;
// - the deliverer's view of the lanes, with each pane process's start for the 2-minute grace (RECONCILIATION.md ruling 14);
// - each session's topic and last prompt, for the inventory (ruling 13).
// The ops and the deliverer need each other: lane.deliver and lane.start enqueue, and the deliverer and lane.stop type
// through the executor. So the table reaches both late, through closures over the two made just below it, by the time an
// op runs.
import type Database from "better-sqlite3";
import { combineSessions, engineSessionRegistry, sessionRegistry, stampServer, tmuxAdapter, type PaneLock, type PanePids, type SessionSource, type Tmux } from "@morndo/node-ops";
import type { Delivery } from "@morndo/protocol";
import type { Flight } from "@morndo/service-kit";
import type { AgentConfig } from "../config.ts";
import { Deliverer, type PaneView } from "../deliveries/deliverer.ts";
import { DeliveryStore } from "../deliveries/store.ts";
import { agentPaneView, agentTranscripts } from "../deliveries/views.ts";
import type { Logger } from "../log.ts";
import { agentPaths } from "../paths.ts";
import { killOnce, wallClock, type TestHooks } from "../test-hooks.ts";
import { DoneKeys } from "./done-keys.ts";
import { OpExecutor } from "./executor.ts";
import { Inventory } from "./inventory.ts";
import type { LaneWaits } from "./lane-ops.ts";
import type { GuardInput } from "./pane-ops.ts";
import { jobOps, type JobControl } from "./job-ops.ts";
import { buildOps, claudeDir, enginesSessionsDir, enginesTranscriptsDir } from "./table.ts";
import { panePidsOf } from "./tmux-panes.ts";
import { TranscriptTitles } from "./transcript-titles.ts";
import { UploadInbox } from "./upload-inbox.ts";

export type OpsRuntime = {
  inventory: Inventory;
  doneKeys: DoneKeys;
  inbox: UploadInbox;
  registry: SessionSource;
  executor: OpExecutor;
  now: () => number;                                      // the wall clock the node reports (clockOffsetMs included)
  tmux: Tmux;                                             // the policy's tmux server
  deliveries: DeliveryStore;
  deliverer: Deliverer;
  panes: PaneView;                                        // the deliverer's view of the lanes
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
  held?: () => boolean;
  flight?: Flight;
  emitDelivery?: (d: Delivery) => void;                   // each change of a delivery (agent.ts: ev.delivery)
  laneWaits?: Partial<LaneWaits>;                         // a test's shorter lane.start and lane.stop waits
};

const acceptAny = () => true;

export function createOpsRuntime(o: RuntimeOptions): OpsRuntime {
  const { config } = o;
  const hooks = o.hooks ?? {};
  const now = wallClock(hooks);
  const paths = agentPaths(config.home);
  // Claude Code's sessions, and the engine layer's lanes in the panes Claude Code holds none of (ADR-0030). An engine lane is
  // found inside its pane, so the registry reads the panes' process ids as the inventory last listed them.
  const panePids = (): PanePids => panePidsOf(inventory.last().rows);
  const engines = engineSessionRegistry(enginesSessionsDir(config.home), { transcripts: enginesTranscriptsDir(config.home) });
  const registry = combineSessions(sessionRegistry(claudeDir(config.home)), engines, panePids);
  // topic and lastPrompt (RECONCILIATION.md ruling 13): each session's transcript, found through the same registry.
  const titles = new TranscriptTitles(sessionId => registry.transcriptPath(sessionId));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: panes => registry.byPane(panes), stamp: stampServer, titles: sessionId => titles.read(sessionId),
  });
  const doneKeys = new DoneKeys(o.db, Date.now, { disabled: hooks.noDoneKeys === true });
  const inbox = new UploadInbox({ dir: paths.inboxDir, ...(o.room ? { room: o.room } : {}) });
  const guard = o.guard ?? (hooks.noExpect ? acceptAny : undefined);
  const tmux = tmuxAdapter({ socket: config.policy.tmuxSocket, session: config.policy.session });
  const deliveries = new DeliveryStore(o.db, now, config.node);
  const panes = agentPaneView({ inventory, tmux });
  const ops = buildOps({
    config, paths, db: o.db, doneKeys, inventory, inbox, registry, now, tmux, panes,
    deliverer: () => deliverer, send: req => executor.handle(req),
    ...(guard ? { guard } : {}), ...(o.lock ? { lock: o.lock } : {}), ...(o.laneWaits ? { laneWaits: o.laneWaits } : {}),
  });
  const executor = new OpExecutor({
    ops, allowed: new Set(config.policy.ops), doneKeys, invVersion: () => inventory.invVersion, log: o.log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
    ...(o.held ? { held: o.held } : {}),
    ...(o.flight ? { flight: o.flight } : {}),
    ...(hooks.killAfterEffect !== undefined ? { afterEffect: killOnce(hooks.killAfterEffect) } : {}),
  });
  const deliverer = new Deliverer({
    store: deliveries, executor, panes, transcripts: agentTranscripts(sessionId => registry.transcriptPath(sessionId)),
    now, emit: o.emitDelivery ?? (() => {}), log: o.log, hooks,
  });
  return {
    inventory, doneKeys, inbox, registry, executor, now, tmux, deliveries, deliverer, panes,
    bindJobs: control => { Object.assign(ops, jobOps(control)); },
  };
}
