// AC5 idle limit on a Desktop tab under control (review of the F3 fix, R1): only the principal's own input counts as
// use. noVNC sends some messages by itself while a tab is open (FramebufferUpdateRequest after each update, a
// ClientFence answer to each server fence: node_modules/@novnc/novnc/core/rfb.js:2571-2573 and :2531), so those must
// not keep a session alive; key, pointer and clipboard input must. A real hub on a random port, a fake VNC server, a
// fake `now` and faked setInterval: one step stands for 30 minutes and runs the hub's 5-second check once.
// Fake passkeys as in access-service.test.ts; synthetic data only.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as netServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAY_CHOICES } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { startHttp } from "../src/adapters/http.ts";
import { AccessService } from "../src/application/access-service.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import { EscalationService } from "../src/application/escalation-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import type { Config } from "../src/config.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });   // a busy box makes the store and server slow to start

const ORIGIN = "https://hub.example.test";
const STEP = 30 * 60_000;
const START = Date.UTC(2026, 9, 1, 9);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// What noVNC sends by itself: an incremental FramebufferUpdateRequest (RFC 6143 §7.5.3) and a ClientFence answer.
const updateRequest = () => Buffer.from([3, 1, 0, 0, 0, 0, 1, 64, 0, 200]);
const fenceAnswer = () => Buffer.from([248, 0, 0, 0, 0, 0, 0, 3, 0]);
// The principal's input: a KeyEvent (§7.5.4) and a PointerEvent (§7.5.5).
const keyEvent = () => Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const pointerEvent = () => Buffer.from([5, 0, 0, 10, 0, 10]);

let dir: string;
let store: Store;
let access: AccessService;
let http: ReturnType<typeof startHttp>;
let port: number;
let vnc: { server: Server; port: number; received: () => number; socks: Set<Socket> };
let now: number;
let nextCred = 0;
let cleanups: (() => void)[];

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () => ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: 2 }),
});

// A paired device under "12h" (2 hours idle) and "only at sign-in", so control can only end by the session ending.
async function signedIn() {
  const { secret } = access.issueConsoleToken();
  const opts = await access.pairOptions(secret, "Laptop");
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  const r = await access.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(`refused: ${r.refused}`);
  const a = access.authenticate(r.cookieSecret);
  if (!a || !("policy" in access.setPolicy(a, { stay: "12h", stepUp: "signin" }))) throw new Error("setup");
  return r.cookieSecret;
}

// A VNC server with security type None that counts the bytes it receives after ClientInit.
async function fakeVnc() {
  let received = 0;
  const socks = new Set<Socket>();
  const server = netServer(sock => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    sock.write("RFB 003.008\n");
    sock.on("data", d => {
      if (stage === 3) { received += d.length; return; }
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) { buf = buf.subarray(12); sock.write(Buffer.from([1, 1])); stage = 1; }
        else if (stage === 1 && buf.length >= 1) { buf = buf.subarray(1); sock.write(Buffer.from([0, 0, 0, 0])); stage = 2; }
        else if (stage === 2 && buf.length >= 1) {                      // ClientInit -> ServerInit (320x200, "fake")
          received += buf.length - 1;
          buf = buf.subarray(1);
          const init = Buffer.alloc(28);
          init.writeUInt16BE(320, 0); init.writeUInt16BE(200, 2); init.writeUInt32BE(4, 20); init.write("fake", 24);
          sock.write(init);
          stage = 3;
        } else break;
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, received: () => received, socks };
}

function reader() {
  let buf = Buffer.alloc(0);
  const waiters: (() => void)[] = [];
  return {
    push: (d: Buffer) => { buf = Buffer.concat([buf, d]); waiters.splice(0).forEach(w => w()); },
    read: async (n: number) => { while (buf.length < n) await new Promise<void>(r => waiters.push(r)); const b = buf.subarray(0, n); buf = buf.subarray(n); return b; },
  };
}

// A browser on /api/desktop?control=1, through the RFB handshake (version, security None, ClientInit, ServerInit).
async function desktopWithControl(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/desktop?control=1`, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}` } });
  ws.binaryType = "nodebuffer";
  const r = reader();
  const socket = { ws, closed: null as number | null };
  ws.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) r.push(d); });
  ws.on("close", code => { socket.closed = code; });
  ws.on("error", () => {});
  cleanups.push(() => ws.terminate());
  await new Promise((res, rej) => { ws.once("open", res); ws.once("unexpected-response", (_q, s) => rej(new Error(`upgrade ${s.statusCode}`))); });
  expect((await r.read(12)).toString("latin1")).toBe("RFB 003.008\n");
  ws.send(Buffer.from("RFB 003.008\n"));
  expect([...(await r.read(2))]).toEqual([1, 1]);
  ws.send(Buffer.from([1]));
  expect((await r.read(4)).readUInt32BE(0)).toBe(0);
  ws.send(Buffer.from([1]));                                        // ClientInit
  const init = await r.read(24);
  await r.read(init.readUInt32BE(20));
  return socket;
}

// 30 minutes later the browser sends `messages`; once they reached the desktop (or the hub closed the socket), the
// hub's 5-second check runs once.
async function step(s: { ws: WebSocket; closed: number | null }, messages: Buffer[]) {
  now += STEP;
  const before = vnc.received();
  const bytes = messages.reduce((n, m) => n + m.length, 0);
  for (const m of messages) if (s.ws.readyState === s.ws.OPEN) s.ws.send(m);
  for (let i = 0; i < 300 && s.closed === null && vnc.received() < before + bytes; i++) await wait(10);
  vi.advanceTimersByTime(5_000);
  for (let i = 0; i < 20 && s.closed === null; i++) await wait(10);
}

const me = (cookie: string) => fetch(`http://127.0.0.1:${port}/api/me`, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}` } });

beforeEach(async () => {
  cleanups = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "morndo-desktop-idle-"));
  store = new Store(dir);
  vnc = await fakeVnc();
  now = START;
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, managerInbox: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  access = new AccessService(store, fakePasskeys(), () => now);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }), policy: () => access.policy(),
  });
  const remote = new RemoteService({
    store, now: () => now, policy: () => access.policy(), panes: () => [],
    terminal: { frame: async () => null, keys: async () => false },
    desktop: () => ({ host: "127.0.0.1", port: vnc.port, password: null }),
  });
  http = startHttp({
    config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000),
    steering: new SteeringService(store, tmux, () => now, () => access.policy()), escalations, remote,
  });
  await http.ready;
  port = (http.server.address() as AddressInfo).port;
});
afterEach(async () => {
  cleanups.forEach(c => c());
  await http.close();
  await wait(50);
  vi.useRealTimers();
  vnc.socks.forEach(s => s.destroy());
  await new Promise(r => vnc.server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a Desktop tab under control counts only the principal's input as use (AC5)", () => {
  it("the browser's own update requests and fence answers don't keep the session alive: it ends after 2 hours", async () => {
    const cookie = await signedIn();
    const desk = await desktopWithControl(cookie);
    for (let t = 0; t < 6 * 60 * 60_000 && desk.closed === null; t += STEP) await step(desk, [updateRequest(), fenceAnswer()]);
    expect(now - START).toBeLessThan(STAY_CHOICES["12h"].absolute);   // only the idle limit can have ended it
    expect({ closed: desk.closed, hoursOpen: (now - START) / 3_600_000 }).toMatchObject({ closed: 4401 });
    expect((await me(cookie)).status).toBe(401);
  });
  it("keys and pointer moves do count as use: after 6 hours of them the session and the control still hold", async () => {
    const cookie = await signedIn();
    const desk = await desktopWithControl(cookie);
    for (let i = 0; i < 12; i++) await step(desk, [i % 2 ? keyEvent() : pointerEvent(), updateRequest()]);
    expect(desk.closed).toBeNull();
    expect((await me(cookie)).status).toBe(200);
  });
});
