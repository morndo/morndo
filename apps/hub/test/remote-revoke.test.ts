// Revoking a device (AC4) and control lapsing (AC9) must stop its terminal and desktop sockets, not only its feed:
// a real hub (startHttp) on a random port, a fake passkey adapter, and a fake VNC server that records the keys it gets.
// The hub's periodic checks run on faked setInterval, so nothing here waits on (or is saved by) a 5-second sweep
// unless a test advances it on purpose.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer as netServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const ORIGIN = "https://hub.example.test";
const KEY_A = 0x61;                                     // sent before the revocation
const KEY_Z = 0x7a;                                     // sent after it: must never reach the desktop
const GRACE_MS = 50;                                    // in-flight allowance after the revocation
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const keyEvent = (keysym: number) => { const b = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0]); b.writeUInt32BE(keysym, 4); return b; };

let dir: string;
let store: Store;
let access: AccessService;
let http: ReturnType<typeof startHttp>;
let port: number;
let vnc: { server: Server; port: number; keys: number[]; socks: Set<Socket> };
let cleanups: (() => void)[];
let nextCred = 0;
const now = Date.UTC(2026, 9, 1, 9);

const fakePasskeys = (): Passkeys => ({
  registrationOptions: async () => ({ challenge: `reg-${Math.random()}` }) as never,
  verifyRegistration: async () => ({ credential: { id: `cred-${++nextCred}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
  authenticationOptions: async () => ({ challenge: `auth-${Math.random()}` }) as never,
  verifyAuthentication: async () => ({ userVerified: true, newCounter: 2 }),
});

async function pairDevice(a: AccessService) {
  const { secret } = a.issueConsoleToken();
  const opts = await a.pairOptions(secret, "Phone");
  if (!("flowId" in opts)) throw new Error(`refused: ${opts.refused}`);
  const r = await a.pairVerify(opts.flowId, {} as never);
  if (!("cookieSecret" in r)) throw new Error(`refused: ${r.refused}`);
  return { cookie: r.cookieSecret, id: r.endpoint.id as string };
}

// A VNC server with security type None that records the keysym of every KeyEvent it receives after ClientInit.
async function fakeVnc() {
  const keys: number[] = [];
  const socks = new Set<Socket>();
  const server = netServer(sock => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    sock.write("RFB 003.008\n");
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 0 && buf.length >= 12) { buf = buf.subarray(12); sock.write(Buffer.from([1, 1])); stage = 1; }
        else if (stage === 1 && buf.length >= 1) { buf = buf.subarray(1); sock.write(Buffer.from([0, 0, 0, 0])); stage = 2; }
        else if (stage === 2 && buf.length >= 1) {                      // ClientInit -> ServerInit (320x200, "fake")
          buf = buf.subarray(1);
          const init = Buffer.alloc(28);
          init.writeUInt16BE(320, 0); init.writeUInt16BE(200, 2); init.writeUInt32BE(4, 20); init.write("fake", 24);
          sock.write(init);
          stage = 3;
        } else if (stage === 3 && buf.length >= 8 && buf[0] === 4) { keys.push(buf.readUInt32BE(4)); buf = buf.subarray(8); }
        else break;
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, keys, socks };
}

type Peer = { read: (n: number) => Promise<Buffer>; send: (b: Buffer) => void; isOpen: () => boolean; closed: Promise<number> };

// The browser's side of the RFB handshake through the hub (version, security None, ClientInit, ServerInit).
async function rfbHandshake(p: Peer) {
  expect((await p.read(12)).toString("latin1")).toBe("RFB 003.008\n");
  p.send(Buffer.from("RFB 003.008\n"));
  expect([...(await p.read(2))]).toEqual([1, 1]);
  p.send(Buffer.from([1]));
  expect((await p.read(4)).readUInt32BE(0)).toBe(0);
  p.send(Buffer.from([1]));
  const init = await p.read(24);
  await p.read(init.readUInt32BE(20));
}

function reader() {
  let buf = Buffer.alloc(0);
  const waiters: (() => void)[] = [];
  return {
    push: (d: Buffer) => { buf = Buffer.concat([buf, d]); waiters.splice(0).forEach(w => w()); },
    read: async (n: number) => { while (buf.length < n) await new Promise<void>(r => waiters.push(r)); const b = buf.subarray(0, n); buf = buf.subarray(n); return b; },
  };
}

// A browser-like client: the ws library, which answers the hub's close frame as a browser does.
async function browser(path: string, cookie: string): Promise<Peer & { ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${cookie}` } });
  ws.binaryType = "nodebuffer";
  const r = reader();
  ws.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) r.push(d); });
  ws.on("error", () => {});
  const closed = new Promise<number>(res => ws.once("close", code => res(code)));
  cleanups.push(() => ws.terminate());
  await new Promise((res, rej) => { ws.once("open", res); ws.once("unexpected-response", (_q, s) => rej(new Error(`upgrade ${s.statusCode}`))); });
  return { ws, read: r.read, send: b => ws.send(b), isOpen: () => ws.readyState === ws.OPEN, closed };
}

// A client that ignores the hub's close frame and keeps sending, over a raw TCP socket (RFC 6455 framing by hand).
async function stubborn(path: string, cookie: string): Promise<Peer & { closeCodes: number[] }> {
  const sock = connect(port, "127.0.0.1");
  sock.on("error", () => {});
  cleanups.push(() => sock.destroy());
  await new Promise(r => sock.once("connect", r));
  sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\nCookie: __Host-morndo=${cookie}\r\n\r\n`);
  const r = reader();
  const closeCodes: number[] = [];
  let raw = Buffer.alloc(0);
  let upgraded = false;
  let tcpOpen = true;
  const closed = new Promise<number>(res => sock.once("close", () => { tcpOpen = false; res(1006); }));
  sock.on("data", d => {
    raw = Buffer.concat([raw, d]);
    if (!upgraded) {
      const end = raw.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!raw.subarray(0, end).toString("latin1").startsWith("HTTP/1.1 101")) throw new Error(`upgrade refused: ${raw.subarray(0, end).toString("latin1")}`);
      raw = raw.subarray(end + 4);
      upgraded = true;
    }
    for (;;) {
      if (raw.length < 2) return;
      const op = (raw[0] ?? 0) & 0x0f;
      let len = (raw[1] ?? 0) & 0x7f;
      let off = 2;
      if (len === 126) { if (raw.length < 4) return; len = raw.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (raw.length < 10) return; len = Number(raw.readBigUInt64BE(2)); off = 10; }
      if (raw.length < off + len) return;
      const payload = raw.subarray(off, off + len);
      raw = raw.subarray(off + len);
      if (op === 8) closeCodes.push(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);   // ignored: no reply
      else if (op === 2 || op === 0) r.push(payload);
    }
  });
  const send = (b: Buffer) => {
    const mask = randomBytes(4);
    const head = b.length < 126 ? Buffer.from([0x82, 0x80 | b.length]) : Buffer.from([0x82, 0x80 | 126, b.length >> 8, b.length & 255]);
    sock.write(Buffer.concat([head, mask, Buffer.from(b.map((x, i) => x ^ (mask[i % 4] ?? 0)))]));
  };
  return { read: r.read, send, isOpen: () => tcpOpen, closed, closeCodes };
}

// Connects with control, proves that input reaches the desktop, and returns the client.
async function controlling<P extends Peer>(open: () => Promise<P>): Promise<P> {
  const p = await open();
  await rfbHandshake(p);
  p.send(keyEvent(KEY_A));
  for (let i = 0; i < 200 && !vnc.keys.includes(KEY_A); i++) await wait(10);
  expect(vnc.keys).toContain(KEY_A);                    // negative control: control input does pass while allowed
  return p;
}

// After `revoked` and a short grace, the client keeps pressing "z" for 300 ms while its socket is open.
async function pressAfter(p: Peer) {
  await wait(GRACE_MS);
  let sent = 0;
  for (let i = 0; i < 30 && p.isOpen(); i++) { p.send(keyEvent(KEY_Z)); sent++; await wait(10); }
  await wait(100);
  return sent;
}

beforeEach(async () => {
  cleanups = [];
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dir = mkdtempSync(join(tmpdir(), "morndo-revoke-"));
  store = new Store(dir);
  vnc = await fakeVnc();
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo",
    requireProxyIdentity: false, principalLogin: null, tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: join(dir, "web"), officeName: null,
    pollMs: 1000, quietAfterMs: 1000, managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null,
    filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
  };
  access = new AccessService(store, fakePasskeys(), () => now);
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
  const escalations = new EscalationService({
    watch: { workers: () => [], history: () => [], openQuestions: () => [], screen: () => undefined },
    ledger: null, store, managerName: "manager", send: async () => ({ problem: null, typedAt: 0 }),
  });
  const frame = { cols: 80, rows: 24, x: 0, y: 0, cursor: true, lines: ["$ "] };
  const remote = new RemoteService({
    store, now: () => now, policy: () => access.policy(), panes: () => ["%1"],
    terminal: { frame: async () => frame, keys: async () => true },
    desktop: () => ({ host: "127.0.0.1", port: vnc.port, password: null }),
  });
  http = startHttp({ config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000), steering: new SteeringService(store, tmux), escalations, remote });
  await http.ready;
  port = (http.server.address() as AddressInfo).port;
});
afterEach(async () => {
  cleanups.forEach(c => c());
  await http.close();
  await wait(100);                                      // the sockets' close handlers record ControlEnded first
  vi.useRealTimers();
  vnc.socks.forEach(s => s.destroy());
  await new Promise(r => vnc.server.close(r));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("revoking a device ends its terminal and desktop connections at once (AC4)", () => {
  it("a browser with desktop control: nothing it sends after the revocation reaches the desktop, and its socket closes", async () => {
    const device = await pairDevice(access);
    const b = await controlling(() => browser("/api/desktop?control=1", device.cookie));
    expect(access.revoke(device.id)).toBe(true);
    const sent = await pressAfter(b);
    const code = await Promise.race([b.closed, wait(2000).then(() => "still open")]);
    expect({ zKeysAtDesktop: vnc.keys.filter(k => k === KEY_Z).length, sent, code }).toMatchObject({ zKeysAtDesktop: 0 });
    expect(code).not.toBe("still open");
  });

  it("a client that ignores the close frame: nothing it sends after the revocation reaches the desktop", async () => {
    const device = await pairDevice(access);
    const c = await controlling(() => stubborn("/api/desktop?control=1", device.cookie));
    expect(access.revoke(device.id)).toBe(true);
    const sent = await pressAfter(c);
    expect({ zKeysAtDesktop: vnc.keys.filter(k => k === KEY_Z).length, sent }).toMatchObject({ zKeysAtDesktop: 0 });
  });

  it("a terminal being watched closes", async () => {
    const device = await pairDevice(access);
    const b = await browser("/api/terminal?pane=%251", device.cookie);
    expect(access.revoke(device.id)).toBe(true);
    expect(await Promise.race([b.closed, wait(2000).then(() => "still open")])).not.toBe("still open");
  });
});

describe("control from a device revoked in the console (another process) ends at the hub's 5-second check (AC9, ADR-0006)", () => {
  it("once the hub's check has closed the connection, a client that ignores the close frame gets no more input to the desktop", async () => {
    const device = await pairDevice(access);
    const c = await controlling(() => stubborn("/api/desktop?control=1", device.cookie));
    // `morndo revoke` builds its own Store and AccessService on the same data dir; the hub's onRevoked never hears of it.
    const consoleStore = new Store(dir);
    try { expect(new AccessService(consoleStore, fakePasskeys(), () => now).revoke(device.id)).toBe(true); }
    finally { consoleStore.close(); }
    vi.advanceTimersByTime(5000);                         // the hub's periodic check (http.ts remoteSweep)
    for (let i = 0; i < 200 && !c.closeCodes.length; i++) await wait(10);
    expect(c.closeCodes).toEqual([4401]);                // the hub did decide the session ended...
    const sent = await pressAfter(c);
    expect({ zKeysAtDesktop: vnc.keys.filter(k => k === KEY_Z).length, sent }).toMatchObject({ zKeysAtDesktop: 0 });   // ...yet input flows
  });
});
