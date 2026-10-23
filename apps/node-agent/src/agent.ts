// The running agent, `morndo-node run` (spec §2, §5): one connection to the fleet with the ops behind it, the hook relay
// and its durable stream, the inventory and health events, and the status file. stop() ends all of it. Test hooks
// (test-hooks.ts) act here too: dropAfterStarted cuts the connection and never sends that op's answer, fixedStreamId
// replaces the database's stream id, spoolFail fails every spool write, and the runtime's wall clock (clockOffsetMs)
// stamps health and hook events.
// - Every `res` carries `store`: the stream id of this database, where its done keys live (plan Contracts, Res). A new
//   or restored database is a new store, so a caller asking op.status about a key that database lost can tell.
// - Every `res` carries `storeSeq` too: how many keyed ops this database has started (done-keys.ts), read when the answer
//   is made, so it counts that op's own `started`, and op.status's answer says where the database is now. A database
//   put back from an older copy in place keeps its store but answers a lower storeSeq than the hub saw before, which
//   the hub takes as "can't vouch" (fleet core §3.1; final review I2, the store sequence).
// - A copied or restored database file (another (device, inode) than the one recorded with its stream id) starts a new
//   stream when it is opened (db/open.ts, final review I2), before the first hello; this is logged.
// - A restored database: when a welcome says the fleet accepted more of this stream than this database ever wrote
//   (ackSeq > its last seq), the database came back from a backup, and its next seqs would be taken for ones the fleet
//   already has. Or when it says the fleet has seen a higher store sequence from this store than this database holds
//   (storeSeqSeen > its storeSeq: a copy put back in place, which keeps the file's identity and the store id; the fix
//   wave's follow-up). The agent starts a new stream, so a new store (rotateStreamId), once per process, and dials
//   again so the hello names it. It decides before the connection goes online (FleetConnection's `admit`), so no op runs
//   under the old store: a send in doubt then reads `unknown` from another store and stays uncertain, however many keyed
//   ops the restored database would have run since.
// - The disk budget, LIMITS.spoolMaxBytes, is the spool's, the relay's copies' and the upload inbox's together.
// - Deliveries (fleet clients spec §4): the deliverer runs from start to stop, kicked by hooks and inventory reads; each
//   change goes out as ev.delivery, and after every welcome the open ones and every final still kept (7 days, §4.4).
// - Lane state events (fleet clients spec §7): each inventory read is observed for sessions that turn `waiting` or leave
//   it; the events go into the spool on "/lane" and to the fleet with the hooks (lane-state.ts).
import { randomUUID } from "node:crypto";
import { fleetRecord } from "@morndo/domain";
import { CAP_LONG_TEXT, ERROR_EXECUTED, LIMITS, type AgentMessage, type Delivery, type OpError } from "@morndo/protocol";
import { healthProbe, tmuxAdapter } from "@morndo/node-ops";
import { Flight, HoldWatch, holdFile, productVersion } from "@morndo/service-kit";
import { ConfigError, isOpName, jobLimits, jobsConfigProblem, jobTimeouts, type AgentConfig } from "./config.ts";
import { FleetConnection, type ReqMessage } from "./conn/connection.ts";
import type { RetryOptions } from "./conn/retry.ts";
import type { Lane } from "./conn/send-queue.ts";
import { writeStatus, type AgentStatus } from "./conn/status-file.ts";
import { openAgentDb, rotateStreamId } from "./db/open.ts";
import type { Deliverer } from "./deliveries/deliverer.ts";
import { EventLoops, utcOffsetMin } from "./events.ts";
import { LaneStates } from "./lane-state.ts";
import { fleetPublicKey, loadNodeKey } from "./identity.ts";
import type { Logger } from "./log.ts";
import type { Inventory } from "./ops/inventory.ts";
import { typeJobNotice } from "./ops/job-delivery.ts";
import { openJobRuntime, type JobRuntime } from "./ops/job-runtime.ts";
import { nodeOpener } from "./ops/node-files.ts";
import { createOpsRuntime } from "./ops/runtime.ts";
import { agentPaths } from "./paths.ts";
import { dropAgentTokenEnv, readBoardToken } from "./relay/board-token.ts";
import { notLiveFromHub } from "./relay/board-view.ts";
import { replyStyleAsk, type NotLiveOf } from "./relay/digest-check.ts";
import { RelayFiles } from "./relay/relay-files.ts";
import { startRelay, type Relay } from "./relay/server.ts";
import { statusAsk, type JobsOf } from "./relay/status-ask.ts";
import { Spool } from "./relay/spool.ts";
import { StreamSender } from "./relay/stream-sender.ts";
import { cachedFor, foreignStop, windowResolver } from "./relay/window-of.ts";
import { dropOnce, type TestHooks } from "./test-hooks.ts";

// Results that carry transcript or file bytes, or a capture of up to 256 KiB, go on the bulk queue (spec §5.2 "Frames").
const BULK_OPS = new Set(["transcript.read", "file.get", "pane.capture"]);
const HOUSEKEEPING_MS = 3_600_000;
// After every welcome: the deliveries not final, and every final the node still keeps (LIMITS.deliveryKeepMs). An outage
// longer than an hour must still correct a mirror row the fleet is alerting on.
const DELIVERY_REPLAY_MS = LIMITS.deliveryKeepMs;

export type AgentOptions = {
  config: AgentConfig;
  log: Logger;
  hooks?: TestHooks;
  instanceId?: string;
  retry?: RetryOptions;
  pingTimeoutMs?: number;
  pollMs?: number;
  healthMs?: number;
  statusMs?: number;
  diskBudgetBytes?: number;                                // LIMITS.spoolMaxBytes; a test sets a smaller one
  flight?: Flight;                                        // a test holds one item so stop's wait can be seen
  stopWaitMs?: number;                                    // how long stop waits for in-flight work; default 10s
};
export type RunningAgent = {
  instanceId: string;
  readonly streamId: string;                               // the store id too; rotated for a restored database
  relayPort: number;
  inventory: Inventory;
  deliverer: Deliverer;                                    // the delivery queue's deliverer (tests watch what kicks it)
  spool: Spool;
  status(): AgentStatus;
  stop(): Promise<void>;
};

export async function startAgent(o: AgentOptions): Promise<RunningAgent> {
  const { config, log } = o;
  if (config.policy.jobsWarning) log.error(jobsConfigProblem(config.policy.jobsWarning));
  const hooks = o.hooks ?? {};
  const paths = agentPaths(config.home);
  const fleetKey = fleetPublicKey(config.fleetKey);
  if (!fleetKey) throw new ConfigError(`${paths.configFile}: fleetKey is not an Ed25519 public key`);
  const nodeKey = loadNodeKey(config.keyPath);
  const adb = openAgentDb(config.dbPath);
  if (adb.copied) {
    log.warn(`${config.dbPath} is not the file this database was made in (copied or restored?): a new hook stream and store ${adb.streamId}; sends in doubt from before stay uncertain`);
  }
  let streamId = hooks.fixedStreamId ?? adb.streamId;
  let rotated = false;
  const instanceId = o.instanceId ?? randomUUID();
  let conn: FleetConnection | null = null;
  // The disk budget: what the relay's copies and the upload inbox hold counts toward the spool's byte cap, and both are
  // refused what the budget can't hold. (Read through closures: spool and files are made just below.)
  const budget = o.diskBudgetBytes ?? LIMITS.spoolMaxBytes;
  const held = (): number => files.bytes() + ops.inbox.bytes();
  const room = (): number => budget - spool.bytes() - held();
  // The agent's in-flight work lands in status.json the moment it changes (updates design §6.3): an updater watching
  // for a safe point reads it while the work runs, not at the next health tick. saveStatus never throws (its write is
  // caught), so a failing disk cannot disturb the op that began or ended the item.
  const flight = o.flight ?? new Flight({ onChange: () => saveStatus() });
  // Seeing the hold or no longer seeing it lands in status.json at once too: the updater waits for the node's word that
  // it has seen the hold before it judges the drain. The status writer is defined below; until then there is nothing
  // to rewrite.
  let statusReady = false;
  const watch = new HoldWatch({
    path: holdFile(config.home),
    service: "node",
    onStale: message => log.warn(message),
    onChange: () => { if (statusReady) saveStatus(); },
  });
  watch.start();
  let draining = false;
  const ops = createOpsRuntime({
    config, db: adb.db, log, hooks, room: () => room(), held: () => watch.held || draining, flight,
    emitDelivery: d => { sendDelivery(d); },
    ...(hooks.dropAfterStarted !== undefined ? { afterStarted: dropOnce(hooks.dropAfterStarted, () => conn?.drop()) } : {}),
  });
  const spool: Spool = new Spool(adb.db, streamId, { failWrites: hooks.spoolFail === true, maxBytes: budget, held: cachedFor(1000, held) });
  const open = nodeOpener({ home: config.home, stateDir: paths.stateDir, configDir: paths.configDir, ...(config.policy.fileRoots ? { fileRoots: config.policy.fileRoots } : {}) });
  const files: RelayFiles = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open, room: () => room() });
  const sessions = cachedFor(2000, () => ops.registry.byPane());

  const send = (m: AgentMessage, lane: Lane = "control") => conn?.send(m, lane) ?? false;
  const sendDelivery = (d: Delivery) => send({ v: 1, t: "ev.delivery", delivery: d });
  // After every welcome: each delivery not final, and every final still kept. Latest wins at the fleet. A final the
  // mirror still shows as typed is in there, so a long outage does not leave it pending. A change made while offline is
  // in there, so none is lost by a dropped send.
  const replayDeliveries = () => {
    try {
      for (const d of [...ops.deliveries.open(), ...ops.deliveries.recentFinal(ops.now() - DELIVERY_REPLAY_MS)]) sendDelivery(d);
    } catch (e) { log.warn("could not read the deliveries to send after a welcome", e); }
  };
  const sender = new StreamSender({ spool, node: config.node, send: m => send(m), log });
  const states = new LaneStates({
    spool, appended: () => sender.kick(), screen: pane => ops.tmux.capture(pane, { lines: 50, attributes: false }),
    now: ops.now, changed: () => ops.deliverer.kick("status"), log,
  });
  const events = new EventLoops({
    inventory: ops.inventory, send: m => send(m), log,
    onInventory: async s => { ops.deliverer.kick("inventory"); await states.observe(s.lanes); },
    health: async () => ({
      ...(await healthProbe(config.home, { tmuxSocket: config.policy.tmuxSocket })), wallClock: ops.now(), spoolDepth: spool.depth(), drops: spool.drops,
      tzOffsetMin: utcOffsetMin(),
      ...(config.policy.jobsWarning ? { jobs: jobsConfigProblem(config.policy.jobsWarning) } : {}),
    }),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.healthMs !== undefined ? { healthMs: o.healthMs } : {}),
  });
  const status = (): AgentStatus => ({
    ...(conn?.status() ?? { state: "stopped", since: Date.now(), connEpoch: null, lastClose: null, retryInMs: null }),
    node: config.node, instanceId, pid: process.pid, spoolDepth: spool.depth(), drops: spool.drops,
    version: productVersion(), ready: true, held: watch.held,
    inFlight: flight.list().slice(0, 100),               // the protocol's cap; what a restart would interrupt
    ...(config.policy.jobsWarning ? { jobs: jobsConfigProblem(config.policy.jobsWarning) } : {}),
  });
  const saveStatus = () => {
    try { writeStatus(paths.statusFile, status()); } catch (e) { log.warn("could not write status.json", e); }
  };
  statusReady = true;
  const errorRes = (id: string, error: OpError): AgentMessage =>
    ({ v: 1, t: "res", id, invVersion: ops.inventory.invVersion, store: streamId, ok: false, error, storeSeq: ops.doneKeys.seq() });

  const answer = async (m: ReqMessage) => {
    const reply = await ops.executor.handle({ id: m.id, op: m.op, args: m.args, timeoutMs: m.timeoutMs, ...(m.key !== undefined ? { key: m.key } : {}) });
    if (reply.discarded) { log.warn(`test hook dropAfterStarted: the answer to a ${m.op} request is not sent`); return; }
    let res: AgentMessage = reply.ok
      ? { v: 1, t: "res", id: reply.id, invVersion: reply.invVersion, store: streamId, ok: true, result: reply.result, storeSeq: ops.doneKeys.seq() }
      : { v: 1, t: "res", id: reply.id, invVersion: reply.invVersion, store: streamId, ok: false, error: reply.error, storeSeq: ops.doneKeys.seq() };
    if (Buffer.byteLength(JSON.stringify(res)) > LIMITS.maxMessageBytes) {
      res = errorRes(m.id, { code: "too_large", executed: ERROR_EXECUTED.too_large, message: "the answer is over 512 KiB" });
    }
    if (!send(res, BULK_OPS.has(m.op) ? "bulk" : "control")) log.info(`the answer to a ${isOpName(m.op) ? m.op : "?"} request found no live connection`);
  };

  // The waker ask's job check (W1, status-ask.ts). The job store opens after the relay, so until it does the node can't
  // tell whether a job will wake a lane, and only the status ask is made; a read that fails can't tell either.
  let jobsOf: JobsOf = () => null;
  // The reply style ask's not-live rule (T-308, digest-check.ts): the board is read with the token in the board-token
  // file, when a Stop needs it. The token is not read from the environment: it would be in the tmux server's and every
  // lane's. Without a hub, or with no usable file, only the length and jargon rules run.
  if (dropAgentTokenEnv()) log.warn(`MORNDO_AGENT_TOKEN was set in the node's environment: it is removed from it and ignored, as every lane it starts would hold it. Put the board token in ${paths.boardTokenFile} (mode 600)`);
  const boardHub = config.hub ?? "";
  const notLiveOf = (lane: string): NotLiveOf | undefined => boardHub === "" ? undefined : async () => {
    const token = readBoardToken(paths.boardTokenFile);
    return token === null ? null : notLiveFromHub({ hub: boardHub, token, lane });
  };
  let relay: Relay;
  try {
    relay = await startRelay({
      port: config.relayPort, spool, files, log, onAppended: () => { sender.kick(); ops.deliverer.kick("hook"); }, now: ops.now,
      windowOf: windowResolver({ windowOfPane: p => ops.inventory.windowOfPane(p), sessions, refresh: sessions.fresh }),
      // B6: a fresh read of the sessions directory per Stop or failure, no cache: a headless run's file may have appeared a
      // moment ago, and Stops are one per turn.
      foreign: foreignStop({ headless: id => ops.registry.headless(id) }),
      ask: async (body, window) =>
        statusAsk(body, window, config.policy.statusContract, lane => jobsOf(lane)) ?? await replyStyleAsk(body, window, config.policy.statusContract, notLiveOf(window ?? "")),
    });
  } catch (e) {
    watch.stop();
    adb.close();
    throw e;
  }

  let jobs: JobRuntime;
  try {
    const typer = tmuxAdapter({ socket: config.policy.tmuxSocket, session: config.policy.session });
    jobs = await openJobRuntime({
      db: adb.db, home: config.home, stateDir: paths.stateDir, socketPath: paths.jobSock, now: ops.now,
      ...(config.hub ? { hubBase: config.hub } : {}),
      // The same paste pane.send uses. Pasted text is in the pane, submitted or not, and that id is never pasted again.
      node: config.node,
      limits: jobLimits(config.policy.jobs),
      timeouts: jobTimeouts(config.policy.jobs),
      enabled: config.policy.jobs.enabled,
      ...(config.policy.jobs.guard ? { guard: config.policy.jobs.guard } : {}),
      emit: event => { send(event); },
      log,
      type: delivery => typeJobNotice(
        async lane => {
          const snap = await ops.inventory.refresh();
          return snap.lanes.find(item => item.window === lane)?.pane ?? null;
        },
        (pane, text) => typer.send(pane, text),
        delivery,
      ),
    });
  } catch (e) {
    watch.stop();
    await relay.close();
    adb.close();
    throw e;
  }
  jobsOf = lane => {
    try { return jobs.store.openFor(lane); }
    catch (e) { log.warn("could not read a lane's jobs; its wait is not asked for a waker", e); return null; }
  };
  ops.bindJobs({
    notice: async (id, lane, text) => {
      const decided = await Promise.resolve(jobs.deliveries.enqueue(id, lane, text));
      if (!decided.ok) return { ok: false, error: "id_conflict" as const };
      return { ok: true as const, typed: decided.value.typed };
    },
    laneOf: token => jobs.grants.laneOf(token),
    lane: id => jobs.store.get(id)?.lane ?? null,
    cancel: async id => {
      const decided = await jobs.supervisor.cancel(id);
      if (decided.ok) return { ok: true as const };
      return { ok: false as const, error: decided.error };
    },
    mark: (id, notice) => jobs.store.markNotice(id, notice),
  });

  conn = new FleetConnection({
    url: config.fleetUrl, node: config.node, instanceId, streamId, fleetKey, nodeKey,
    // CAP_LONG_TEXT beside the ops: this agent takes pane.send and lane.deliver text up to LIMITS.maxMessageText.
    caps: [...config.policy.ops, CAP_LONG_TEXT], log,
    claudeVersion: () => [...sessions().values()].find(s => s.version)?.version ?? null,
    admit: w => !restored(w),
    onWelcome: w => {
      sender.online(w);
      events.online();
      replayDeliveries();
      // A reconnect resends jobs still inside 7 days, at the time they were observed, not at reconnect.
      for (const job of jobs.store.list()) {
        const at = jobs.store.replayAt(job);
        if (at === null) continue;
        send(fleetRecord(job, { node: config.node, at, tail: jobs.store.eventTail(job.id) }));
      }
    },
    onRequest: m => { answer(m).catch((e: unknown) => log.error("answering a request failed", e)); },
    onBadRequest: (id, op) => {
      send(errorRes(id, isOpName(op)
        ? { code: "bad_args", executed: ERROR_EXECUTED.bad_args, message: "a request that doesn't fit its op" }
        : { code: "unknown_op", executed: ERROR_EXECUTED.unknown_op, message: "this node has no such op" }));
    },
    onAck: a => { if (a.streamId === streamId) sender.ack(a.seq); },
    onDown: () => { sender.offline(); events.offline(); },
    onStatus: () => saveStatus(),
    ...(o.retry ? { retry: o.retry } : {}),
    ...(o.pingTimeoutMs !== undefined ? { pingTimeoutMs: o.pingTimeoutMs } : {}),
  });

  // A welcome that says this database went backwards: the fleet acknowledged more of this stream than it ever wrote, or
  // has seen a higher store sequence from this store than it holds. A restored database: a new stream and store, once
  // per process (a fleet that claimed it again would only make the agent redial in a loop). True turns the welcome down:
  // the connection never goes online, and the agent dials again with a hello that names the new store.
  // A stream whose last seq can't be read says nothing either way about the stream, but the store sequence is compared
  // all the same (the residual round: before, that read error let a database behind the fleet go online), and nothing
  // of a stream whose end is unknown is acknowledged.
  function restored(w: { ackSeq: number; streamKnown: boolean; storeSeqSeen?: number }): boolean {
    let last: number | null;
    try { last = spool.lastSeq(); } catch (e) { log.warn("could not read the hook stream's last seq; the store sequence still decides", e); last = null; }
    const streamBehind = last !== null && w.streamKnown && w.ackSeq > last;
    const seq = ops.doneKeys.seq();
    const storeBehind = w.storeSeqSeen !== undefined && seq < w.storeSeqSeen;
    if (!streamBehind && !storeBehind) return false;
    const what = storeBehind
      ? `the fleet has seen store sequence ${w.storeSeqSeen} from store ${streamId}, but this database holds ${seq}`
      : `the fleet has seq ${w.ackSeq} of stream ${streamId}, but this database wrote only up to ${last ?? "?"}`;
    if (hooks.fixedStreamId !== undefined || rotated) {
      log.error(`${what}; ${rotated ? "a new stream was started already" : "the stream id is fixed by a test hook"}, so it is kept`);
      return false;
    }
    try {
      // Bounded by what the stream held at open, not by its last seq now: events spooled since (after a restore, before
      // this first welcome) were answered 200 queued and must go again under the new stream, never be acked away.
      const open = spool.openLastSeq();
      const acked = w.streamKnown && last !== null && open !== null ? Math.min(w.ackSeq, open) : 0;
      if (acked > 0) spool.ack(acked);                        // the rows the fleet had at open; the rest go again
      streamId = rotateStreamId(adb.db);
    } catch (e) {
      log.error("could not start a new hook stream (a full disk?); new events may be taken for duplicates", e);
      return false;
    }
    rotated = true;
    spool.rotate(streamId);
    conn?.setStreamId(streamId);
    log.warn(`${what}: a database put back from an older copy? Starting a new store ${streamId} before running anything; sends in doubt from before stay uncertain`);
    return true;
  }

  const housekeeping = () => {
    try { ops.doneKeys.prune(); ops.deliveries.prune(); files.sweep(); ops.inbox.sweep(); }
    catch (e) { log.warn("housekeeping failed", e); }
  };
  housekeeping();
  const timers = [setInterval(housekeeping, HOUSEKEEPING_MS), setInterval(saveStatus, o.statusMs ?? LIMITS.healthMs)];
  events.start();
  ops.deliverer.start();
  conn.start();

  return {
    instanceId, get streamId() { return streamId; }, relayPort: relay.port, inventory: ops.inventory, deliverer: ops.deliverer, spool, status,
    stop: async () => {
      draining = true;
      await flight.idle(o.stopWaitMs ?? 10_000);
      watch.stop();
      for (const t of timers) clearInterval(t);
      events.stop();
      ops.deliverer.stop();
      jobs.close();
      await conn?.stop();
      await relay.close();
      await ops.deliverer.drain();                         // a round in flight ends before its database closes
      saveStatus();
      adb.close();
    },
  };
}
