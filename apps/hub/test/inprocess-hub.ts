// A real hub HTTP server (startHttp) in this process, on a random port, with fake passkeys, a temp data dir, no tmux,
// and a synthetic terminal for pane %1. For tests that need the HTTP and WebSocket edges but no crash isolation
// (crash tests use http-crash-fixture.ts). Synthetic data only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AccountProfile, Task } from "@morndo/domain";
import type { RunView, Transcriber, TranscriberProbe } from "@morndo/protocol";
import type { Liveness } from "@morndo/domain";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, type ClientOptions } from "ws";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity, type HubIdentity } from "../src/adapters/identity.ts";
import { principalSigner } from "../src/adapters/principal-signer.ts";
import { UpdatesService } from "../src/application/updates-service.ts";
import type { FleetForUpdates, UpdaterCli } from "../src/application/updates-ports.ts";
import { startHttp, type Limits } from "../src/adapters/http.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { uploadInbox } from "../src/adapters/uploads.ts";
import { AccessService } from "../src/application/access-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { AlertsService } from "../src/application/alerts-service.ts";
import { EscalationService, type Watch } from "../src/application/escalation-service.ts";
import { BriefService } from "../src/application/brief-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { ReadingService } from "../src/application/reading-service.ts";
import { PresenceService } from "../src/application/presence-service.ts";
import { NotificationService } from "../src/application/notification-service.ts";
import { loadOrCreateVapid } from "../src/adapters/webpush.ts";
import { enginesCli } from "../src/adapters/engines-cli.ts";
import { EnginesService } from "../src/application/engines-service.ts";
import { BoardService } from "../src/application/board-service.ts";
import { ProofService } from "../src/application/proof-service.ts";
import { AgentAccess } from "../src/application/agent-access.ts";
import { UsageService } from "../src/application/usage-service.ts";
import { JobsService } from "../src/application/jobs-service.ts";
import { fileOnDisk, TranscriptionService } from "../src/application/transcription-service.ts";
import type { LedgerRead } from "../src/adapters/ledger.ts";
import type { SendOutcome } from "../src/application/ports.ts";
import type { Config } from "../src/config.ts";
import type { ManagerQueue } from "../src/application/manager-queue.ts";
import { productStamp } from "@morndo/service-kit";

export const ORIGIN = "https://hub.example.test";

export type InProcessHub = {
  base: string; store: Store; access: AccessService; dir: string; identity: HubIdentity;
  notifications: NotificationService;
  board: BoardService;
  proof: ProofService;
  agents: AgentAccess;
  briefs: BriefService;
  escalations: EscalationService;
  usage: UsageService;
  jobs: JobsService;
  pushes: { endpoint: string; payload: unknown }[];             // what the fake push sender was given
  cookie(): Promise<string>;                                   // a freshly paired device's session secret
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  socket(path: string, cookie: string, options?: ClientOptions): Promise<WebSocket>;
  close(): Promise<void>;
};

// `now`: the hub's clock for access and rate limits (a test moves it to expire tokens, requests and verifications).
// `profiles`: the account-label source the usage view overlays (a test's own, over a fake pool file; default none).
// `observation`: the service the feed reads from, when a test needs its own (default: one over an empty tmux).
// `engines`: the engine layer's CLI to run (a test's fake) and its environment; absent, the Engines page is off.
// `queue`: the manager's delivery queue, made on the hub's own store (fleet-clients §9.1; default none). This hub has no
// manager pane: a test puts deliveries on the queue itself, and the feed and the cancel route follow them.
// `steering`: the service the send routes use, when a test wires its own (over a fleet rig); default: the hub's own,
// over this hub's empty tmux.
// `watch`, `ledger`, `send`: what the escalation service sees and how it types an answer (a test's own; default none).
// `runs`: each lane's Run the board frame carries (ADR-0032; default none), as the projector would hold them.
// `orphans`: the to do tasks the board frame flags as waiting for a lane the fleet no longer lists (B2; default none),
// as the projector would flag them.
export async function startInProcessHub(o: {
  limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService;
  profiles?: () => ReadonlyMap<string, AccountProfile>;
  engines?: { bin: string; env: NodeJS.ProcessEnv }; transcriber?: Transcriber | null;
  locate?: () => { transcriber: Transcriber | null; unavailable: TranscriberProbe | null } | null;
  queue?: (store: Store) => ManagerQueue; manager?: string; typed?: string[]; alerts?: AlertsService;
  steering?: (store: Store) => SteeringService;
  watch?: Watch; ledger?: (() => LedgerRead) | null;
  send?: (pane: string, text: string, key: string) => Promise<SendOutcome>;
  runs?: () => RunView[];
  liveness?: (sha: string) => Liveness;
  knows?: (sha: string) => Promise<"yes" | "no" | "unknown">;
  orphans?: (tasks: readonly Task[], now: number) => string[];
  // `identity`: the hub's identity key (a test's own pair; default: one made in the temp dir) — it signs the
  // principal's assertions (updates §5.4). `updates`: the fleet and the updater CLI to run (a test's fakes); absent,
  // the updates routes answer 404 as with no fleet and no CLI wired.
  identity?: HubIdentity;
  updates?: { fleet: FleetForUpdates; cli: UpdaterCli };
} = {}): Promise<InProcessHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-inproc-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  const store = new Store(dir);
  // No identity required, so callers can differ by header; the gate itself is tested elsewhere.
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, poolUsageFile: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  let n = 0;
  const passkeys: Passkeys = {
    registrationOptions: async () => ({ challenge: `reg-${++n}` }) as never,
    verifyRegistration: async () => ({ credential: { id: `cred-${++n}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
    authenticationOptions: async () => ({ challenge: `auth-${++n}` }) as never,
    verifyAuthentication: async () => ({ userVerified: true, newCounter: ++n }),
  };
  const access = new AccessService(store, passkeys, o.now);
  // `manager`: the manager's window, if it has one; `typed`: each pane a send typed into, in order.
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async (pane: string) => { o.typed?.push(pane); return { problem: null, typedAt: Date.now() }; } };
  const watch: Watch = o.watch ?? { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined };
  const filed: { briefs: BriefService | null } = { briefs: null };
  const escalations = new EscalationService({
    watch, ledger: o.ledger === undefined ? null : o.ledger, store, managerName: "manager",
    send: o.send ?? (async () => ({ problem: null, typedAt: 0 })),
    ...(o.now ? { now: o.now } : {}),
    briefs: () => filed.briefs?.sightings() ?? [],
  });
  const briefs = new BriefService({
    store, escalations, managerName: "manager", hasLedger: o.ledger != null, ...(o.now ? { now: o.now } : {}),
    managerWorkerId: () => {
      const named = watch.workers().filter(w => w.name === "manager");
      return named.some(w => w.conflict) ? null : named[0]?.id ?? null;
    },
  });
  filed.briefs = briefs;
  const frame = { cols: 80, rows: 24, x: 0, y: 0, cursor: true, lines: ["$ "] };
  const remote = new RemoteService({ store, terminal: { frame: async () => frame, keys: async () => true }, panes: () => ["%1"], desktop: () => null });
  const inbox = uploadInbox({ dir: join(dir, "inbox") });
  const pushes: { endpoint: string; payload: unknown }[] = [];
  const notifications = new NotificationService({
    store, ...(o.now ? { now: o.now } : {}),
    send: async (s, payload) => { pushes.push({ endpoint: s.endpoint, payload: JSON.parse(payload.toString()) as unknown }); return { status: 201 }; },
  });
  notifications.board([]);
  access.onLinked(() => notifications.linked());
  const vapid = loadOrCreateVapid(dir, "mailto:test@example.test");
  // ADR-0015: the board, with the lanes a test's observation lists (none by default). `liveness`: a merge's liveness as
  // the fleet's builds would tell it (B11); without one the hub can never say a merge is live.
  const board = new BoardService({ store, policy: () => access.policy(), ...(o.now ? { now: o.now } : {}), lanes: () => (o.observation?.snapshot().workers ?? []).map(w => w.name), ...(o.runs ? { runs: o.runs } : {}), ...(o.orphans ? { orphans: o.orphans } : {}), ...(o.liveness ? { liveness: o.liveness } : {}), ...(o.knows ? { knows: o.knows } : {}) });
  // ADR-0035: the proof of work, over the same store, wired as main.ts wires it.
  const proof = new ProofService({ store, board, ...(o.now ? { now: o.now } : {}) });
  const agents = new AgentAccess(store, "manager", o.now);
  const usage = new UsageService({ store, ...(o.now ? { now: o.now } : {}), ...(o.profiles ? { profiles: o.profiles } : {}) });
  const queue = o.queue ? o.queue(store) : null;
  const jobs = new JobsService({ store, board, ...(o.now ? { now: o.now } : {}) });
  // Wired as production main.ts wires it: the service is always constructed, with the plugin's answer when there is
  // none (the routes must answer for that shape, not only for a null port).
  const txHost = o.transcriber ?? null;
  const transcription = new TranscriptionService({
    store, transcriber: txHost,
    unavailable: txHost || o.locate ? null : { ready: false, reason: "missing", detail: "missing" },
    ...(o.locate ? { locate: o.locate } : {}),
    probeTtlMs: 0, log: () => {},
    file: (recording, caller) => {
      const upload = inbox.get(recording.id);
      if (!upload || (caller && upload.endpointId !== caller.endpointId)) return null;
      return fileOnDisk(upload.path);
    },
  });
  await transcription.start();
  const identity = o.identity ?? loadOrCreateIdentity(dir);
  const http = startHttp({
    config, identity, access, store, observation: o.observation ?? new ObservationService(tmux, 1000),
    steering: o.steering ? o.steering(store) : new SteeringService(store, tmux, o.now ?? Date.now, () => access.policy(), inbox, undefined, undefined, undefined, null,
      queue ? { queue, isManager: id => id === o.manager } : null, () => o.manager ?? null),
    escalations, remote, inbox, reading: new ReadingService(store), presence: new PresenceService(store, o.now), queue, ...(o.alerts ? { alerts: o.alerts } : {}),
    push: { publicKey: vapid.publicKey, notifications },
    board: { service: board, agents, proof }, usage, jobs, briefs,
    engines: o.engines ? new EnginesService({ cli: enginesCli(o.engines.bin, o.engines.env), store, policy: () => access.policy(), ...(o.now ? { now: o.now } : {}) }) : null,
    updatesService: o.updates ? new UpdatesService({
      fleet: o.updates.fleet, cli: o.updates.cli, sign: principalSigner(identity), store,
      policy: () => access.policy(), ...(o.now ? { now: o.now } : {}),
      build: () => { const s = productStamp(); return { version: s.version, commit: s.commit ?? null }; },
    }) : null,
    transcription,
    ...(o.limits ? { limits: o.limits } : {}), ...(o.heartbeatMs ? { heartbeatMs: o.heartbeatMs } : {}), ...(o.now ? { now: o.now } : {}),
  });
  await http.ready;
  const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  return {
    base, store, access, dir, identity, notifications, board, proof, agents, briefs, escalations, usage, jobs, pushes,
    async cookie() {
      const opts = await access.pairOptions(access.issueConsoleToken().secret, "phone");
      if (!("flowId" in opts)) throw new Error(opts.refused);
      const r = await access.pairVerify(opts.flowId, {} as never);
      if (!("cookieSecret" in r)) throw new Error(r.refused);
      return r.cookieSecret;
    },
    post: (path, body, headers = {}) => fetch(base + path, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    }),
    socket: (path, cookie, options = {}) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + path, { ...options, headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}` } });
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", (_q, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
      ws.on("error", () => {});
    }),
    close: async () => { transcription.close(); notifications.stop(); board.stop(); await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
