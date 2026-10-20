#!/usr/bin/env node
// morndo: the principal's hub. `serve` runs it; `pair`, `devices`, `revoke`, `audit` are the console (the trust root).
import QRCode from "qrcode";
import { CONVERSATION_CAP, formatFingerprint, type AccessPolicy } from "@morndo/domain";
import { DEFAULT_PUSH_CONTACT, engineSessionsOk, fleetSocketOk, isPushContact, loadConfig } from "./config.ts";
import { Store } from "./adapters/store.ts";
import { DatabaseFromFuture } from "./adapters/migrations.ts";
import { DatabaseUnreadable, NotLocalDisk, argvWantsVersion, holdFile, productVersion } from "@morndo/service-kit";
import { log } from "./adapters/log.ts";
import { exitOnCrash } from "./adapters/crash.ts";
import { startRetention } from "./application/retention.ts";
import { ReadingService } from "./application/reading-service.ts";
import { PresenceService } from "./application/presence-service.ts";
import { NotificationService } from "./application/notification-service.ts";
import { loadOrCreateVapid, pushSender } from "./adapters/webpush.ts";
import { loadOrCreateIdentity } from "./adapters/identity.ts";
import { passkeys } from "./adapters/passkeys.ts";
import { denyConfigFromEnv, denyConfigWithClaudeDir, denyRoots, paneLock } from "@morndo/node-ops";
import { CLIENT_API } from "@morndo/protocol";
import type { HubPorts, Tmux } from "./application/ports.ts";
import { startHttp } from "./adapters/http.ts";
import { AccessService } from "./application/access-service.ts";
import { ObservationService } from "./application/observation-service.ts";
import { SteeringService } from "./application/steering-service.ts";
import { ledgerReader } from "./adapters/ledger.ts";
import { EscalationService, managerOf } from "./application/escalation-service.ts";
import { BriefService } from "./application/brief-service.ts";
import { RemoteService } from "./application/remote-service.ts";
import { ManagerQueue } from "./application/manager-queue.ts";
import { fleetDeliveries } from "./adapters/fleet-deliveries.ts";
import { fileStore } from "./adapters/files.ts";
import { processIo, runLanes } from "./console/lanes.ts";
import { noteMissingFfmpeg, uploadInbox } from "./adapters/uploads.ts";
import { desktopTarget, legacyPorts } from "./adapters/local-ports.ts";
import { engineLanesFor } from "./adapters/engine-registry.ts";
import { FleetClient, checkFleet } from "@morndo/fleet-client";
import { fleetPorts, type FleetPorts, type LocalFileStore } from "./adapters/fleet-adapters.ts";
import { connectionsCli, connectionsEnv } from "./adapters/connections-cli.ts";
import { enginesCli } from "./adapters/engines-cli.ts";
import { EnginesService } from "./application/engines-service.ts";
import { ConnectionsPageService } from "./application/connections-page.ts";
import { BoardService } from "./application/board-service.ts";
import { BoardProjector } from "./application/board-projector.ts";
import { fleetRuns } from "./adapters/fleet-runs.ts";
import { AgentAccess } from "./application/agent-access.ts";
import { UsageService } from "./application/usage-service.ts";
import { JobsService } from "./application/jobs-service.ts";
import { AlertsService, SEEN_MARK } from "./application/alerts-service.ts";
import { locateTranscriber } from "./adapters/transcriber-path.ts";
import { processTranscriber } from "./adapters/transcriber-process.ts";
import { guardNow, loadTranscriptionSettings, openMachineGuard } from "./adapters/transcription-config.ts";
import { fileOnDisk, TranscriptionService } from "./application/transcription-service.ts";
import { MemoryStore } from "./adapters/memory-store.ts";
import { MemoryFromFuture } from "./adapters/memory-migrations.ts";
import { MemoryService } from "./application/memory-service.ts";
import { MemorySync, SYNC_EVERY_MS } from "./application/memory-sync.ts";
import { runMemory } from "./console/memory.ts";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `morndo: your agents, on your phone.

  morndo serve            run the hub on 127.0.0.1:$MORNDO_PORT (default 8790)
  morndo pair             show a one-time QR (10 minutes) to pair a phone or laptop
  morndo devices          list paired devices
  morndo revoke <id>      revoke a device; its sessions end at once
  morndo audit            the latest device and session events
  morndo lanes …          every node's lanes through the fleet: list, peek, send, keys, start, stop, status,
                          events (morndo lanes --help)
  morndo agent-token new <name> --role manager|worker
                          a token for the manager's lane, or one the worker lanes share (shown once)
  morndo agent-token list
  morndo agent-token revoke <id>
  morndo memory list [--scope S] [--pending] [--all]
                          what the lanes learned (Memory); also show <id>, approve <id>, invalidate <id> --reason R,
                          import --dir D --scope S [--label L] [--procedure FILE]..., sync (morndo memory --help)

Settings (environment): MORNDO_ORIGIN (the URL your browser opens), MORNDO_HOME, MORNDO_PORT,
MORNDO_REQUIRE_PROXY_IDENTITY=1, MORNDO_PRINCIPAL_LOGIN, MORNDO_TMUX_SOCKET, MORNDO_TMUX_SESSION,
MORNDO_CLAUDE_DIR, MORNDO_MANAGER_WINDOW (default "manager"), MORNDO_LEDGER (the manager's needs-you list),
MORNDO_PANE_LOCK (the lock file other typists into the manager's pane take), MORNDO_VNC (host:port of the desktop's
VNC server), MORNDO_VNC_PASSWORD_FILE, MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
machine's tmux and Claude Code directly), MORNDO_ENGINE_SESSIONS (engine-lane registry directory; off unless set),
MORNDO_ENGINE_NODE (this machine's fleet node name, required with a fleet), MORNDO_ENGINES (the engine layer's
CLI, engine-layer bin/engines: the Engines page) and MORNDO_MANAGER_QUEUE (with a fleet, the manager's answers and
messages go through the fleet's delivery queue; "off" types them directly). MORNDO_TRANSCRIBER (absolute path of a
protocol-1 plugin; otherwise <MORNDO_HOME>/plugins/transcribe/bin/morndo-transcribe).`;

if (argvWantsVersion(process.argv)) {
  process.stdout.write(`${productVersion()}\n`);
  process.exit(0);
}

exitOnCrash(log);
// `morndo lanes` (fleet-clients §9.2) runs before the hub's settings and database are read: it needs neither, and runs
// on a machine with no hub. Every line it writes is out before the exit (console/lanes.ts processIo).
if (process.argv[2] === "lanes") process.exit(await runLanes(process.argv.slice(3), processIo()));
const EXIT_CONFIG = 78;                                  // EX_CONFIG (sysexits.h): a setting or the data needs fixing, not a restart
const EXIT_DATABASE_FROM_FUTURE = EXIT_CONFIG;          // see openStore below
const config = loadConfig();
const store = openStore(config.dataDir);

// A database written by a newer hub is never guessed at (migrations.ts): one sentence, no stack, and exit 78
// (EX_CONFIG in sysexits.h), so a service manager can be told not to restart into the same refusal every few seconds
// (systemd: RestartPreventExitStatus=78; phase A review L5).
function openStore(dir: string): Store {
  try { return new Store(dir); }
  catch (e) {
    if (e instanceof NotLocalDisk) { log.error(e.message); process.exit(EXIT_CONFIG); }
    if (!(e instanceof DatabaseFromFuture)) throw e;
    log.error(`${dir}/morndo.db was written by a newer Morndo (schema version ${e.found}); this hub knows migrations only up to ${e.known}. Run the newer hub, or restore a backup.`);
    process.exit(EXIT_DATABASE_FROM_FUTURE);
  }
}
const identity = loadOrCreateIdentity(config.dataDir);
const access = new AccessService(store, passkeys(config));
const [cmd = "serve", ...args] = process.argv.slice(2);
const when = (t: number | null) => (t === null ? "-" : new Date(t).toLocaleString());
// The console commands' own output, for the person at the box (a pairing link must show as it is): not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);

switch (cmd) {
  case "serve": {
    // A contact the push services refuse would fail every push with a 403 (Apple: BadJwtToken). Said once, here, and
    // only for `serve`: the console commands (devices, revoke, audit) must still work to put things right.
    const pushContact = config.pushContact ?? DEFAULT_PUSH_CONTACT;
    if (!isPushContact(pushContact)) {
      log.error(`MORNDO_PUSH_CONTACT must be an https URL or a mailto address on a public name (push services refuse others): ${JSON.stringify(pushContact)}. Set one, or unset it for the default.`);
      process.exit(EXIT_CONFIG);
    }
    // The same for a fleet socket that isn't an absolute path (config.ts fleetSocket): `serve` only, so the console
    // commands still work.
    if (config.fleetSocket && !fleetSocketOk(config.fleetSocket)) {
      log.error(`MORNDO_FLEET_SOCKET must be an absolute path to the fleet service's client socket, not ${JSON.stringify(config.fleetSocket)}; set the full path, or unset it to use this machine's tmux.`);
      process.exit(EXIT_CONFIG);
    }
    if (config.engineSessions && !engineSessionsOk(config.engineSessions)) {
      log.error(`MORNDO_ENGINE_SESSIONS must be an absolute path to the engine-lane registry, not ${JSON.stringify(config.engineSessions)}; set the full path, or unset it to leave engine-lane status off.`);
      process.exit(EXIT_CONFIG);
    }
    const files = fileStore({ dir: config.filesDir, deny: denyRoots(homedir(), config.dataDir, denyConfigWithClaudeDir(denyConfigFromEnv(process.env), config.claudeDir)) });
    // MORNDO_FLEET_SOCKET set: every port goes through the fleet service; unset: this machine's tmux and Claude Code, as
    // before (spec §10). Nothing below this line knows which.
    const jobs = new JobsService();
    // The fleet's alerts in the app; an urgent new one is a push (counts only), told once the notifications exist below.
    let alertPush: (urgent: boolean) => void = () => {};
    const alerts = config.fleetSocket ? new AlertsService({ onNew: (_a, urgent) => alertPush(urgent) }) : null;
    const fleet = config.fleetSocket ? await openFleet(config.fleetSocket, files, jobs, alerts) : null;
    const ports: HubPorts = fleet?.ports ?? legacyPorts(config, { files });
    // Engine lanes on this machine, only when MORNDO_ENGINE_SESSIONS names their registry. Off otherwise: nothing is read.
    const engineLanes = engineLanesFor(config);
    if (engineLanes.notice) log.info(engineLanes.notice);
    // A poll waits for its nodes at most one poll interval, and skips a node that isn't online (fleet core §3.1).
    const observation = new ObservationService(ports.tmux, config.quietAfterMs, Date.now, {
      sessions: ports.sessions, transcripts: ports.transcripts, files: ports.files, nodeStates: ports.nodeStates, nodeWaitMs: config.pollMs,
      lanes: engineLanes.lanes, engineNode: engineLanes.engineNode,
    });
    // Typing into the manager's pane takes the lock its other typists take, so two pastes never merge into one message.
    // Legacy only: with a fleet, the node's agent takes it (spec §3.1, "Pane lock").
    // The workers as escalations see them: with each one's conflict (two windows claim its name, Task 14).
    const workers = () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: observation.conflicted(w.id) }));
    const managerPane = () => managerOf(workers(), config.managerWindow);
    const lock = !fleet && config.paneLock ? paneLock(config.paneLock) : null;
    const typist: Tmux = !lock ? ports.tmux : {
      ...ports.tmux,
      send: async (id, text, key) => {
        if (id !== managerPane()) return ports.tmux.send(id, text, key);
        const r = await lock(() => ports.tmux.send(id, text, key));
        return r === "busy" ? { problem: "busy", typedAt: Date.now() } : r;
      },
    };
    const inbox = uploadInbox({ dir: config.inboxDir, registry: store });
    // The manager's answers and messages through the fleet's delivery queue (fleet-clients §9.1), the only queue for them
    // (ruling 81): with a fleet, on unless MORNDO_MANAGER_QUEUE is off. Off, what is still queued is cancelled at start and
    // the rest followed to its end.
    const queue = fleet ? new ManagerQueue({ store, deliveries: fleetDeliveries(fleet.client), lane: config.managerWindow, on: config.managerQueue === true }) : null;
    void noteMissingFfmpeg(line => log.warn(line));
    // A Command is judged on arrival against what the worker waits for now (S6). With a fleet, a repeat of a send in
    // doubt asks the worker's node (op.status, spec §3.1).
    const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
      id => observation.nameOf(id), ports.uploads, ports.sendStatus, queue ? { queue, isManager: id => id === managerPane() } : null,
      () => managerPane() ?? null, config.managerWindow);
    const filed: { briefs: BriefService | null } = { briefs: null };
    const escalations = new EscalationService({
      watch: {
        workers,
        history: id => observation.history(id, CONVERSATION_CAP),
        openQuestions: id => observation.openQuestions(id),
        screen: id => observation.screen(id),
      },
      ledger: config.ledgerPath ? ledgerReader(config.ledgerPath) : null,
      store, managerName: config.managerWindow, send: (pane, text, key) => typist.send(pane, text, key), policy: () => access.policy(),
      // An answer in doubt is settled as a send is, with its node (op.status; final review C1).
      settle: (key, workerId) => steering.settleInDoubt(key, workerId),
      queue,
      briefs: () => filed.briefs?.sightings() ?? [],
    });
    const briefs = new BriefService({ store, escalations, managerName: config.managerWindow, managerWorkerId: managerPane, hasLedger: config.ledgerPath != null });
    filed.briefs = briefs;
    if (queue) {
      // Off: what is still queued is cancelled here, before any answer (the hub types directly once it serves). On:
      // nothing has to come first; the sticky check and the first round run while the hub serves (review #8).
      const first = queue.start();
      if (queue.on) void first.catch((e: unknown) => log.error("manager queue: its first round failed; each poll tries again", e));
      else await first;
      log.info(`manager queue: ${queue.on ? "on" : "off (MORNDO_MANAGER_QUEUE)"}`);   // once, at start (reconciliation ruling 39)
    }
    const remote = new RemoteService({
      store, terminal: ports.terminal, policy: () => access.policy(),
      panes: () => observation.snapshot().workers.map(w => w.id as string),
      // The desktop MORNDO_VNC names, with or without a fleet (spec §16.1); unset, it answers no_desktop.
      desktop: desktopTarget(config),
    });
    // Read marks and mute, synced across devices (phase D). A mark may reach the newest message's time even where a node's
    // clock runs ahead of this one's (FL13).
    const reading = new ReadingService(store, Date.now, name => observation.snapshot().workers
      .filter(w => w.name === name)
      .reduce<number | null>((newest, w) => (w.lastMessageAt === null ? newest : Math.max(newest ?? 0, w.lastMessageAt)), null));
    // Web push (phase F): counts only, to each device that turned it on, unless he is attending on one (N1–N5).
    const vapid = loadOrCreateVapid(config.dataDir, pushContact);
    const nameOf = (id: string) => observation.snapshot().workers.find(w => w.id === id)?.name;
    const notifications = new NotificationService({
      store, send: pushSender(vapid), extraOrigins: config.pushExtraOrigins ?? [],
      muted: id => { const name = nameOf(id); return name !== undefined && reading.state().muted.includes(name); },
      alerts: () => alerts?.urgentSince(reading.state().reads[SEEN_MARK] ?? 0) ?? 0,
    });
    alertPush = urgent => notifications.alert(urgent);
    // ADR-0013: the Engines page, through the engine layer's CLI when MORNDO_ENGINES names it.
    const engines = config.enginesBin ? new EnginesService({ cli: enginesCli(config.enginesBin), store, policy: () => access.policy() }) : null;
    // The connections program, named like the engines CLI. A private home only, and never the engines program.
    const connections = openConnections(access.policy.bind(access));
    // Said once at start: a CLI older than the page needs, or one that can't run (the page says it again when opened).
    engines?.ready().then(why => { if (why) log.warn(`engines: ${why}`); }, e => log.warn("engines: the CLI can't run", e));
    // ADR-0015: the board, changed by the principal (a Command) and by the agents (their tokens, issued below).
    // ADR-0032: with a fleet, the board also follows the lanes' Runs (the projector, on the fleet client the alerts and
    // the deliveries use): each lane's run goes out with the board, and its tasks move by D1 to D4 as actor "board".
    const following: { projector: BoardProjector | null } = { projector: null };
    const board = new BoardService({ store, policy: () => access.policy(), lanes: () => observation.snapshot().workers.map(w => w.name), runs: () => following.projector?.runs() ?? [] });
    following.projector = fleet ? new BoardProjector({ source: fleetRuns(fleet.client), board }) : null;
    const agents = new AgentAccess(store, config.managerWindow);
    // ADR-0031: Memory, in its own file beside morndo.db, through the same agent tokens; its skills go to every node
    // through the fleet. A memory.db this hub can't open turns Memory off, never the hub.
    const memoryStore = openMemory(config.dataDir);
    const memory = memoryStore ? new MemoryService({ store: memoryStore }) : null;
    const memorySync = memoryStore && memory && fleet ? new MemorySync({ service: memory, store: memoryStore, fleet: fleet.client }) : null;
    // ADR-0016: the accounts' usage, from the status lines the lanes post with their agent tokens.
    const usage = new UsageService({ store });
    const presence = new PresenceService(store);                   // his last activity per device (ADR-0011, H4)
    jobs.attach({ store, board });
    // The runs read once, which applies what is due since the hub last ran; never in the way of the hub's start (a fleet
    // that doesn't answer is logged, and asked again when it does).
    void following.projector?.start().catch((e: unknown) => log.error("board: following the runs failed to start", e));
    const txSettings = loadTranscriptionSettings(config.dataDir, line => log.warn(line));
    const machine = openMachineGuard(txSettings.guard);
    try { await machine.refresh(); }
    catch (e) { log.warn("transcription: machine figure unread", e); }
    // Each probe looks again: a plugin installed while the hub runs turns the feature on, and one removed or turned
    // unsafe turns it off (design §6). The one known path, never PATH.
    const transcription = new TranscriptionService({
      store,
      transcriber: null,
      locate: () => {
        const located = locateTranscriber(process.env, config.dataDir);
        return located.path !== null
          ? { transcriber: processTranscriber(located.path), unavailable: null }
          : { transcriber: null, unavailable: { ready: false, reason: located.reason, detail: located.detail } };
      },
      // An upload is a recording only for the endpoint that made it (S2's rule); an agent's file is anyone's, as
      // the design has it. Whatever the id names, the bytes settle whether it is audio (S1).
      file: (recording, caller) => {
        if (recording.kind === "upload") {
          const upload = inbox.get(recording.id);
          if (!upload || (caller && upload.endpointId !== caller.endpointId)) return null;
          return fileOnDisk(upload.path);
        }
        return fileOnDisk(files.get(recording.id)?.file);
      },
      limit: txSettings.limit, timeoutSec: txSettings.timeoutSec, maxSeconds: txSettings.maxSeconds, threads: txSettings.threads,
      guard: () => guardNow(txSettings.guard, machine.read),
      log: line => log.info(line),
    });
    void transcription.start().then(() => {}, e => log.warn("transcription: probe failed", e));
    const http = startHttp({
      config, identity, access, observation, steering, escalations, remote, files, inbox, reading, presence,
      push: { publicKey: vapid.publicKey, notifications }, engines, connections, board: { service: board, agents }, usage, jobs, queue, alerts,
      transcription, briefs, memory: memory ? { service: memory, agents } : null, updates: { holdPath: holdFile(process.env.HOME || homedir()) },
    });
    const sweepInbox = setInterval(() => inbox.sweep(), 3_600_000);
    const syncMemory = memorySync ? setInterval(() => void memorySync.tick(), SYNC_EVERY_MS) : null;
    // Old pairing tokens and long-ended sessions, on start and daily; never the audit or the decisions (A8).
    const stopRetention = startRetention(store, Date.now,
      r => { if (r.tokens || r.sessions || r.sends) log.info(`retention: pruned ${r.tokens} pairing tokens, ${r.sessions} sessions and ${r.sends} send records`); },
      e => log.warn("retention: pruning failed; trying again tomorrow", e));
    await http.ready;                                    // report "on" only once the socket really listens
    // What already waits when the hub starts raises no Notification: one complete look first, then only changes count. A
    // look that fails, or isn't complete (the fleet not answering yet, a node's first round slower than a poll), is tried
    // again a few times, since an empty or partial first look would make everything waiting look new (review L4; N2).
    for (let i = 0; i < 5; i++) {
      try {
        const look = await observation.poll();
        escalations.poll();
        if (look.complete) break;
        log.warn(`first look failed (${i + 1} of 5): incomplete, the fleet or a node hasn't answered yet`);
      } catch (e) { log.warn(`first look failed (${i + 1} of 5)`, e); }
      await new Promise(r => setTimeout(r, 2000));
    }
    notifications.board(escalations.board().items);
    for (const w of observation.snapshot().workers) notifications.worker(w.id, w.needsYou, w.waitingOn, true);
    escalations.subscribe(b => notifications.board(b.items));
    observation.subscribe({
      events: events => {
        for (const e of events) {
          if (e.body.type === "WorkerNeedsYouChanged") notifications.worker(e.body.workerId, e.body.needsYou, e.body.waitingOn);
          else if (e.body.type === "WorkerGone") notifications.workerGone(e.body.workerId);
        }
      },
      screen: () => {}, messages: () => {}, history: () => {}, watching: () => null,
    });
    access.onLinked(() => notifications.linked());
    observation.start(config.pollMs);
    escalations.start(Math.max(config.pollMs, 1000));
    void memorySync?.tick();                             // the first round now; then the loop's, every minute
    log.info(`morndo hub on http://127.0.0.1:${config.port}, for ${config.origin} (${productVersion()})`);
    log.info(`hub identity ${formatFingerprint(identity.fingerprint)}`);
    const stop = async () => { machine.close(); transcription.close(); clearInterval(sweepInbox); if (syncMemory) clearInterval(syncMemory); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); queue?.stop(); following.projector?.stop(); board.stop(); fleet?.ports.stop(); await http.idle(); await http.close(); store.close(); memoryStore?.close(); process.exit(0); };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    break;
  }
  case "pair": {
    const { secret, token } = access.issueConsoleToken();
    const url = `${config.origin}/pair#t=${secret}&f=${identity.fingerprint}`;
    print(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
    print(`Scan with the phone's camera, or open:\n${url}\n`);
    print(`Valid until ${when(token.expiresAt)}, for one device.`);
    print(`The app must show this hub identity:\n${formatFingerprint(identity.fingerprint)}`);
    store.close();
    break;
  }
  case "devices": {
    for (const e of access.devices()) {
      print(`${e.id}  ${e.name.padEnd(20)}  paired ${when(e.pairedAt)}  last seen ${when(e.lastSeenAt)}  ${e.revokedAt ? `REVOKED ${when(e.revokedAt)}` : "active"}`);
    }
    store.close();
    break;
  }
  case "revoke": {
    const id = args[0];
    if (!id) { process.stderr.write("usage: morndo revoke <device id>\n"); process.exit(2); }
    print(access.revoke(id) ? `revoked ${id}` : `no active device ${id}`);
    store.close();
    break;
  }
  case "audit": {
    for (const a of store.audit(Number(args[0] ?? 30)).reverse()) print(`${when(a.at)}  ${a.type}  ${JSON.stringify(a.body)}`);
    store.close();
    break;
  }
  // ADR-0015: the agents' credentials for the board, issued here (the trust root), shown once, kept as a hash.
  case "agent-token": {
    const agents = new AgentAccess(store, config.managerWindow);
    const [sub, ...rest] = args;
    if (sub === "new") {
      // `--role R` and the name, in either order: the role's value is never taken as the name.
      const roleAt = rest.indexOf("--role");
      const role = roleAt >= 0 ? rest[roleAt + 1] : undefined;
      const name = rest.filter((a, i) => i !== roleAt && i !== roleAt + 1).find(a => !a.startsWith("--")) ?? "";
      if (!name || (role !== "manager" && role !== "worker")) { process.stderr.write("usage: morndo agent-token new <name> --role manager|worker\n"); store.close(); process.exit(2); }
      const { token, secret } = agents.issue(name, role);
      print(`${secret}`);
      print(`Token ${token.id} (${token.name}, ${token.role}). Shown once: put it in MORNDO_AGENT_TOKEN for ${role === "manager" ? "the manager's lane" : "the worker lanes"}, with MORNDO_HUB=${config.origin}.`);
    } else if (sub === "list") {
      for (const t of agents.list()) print(`${t.id}  ${t.name.padEnd(20)}  ${t.role.padEnd(7)}  made ${when(t.createdAt)}  last used ${when(t.lastUsedAt)}  ${t.revokedAt ? `REVOKED ${when(t.revokedAt)}` : "active"}`);
    } else if (sub === "revoke") {
      const id = rest[0];
      if (!id) { process.stderr.write("usage: morndo agent-token revoke <id>\n"); store.close(); process.exit(2); }
      print(agents.revoke(id) ? `revoked ${id}` : `no active agent token ${id}`);
    } else {
      process.stderr.write("usage: morndo agent-token new <name> --role manager|worker | list | revoke <id>\n");
      store.close();
      process.exit(2);
    }
    store.close();
    break;
  }
  // ADR-0031: Memory at the console, which acts for the principal; it opens memory.db itself (console/memory.ts).
  case "memory": {
    const code = await runMemory(args, processIo(), { dataDir: config.dataDir });
    store.close();
    process.exit(code);
  }
  default:
    print(HELP);
    store.close();
}

// The fleet adapters on MORNDO_FLEET_SOCKET (spec §10). The client API version is checked once:
// - one this hub doesn't speak is a setting to fix, said in one sentence with exit 78, like a database from the future
//   (openStore above);
// - a fleet that doesn't answer yet is only said: the observation loop keeps asking, and the hub serves meanwhile
//   (spec §7, "Fleet service down or restarting").
async function openFleet(socket: string, files: LocalFileStore, jobs: JobsService, alerts: AlertsService | null): Promise<{ ports: FleetPorts; client: FleetClient }> {
  const client = new FleetClient(socket, { log });
  const check = await checkFleet(client);
  if (check === "unsupported") {
    log.error(`the fleet service at ${socket} doesn't offer client API version ${CLIENT_API}; update morndo-fleet or this hub`);
    process.exit(EXIT_CONFIG);
  }
  if (check === "unreachable") log.warn(`the fleet service at ${socket} doesn't answer yet; the hub keeps asking`);
  const ports = fleetPorts(client, { files, jobs, ...(alerts ? { alerts } : {}), stagingDir: mkdtempSync(join(tmpdir(), "morndo-fleet-files-")) });
  await ports.start();
  return { ports, client };
}

// Memory's file (ADR-0031). One this hub can't open (a newer floor, not SQLite) is said in one sentence and leaves
// Memory off: its agent routes answer memory_off and nothing is synced, while the rest of the hub serves.
function openMemory(dir: string): MemoryStore | null {
  try { return new MemoryStore(dir); }
  catch (e) {
    if (!(e instanceof MemoryFromFuture) && !(e instanceof DatabaseUnreadable)) throw e;
    log.error(`Memory is off: ${e.message} Run the newer hub, or move ${dir}/memory.db away to start Memory empty.`);
    return null;
  }
}

function openConnections(policy: () => AccessPolicy): ConnectionsPageService | null {
  const program = process.env.MORNDO_CONNECTIONS;
  const home = process.env.MORNDO_CONNECTIONS_HOME;
  if (!program || !home) return null;
  return new ConnectionsPageService(connectionsCli(program, connectionsEnv(process.env, home)), policy);
}
