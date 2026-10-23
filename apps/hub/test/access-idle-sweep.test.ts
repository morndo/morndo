// AC5 idle limit with a tab left open (F8): the hub's own socket sweeps re-check each connection's session; a check
// is not use, so under "12h" (2 hours idle) an open but unused feed or terminal socket is cut once 2 hours pass.
// Real server on a random port; only setInterval is faked, so each sweep runs exactly when the test advances it, and
// the hub's clock is a fake `now`. One sweep stands for 30 minutes: rarer than the real 15 s / 5 s, so a session that
// survives here survives in production too. Fake passkeys as in access-service.test.ts; synthetic data only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAY_CHOICES } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { startHttp } from "../src/adapters/http.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { AccessService } from "../src/application/access-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Config } from "../src/config.ts";

const LOGIN = "principal@example.test";
const ORIGIN = "https://hub.example.test";
const STEP = 30 * 60_000;
let dir: string;
let store: Store;
let now: number;
let nextCred: number;
let access: AccessService;
let http: Awaited<ReturnType<typeof startHttp>>;
let port: number;

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () => ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: 2 }),
});

// A paired device under the "12h" choice (tightening needs no check).
async function signedIn12h() {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, "Laptop");
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  const r = await access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(`refused: ${r.refused}`);
  const a = access.authenticate(r.cookieSecret);
  if (!a || !("policy" in access.setPolicy(a, { stay: "12h", stepUp: "1h" }))) throw new Error("setup");
  return r.cookieSecret;
}

const headers = (cookie: string) => ({ "tailscale-user-login": LOGIN, origin: ORIGIN, cookie: `__Host-morndo=${cookie}` });

function connect(path: string, cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: headers(cookie) });
  const socket = { ws, closed: null as number | null };
  ws.on("close", code => { socket.closed = code; });
  return new Promise<typeof socket>((resolve, reject) => { ws.once("open", () => resolve(socket)); ws.once("unexpected-response", (_q, res) => reject(new Error(`upgrade refused: ${res.statusCode}`))); });
}

// A protocol-level ping from the client, answered by the server's ws itself (never a message the hub reads as use):
// once its pong is back, the server has handled everything sent before it, including our pong to its sweep's ping.
// Resolves early if the hub closed the socket.
const roundTrip = (ws: WebSocket): Promise<void> => {
  if (ws.readyState !== ws.OPEN) return Promise.resolve();
  ws.ping();
  return first(ws, "pong");
};

// The first of `event` or the socket's close, with both listeners removed afterwards.
const first = (ws: WebSocket, event: "ping" | "pong") => new Promise<void>(resolve => {
  const done = () => { ws.off(event, done); ws.off("close", done); resolve(); };
  ws.on(event, done);
  ws.on("close", done);
});

// One sweep period: `ms` of timers, STEP of the hub's clock. Waits for the feed sweep's own ping when it sends one.
async function sweep(ws: WebSocket, ms: number) {
  now += STEP;
  const pinged = ms === 15_000 ? first(ws, "ping") : Promise.resolve();
  vi.advanceTimersByTime(ms);
  await pinged;
  await roundTrip(ws);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "morndo-idle-sweep-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  store = new Store(dir);
  now = Date.UTC(2026, 9, 1, 9, 0, 0);
  nextCred = 0;
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: true, principalLogin: LOGIN, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 1000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  access = new AccessService(store, fakePasskeys(), () => now);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), policy: () => access.policy(),
  });
  const frame = { cols: 80, rows: 24, x: 0, y: 0, cursor: true, lines: ["$ "] };
  const remote = new RemoteService({
    store, terminal: { frame: async () => frame, keys: async () => false }, panes: () => ["%1"], desktop: () => null,
    policy: () => access.policy(), now: () => now,
  });
  http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, store, observation: new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, () => now, () => access.policy()), escalations, remote,
  });
  await http.ready;
  port = (http.server.address() as AddressInfo).port;
}, 20_000);                                    // starting a server can take a while on a loaded box
afterEach(async () => {
  await http.close();
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("an open but unused socket doesn't keep a session alive (AC5)", () => {
  it("the feed socket is cut after 2 hours without use under 12h, and the session is gone", async () => {
    const cookie = await signedIn12h();
    const feed = await connect("/api/feed", cookie);
    feed.ws.send(JSON.stringify({ t: "hello" }));             // what the app sends on open; nothing after that
    await roundTrip(feed.ws);
    for (let t = 0; t < 6 * 60 * 60_000 && feed.closed === null; t += STEP) await sweep(feed.ws, 15_000);
    expect(now - Date.UTC(2026, 9, 1, 9, 0, 0)).toBeLessThan(STAY_CHOICES["12h"].absolute);   // only the idle limit applies
    expect(feed.closed).toBe(4401);
    const me = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: headers(cookie) });
    expect(me.status).toBe(401);
  });
  it("a terminal socket that only watches is cut after 2 hours without use under 12h", async () => {
    const cookie = await signedIn12h();
    const term = await connect("/api/terminal?pane=%251", cookie);
    await roundTrip(term.ws);
    for (let t = 0; t < 6 * 60 * 60_000 && term.closed === null; t += STEP) await sweep(term.ws, 5_000);
    expect(term.closed).toBe(4401);
    const me = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: headers(cookie) });
    expect(me.status).toBe(401);
  });
});
