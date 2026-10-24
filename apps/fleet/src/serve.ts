// The fleet service, wired (ADR-0012): its key, fleet.db, the node registry, the audit, the live connections, the
// lane registry and router, the hook bus, the agent endpoint, the client API, and each lane's Run (ADR-0032). A second
// socket, fleet-worker.sock, serves that API to a caller that reaches the fleet through a forward, on the worker scope.
// `morndo-fleet serve` runs it; tests
// start it on port 0 with temporary paths. The socket directory is checked first, so an unsafe one stops the service
// before it opens anything. Every alert the audit records is also an `alert` event. Audit rows older than 90 days go on start
// and daily. A revoked node's lanes go whichever way it was revoked (the client API, or the console writing fleet.db).
import type Database from "better-sqlite3";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_SOAK_MINUTES } from "@morndo/domain";
import type { Delivery, Health, Pane } from "@morndo/protocol";
import { Flight, HoldWatch, RevocationJournal, assertLocalDisk, holdFile, productBuild } from "@morndo/service-kit";
import { workerSocketOf, type FleetConfig } from "./config.ts";
import { Audit } from "./adapters/audit.ts";
import { startClientApi } from "./adapters/client-api.ts";
import { fleetTransactions, openFleetDb } from "./adapters/db.ts";
import { loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { LaneDeliveriesStore } from "./adapters/lane-deliveries-store.ts";
import { LaneEventsStore } from "./adapters/lane-events-store.ts";
import { LanesStore } from "./adapters/lanes-store.ts";
import { log as defaultLog, type Logger } from "./adapters/log.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import { OutboxStore } from "./adapters/outbox-store.ts";
import type { BucketConfig } from "./adapters/rate-limit.ts";
import { clearStaleSocket, prepareSocketDir } from "./adapters/socket-dir.ts";
import { StickyLanesStore } from "./adapters/sticky-lanes-store.ts";
import { StoreSeqsStore } from "./adapters/store-seqs.ts";
import { RolloutsStore } from "./adapters/rollouts-store.ts";
import { startAgentEndpoint } from "./adapters/agent-endpoint.ts";
import { Connections } from "./application/connections.ts";
import { Deliveries } from "./application/deliveries.ts";
import { JobMirror, NOTICE_RETRY_MS } from "./application/job-mirror.ts";
import { JobsStore } from "./adapters/jobs-store.ts";
import { DeliveryWorker, type Backoff, type Post } from "./application/delivery.ts";
import { EventHub } from "./application/events.ts";
import { HookIntake, unsubscribedScriptPaths } from "./application/hook-intake.ts";
import { IntakeWindow } from "./application/intake-window.ts";
import { LaneEvents, rulesOf } from "./application/lane-events.ts";
import { LaneEventsPush } from "./application/lane-events-push.ts";
import { LaneRegistry } from "./application/lane-registry.ts";
import { LaneWatch, REBUILD_WINDOW_MS } from "./application/lane-watch.ts";
import { CONTROL_PLANE_MACHINE, Rollouts } from "./application/rollouts.ts";
import type { RolloutAuthority } from "./adapters/client-api.ts";
import { decodePrincipalKey, hubFilePrincipalAuthority, hubIdentityPubFile, principalAuthority } from "./adapters/principal-check.ts";
import { UpdaterStateWatch, updaterStateFile } from "./adapters/updater-state-watch.ts";
import { applyRevocationJournal } from "./application/revocations.ts";
import { Router } from "./application/router.ts";
import { Runs } from "./application/runs.ts";

export const AUDIT_PRUNE_EVERY_MS = 86_400_000;

export type FleetOptions = {
  log?: Logger; now?: () => number; pingMs?: number; agentLimits?: BucketConfig; handshakeLimits?: BucketConfig; handshakeMs?: number;
  resultSlackMs?: number; instancePongMs?: number; eventsBufferBytes?: number; intakeWindowMs?: number;
  hookBacklog?: number; delivery?: { post?: Post; backoff?: Backoff; tickMs?: number; random?: () => number };
  holdPath?: string;
  // Who may commit a Rollout (the control plane's updater) and who may resume one or ask update.apply (the
  // principal, with step-up). Closed unless a check says yes (review of #107): the socket is the user's, and a lane
  // runs as that user too. An explicit authority here wins (the tests'); otherwise the config's pinned principalKey
  // (updates §5.4, PR 6c) opens the principal's two doors to the hub's signed assertion, and without a pin the
  // hub's own identity.pub does, read at each check (PR 6c round 2, R2). Neither is in the config file.
  rolloutAuthority?: RolloutAuthority;
  // Where the fleet reads the hub's public key when the config pins none (R2): the hub's identity.pub. Default the
  // hub's own data dir (MORNDO_HOME, else ~/.local/share/morndo), as the hub decides it.
  principalKeyFile?: string;
  // The control plane's own updater's state file (updates §7): its rollback halts the Rollout. Default under HOME.
  updaterStatePath?: string;
  laneWatchSweepMs?: number;
  runsSweepMs?: number;
};

export type Fleet = {
  config: FleetConfig; db: Database.Database; key: FleetKey; nodes: NodesStore; audit: Audit; events: EventHub;
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; intake: IntakeWindow;
  deliveries: Deliveries; laneEvents: LaneEvents; laneEventsPush: LaneEventsPush; laneWatch: LaneWatch; jobs: JobMirror; runs: Runs;
  rollouts: Rollouts; agentPort: number;
  close(): Promise<void>;
};

export async function startFleet(config: FleetConfig, o: FleetOptions = {}): Promise<Fleet> {
  const log = o.log ?? defaultLog;
  const now = o.now ?? Date.now;
  const worker = workerSocketOf(config);
  prepareSocketDir(config.socketPath);
  prepareSocketDir(worker.path);
  await clearStaleSocket(config.socketPath);        // a live service owns fleet.db: refuse before touching it
  await clearStaleSocket(worker.path);
  assertLocalDisk(dirname(config.dbPath));          // before the key file too, which lives beside it by default
  const key = loadOrCreateFleetKey(config.keyPath);
  const db = openFleetDb(config.dbPath);
  // RL10 (updates design §11.5): every revocation is journaled to revoked.log beside fleet.db before its database
  // write, and each start applies the journal again, before anything below reads the nodes — so a fleet.db restored
  // from an older copy (the updater's rollback) brings no revoked node back.
  const journal = new RevocationJournal(join(dirname(config.dbPath), "revoked.log"));
  const nodes = new NodesStore(db, now, journal);
  const events = new EventHub(e => log.error("an event subscriber failed", e));
  const audit = new Audit(db, { now, log, onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });
  // A line the journal cannot read is an Alert, never a refusal to start: the rest of the journal still applies.
  const reapplied = applyRevocationJournal(journal, nodes);
  if (reapplied.applied > 0) log.info(`re-applied ${reapplied.applied} revocations from revoked.log`);
  for (const b of reapplied.bad) audit.alert("journal_unreadable", null, { file: "revoked.log", line: b.line, why: b.why });
  if (journal.compact()) log.info("revoked.log compacted to one entry per revocation");
  // On start and daily; a busy or full fleet.db is logged and tried again the next day, never thrown out of the timer.
  const pruneAudit = () => {
    try { const n = audit.prune(); if (n > 0) log.info(`audit: removed ${n} rows older than 90 days`); }
    catch (e) { log.error("audit: removing rows older than 90 days failed (fleet.db busy or full?); trying again tomorrow", e); }
  };
  pruneAudit();
  const active = nodes.list().filter(n => n.revokedAt === null).map(n => n.name);
  const lanes = new LaneRegistry({ store: new LanesStore(db), events, audit, activeNodes: active, now });
  // The build this fleet runs (updates §7): the control plane's own Version, the only one it may commit and the
  // ceiling for every node's (RL11). The Rollouts service is made after the connections (it pushes to them); the
  // connections reach it through these closures, so the gate in Connections.request answers from the service.
  const build = productBuild();
  let rollouts!: Rollouts;
  const connections = new Connections({
    nodes, audit, events, log, now, onRevoked: node => lanes.dropNode(node), storeSeqs: new StoreSeqsStore(db, { now, log }),
    updatePolicy: { aboveOwn: v => rollouts.aboveOwn(v), halted: v => rollouts.halted(v), issue: (n, v) => rollouts.issueFor(n, v) },
    ...(o.pingMs === undefined ? {} : { pingMs: o.pingMs }),
    ...(o.resultSlackMs === undefined ? {} : { resultSlackMs: o.resultSlackMs }), ...(o.instancePongMs === undefined ? {} : { instancePongMs: o.instancePongMs }),
  });
  rollouts = new Rollouts({ store: new RolloutsStore(db, now), audit, events, push: connections, own: build, now });
  // A node's updater reports with its health (updates §6.3, §7): a rollback alerts and halts the Rollout of the
  // Version it was leaving (RL12).
  // The control plane's own rollback, from its updater's state file (review of #107): the internal path, the only
  // one besides a node's own health that halts without the principal. The state file is the control plane updater's
  // only word out (§4.5, PR 6b), so the same read carries its commit — a `current` record of the fleet's own running
  // Version, at the record's own moment and soak, so a re-read (a restart among them) changes nothing — and its skew
  // hold: a `waiting` record whose reason names the nodes RL11 held it for. Both beside the health path, which still
  // registers the `applying` attempt and halts a rollback under it.
  const updaterWatch = new UpdaterStateWatch({
    path: o.updaterStatePath ?? updaterStateFile(),
    onReport: r => {
      if (r.state === "current" && r.version === rollouts.controlPlane().version)
        rollouts.committed(r.version, r.soakMinutes ?? DEFAULT_SOAK_MINUTES, r.at);
      if (r.state === "waiting" && r.reason !== undefined && r.reason.startsWith("skew_blocked:")) {
        const nodes = r.reason.slice("skew_blocked:".length).split(",").map(s => s.trim()).filter(s => s !== "");
        rollouts.skewBlocked(r.target ?? r.version, nodes);
      }
      rollouts.health(CONTROL_PLANE_MACHINE, r, { own: true });
    },
  });
  updaterWatch.start();
  events.subscribe(e => {
    if (e.t === "health") {
      const update = (e.body as Health).update;
      if (update !== undefined) rollouts.health(e.node, update);
    }
  });
  const deliveries = new Deliveries({
    store: new LaneDeliveriesStore(db), sticky: new StickyLanesStore(db), stickyLanes: config.stickyLanes, lanes, connections, audit, events, log, now,
  });
  // Per node, the pane of each window that runs a session of the agent CLI now, by worker ID: the lane watch nudges only
  // those, at that pane. A window with two such panes is nudged at neither (null).
  const sessions = new Map<string, Map<string, string | null>>();
  events.subscribe(e => {
    if (e.t !== "inventory") return;
    const panes = (e.body as { panes: Pane[] }).panes;
    lanes.inventory(e.node, panes);
    deliveries.inventory(e.node, panes);
    const running = new Map<string, string | null>();
    for (const p of panes) if (p.sessionId !== undefined) running.set(p.window, running.has(p.window) ? null : p.workerId);
    sessions.set(e.node, running);
  });
  const laneEventsStore = new LaneEventsStore(db);
  const laneEventsPush = new LaneEventsPush({ store: laneEventsStore, deliveries, config: config.laneEvents, log });
  const laneEvents = new LaneEvents({
    store: laneEventsStore, events, config: config.laneEvents, log, now, onWaiting: () => laneEventsPush.kick(), waitMs: config.laneWatch.waitingMin * 60_000,
  });
  // Every lane's last turn and its deadline (reliable lanes §3.2): stale lanes become lane events and, nudged, deliveries.
  // The orchestrator's own lane and ignored windows make no lane events, so a missing Stop there is not a lost turn.
  const laneRules = rulesOf(config.laneEvents);
  const laneWatch = new LaneWatch({
    config: config.laneWatch, log, now, raise: d => laneEvents.raise(d), nudge: r => deliveries.post(r, "fleet"),
    watched: w => w !== laneRules.manager && !laneRules.ignore.some(g => g.test(w)),
    // A window is there while its node claims the name, a name in conflict too (another node's window called the same).
    alive: (node, window) => {
      const r = lanes.resolve(window);
      return r.kind === "ok" ? r.node === node : r.kind === "conflict" && r.claims.some(c => c.node === node);
    },
    online: node => connections.status(node) === "online",
    nudgeTarget: (node, window) => sessions.get(node)?.get(window) ?? null,
    ...(o.laneWatchSweepMs === undefined ? {} : { sweepMs: o.laneWatchSweepMs }),
  });
  events.subscribe(e => { if (e.t === "inventory") laneWatch.panes(e.node, (e.body as { panes: Pane[] }).panes); });
  laneEvents.watchWith(laneWatch);
  events.subscribe(e => { if (e.t === "delivery") laneEventsPush.delivery(e.body as Delivery); });
  const router = new Router({ connections, lanes, audit, log });
  const flight = new Flight();
  const watch = new HoldWatch({
    path: o.holdPath ?? holdFile(process.env.HOME || homedir()),
    service: "fleet",
    now,
    onStale: message => log.warn(message),
  });
  watch.start();
  const outbox = new OutboxStore(db);
  const delivery = new DeliveryWorker({ store: outbox, subscribers: config.subscribers, audit, log, now, ...o.delivery });
  for (const path of unsubscribedScriptPaths(config.subscribers)) {
    log.warn(`hook bus: no subscriber takes ${path}: its events are acknowledged and counted (morndo-fleet status), never delivered; the first one raises an unrouted_hook alert`);
  }
  const tx = fleetTransactions(db);
  // Each lane's Run (ADR-0032), made once the job mirror is: a hook is activity once its commit is on the disk.
  let runs: Runs | null = null;
  const hooks = new HookIntake({
    store: outbox, subscribers: config.subscribers, audit, now, onStored: () => delivery.kick(), tx, lanes: laneEvents, events,
    onCommitted: () => runs?.kick(), ...(o.hookBacklog === undefined ? {} : { cap: o.hookBacklog }),
  });
  const intake = new IntakeWindow({ intake: hooks, tx, log, ...(o.intakeWindowMs === undefined ? {} : { windowMs: o.intakeWindowMs }) });
  const jobsStore = new JobsStore(db);
  const pruneJobs = () => {
    try { jobsStore.prune(now()); }
    catch (e) { log.error("jobs: removing rows older than 7 days failed; trying again tomorrow", e); }
  };
  pruneJobs();
  const jobs = new JobMirror({
    store: jobsStore, events, log, now, online: node => connections.status(node) === "online",
    onFailed: view => audit.alert("job_failed", view.node, { id: view.id, name: view.name, class: view.class, outcome: view.outcome }),
    onUnnoticed: view => audit.alert("job_unnoticed", view.node, { id: view.id, name: view.name, class: view.class, outcome: view.outcome }),
    tell: async (node, id, notice) => {
      const out = await router.op({ node }, "job.noticeResult", { id, notice }, { client: "fleet" });
      return out.ok;
    },
    laneOf: name => {
      const lane = lanes.get(name);
      return lane ? { node: lane.node, conflict: lane.conflict } : null;
    },
    deliver: async route => {
      const out = await router.op({ node: route.node }, "job.notice", { id: route.noticeId, lane: route.lane, text: route.text }, { key: route.noticeId, client: "fleet", audit: false });
      return { ok: out.ok, state: out.ok ? "ok" : out.error.code };
    },
    note: (route, state) => {
      try {
        audit.record("client", "op.job.notice", route.node, {
          target: { node: route.node }, keyNs: route.noticeId.slice(0, route.noticeId.indexOf(":")), outcome: state, client: "fleet",
        });
      } catch (e) { log.error(`audit: op.job.notice on ${route.node} could not be recorded`, e); }
    },
  });
  const laneRuns = new Runs({
    events, connections, lanes, watch: laneWatch, jobs, waitMs: config.laneWatch.waitingMin * 60_000, log, now,
    ...(o.runsSweepMs === undefined ? {} : { sweepMs: o.runsSweepMs }),
  });
  runs = laneRuns;
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks: intake, deliveries, jobs, log, rollouts, build },
    ...(o.agentLimits ? { limits: o.agentLimits } : {}), ...(o.handshakeLimits ? { handshakeLimits: o.handshakeLimits } : {}),
    ...(o.handshakeMs === undefined ? {} : { handshakeMs: o.handshakeMs }),
  });
  let api;
  try {
    await agents.ready;
    api = await startClientApi(config.socketPath, {
      router, connections, lanes, nodes, audit, events, deliveries, laneEvents, laneWatch, jobs, runs: laneRuns, rollouts,
      worker: { socketPath: worker.path, scope: { protectedLanes: new Set(worker.protectedLanes), startNodes: new Set(worker.startNodes) } },
      rolloutAuthority: o.rolloutAuthority
        ?? (config.principalKey !== undefined
          ? principalAuthority(decodePrincipalKey(config.principalKey), { now })
          : hubFilePrincipalAuthority(o.principalKeyFile ?? hubIdentityPubFile(), { now })),
      log,
      ...(o.eventsBufferBytes === undefined ? {} : { eventsBufferBytes: o.eventsBufferBytes }),
      updates: { held: () => watch.held, flight },
    });
  } catch (e) {
    watch.stop();
    updaterWatch.stop();
    await agents.close();
    intake.stop();
    db.close();
    throw e;
  }
  connections.start();
  delivery.start();
  deliveries.start();
  laneEvents.start();
  laneEventsPush.start();
  try { laneWatch.rebuild(laneEvents.turnsSince(now() - REBUILD_WINDOW_MS)); }
  catch (e) { log.error("lane watch: reading the last day's turns failed (fleet.db busy?); watching new turns only", e); }
  laneWatch.start();
  laneRuns.start();                                     // after the watch's rebuild, so a Run reads the last day's turns
  const retention = setInterval(() => { pruneAudit(); pruneJobs(); }, AUDIT_PRUNE_EVERY_MS);
  const noticeRetry = setInterval(() => {
    try { jobs.retry(); } catch (e) { log.error("job notice retry failed; trying again next tick", e); }
  }, NOTICE_RETRY_MS);
  const clientApi = api;
  return {
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, intake, deliveries, laneEvents, laneEventsPush, laneWatch, jobs,
    runs: laneRuns, rollouts, agentPort: agents.port(),
    close: async () => {
      watch.stop();
      updaterWatch.stop();
      clearInterval(retention);
      clearInterval(noticeRetry);
      deliveries.stop();
      laneRuns.stop();
      laneWatch.stop();
      laneEvents.stop();
      connections.stop();                              // settles every request in flight, a lane-event batch's too
      const pushing = laneEventsPush.stop();           // its batch marks what its node stored, before fleet.db closes
      await clientApi.close();
      await pushing;
      await agents.close();
      intake.stop();                                   // events received and not yet committed are stored, unacknowledged
      await delivery.stop();
      db.close();
    },
  };
}
