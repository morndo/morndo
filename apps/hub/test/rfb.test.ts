// The desktop bridge against a real, private TigerVNC server (its own display, port and password; the box's shared
// desktop is never touched), and the watching filter on hand-made messages.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeDesktop, filterWatching, loginToServer, readVncPassword, vncAuthResponse } from "../src/adapters/rfb.ts";

const dir = mkdtempSync(join(tmpdir(), "morndo-rfb-"));
const passFile = join(dir, "passwd");
const PASSWORD = "s3cret!x";
let vnc: ChildProcess | null = null;
let port = 0;
const freePort = () => new Promise<number>(r => { const s = netServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)); }); });
const SERVER_READY_MS = 90_000;
const have = existsSync("/usr/bin/Xtigervnc") && existsSync("/usr/bin/vncpasswd");

beforeAll(async () => {
  if (!have) return;
  writeFileSync(passFile, execFileSync("vncpasswd", ["-f"], { input: `${PASSWORD}\n` }));
  port = await freePort();
  let display = 140 + (process.pid % 50);
  while (existsSync(`/tmp/.X11-unix/X${display}`) || existsSync(`/tmp/.X${display}-lock`)) display++;
  let gone: string | null = null;
  vnc = spawn("Xtigervnc", [`:${display}`, "-rfbport", String(port), "-localhost=1", "-SecurityTypes", "VncAuth", "-PasswordFile", passFile, "-geometry", "320x200", "-AlwaysShared=1"], { stdio: "ignore" });
  vnc.once("exit", (code, signal) => { gone = `Xtigervnc ended before it was ready (exit ${code}, signal ${signal})`; });
  // Ready is a real login that answers, not a fixed number of tries: a cold start of the server (its files read behind busy
  // disks, a box at load 70) took longer than the 5 s the old poll gave it, and the tests then ran against a closed port.
  // The deadline only ends a server that never comes up, and says so.
  const deadline = Date.now() + SERVER_READY_MS;
  for (;;) {
    if (gone !== null) throw new Error(gone);
    try {
      const { sock } = await loginToServer({ host: "127.0.0.1", port, password: PASSWORD }, 10_000);
      sock.destroy();
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`Xtigervnc on port ${port} did not answer a login within ${SERVER_READY_MS / 1000} s: ${(error as Error).message}`);
      await new Promise(r => setTimeout(r, 250));
    }
  }
}, SERVER_READY_MS + 15_000);
afterAll(() => { vnc?.kill("SIGTERM"); rmSync(dir, { recursive: true, force: true }); });

describe("VNC's DES", () => {
  it("reads the password back from a file vncpasswd wrote", () => {
    if (!have) return;
    expect(readVncPassword(passFile)).toBe(PASSWORD);
  });
  it("answers a challenge with mirrored-key DES (a known pair from the RFB literature's test: zero key, zero block)", () => {
    // With an all-zero key, mirroring changes nothing, so this is plain DES(0, 0) = 8ca64de9c1b123a7 (FIPS 81 style vector).
    expect(vncAuthResponse("", Buffer.alloc(8)).toString("hex")).toBe("8ca64de9c1b123a7");
  });
});

describe("logging in to a real TigerVNC server", () => {
  it("logs in with the right password and receives ServerInit after ClientInit", async () => {
    if (!have) return;
    const { sock, reader } = await loginToServer({ host: "127.0.0.1", port, password: PASSWORD });
    sock.write(Buffer.from([1]));
    const init = await reader.read(24);
    expect([init.readUInt16BE(0), init.readUInt16BE(2)]).toEqual([320, 200]);
    sock.destroy();
  });
  it("is refused with a wrong password (negative control)", async () => {
    if (!have) return;
    await expect(loginToServer({ host: "127.0.0.1", port, password: "wrong" })).rejects.toThrow(/refused/);
  });
});

describe("the watching filter", () => {
  const msg = (...bytes: number[]) => Buffer.from(bytes);
  const fbRequest = msg(3, 1, 0, 0, 0, 0, 1, 64, 0, 200);
  it("forwards messages that only shape what is received, and keeps an incomplete one for later", () => {
    const encodings = msg(2, 0, 0, 2, 0, 0, 0, 7, 0xff, 0xff, 0xff, 0x21);
    const f = filterWatching(Buffer.concat([encodings, fbRequest, fbRequest.subarray(0, 4)]));
    expect(f.refused).toBeNull();
    expect(f.forward.length).toBe(encodings.length + fbRequest.length);
    expect(f.rest.length).toBe(4);
  });
  it("refuses keys, pointer, resizing and power", () => {
    for (const type of [4, 5, 251, 255, 250]) expect(filterWatching(Buffer.concat([fbRequest, msg(type, 0, 0, 0, 0, 0, 0, 0)])).refused).toBe(type);
  });
  it("drops clipboard, plain or noVNC's extended announcement, and keeps going (seen from noVNC 1.7 on connect)", () => {
    const caps = msg(6, 0, 0, 0, 0xff, 0xff, 0xff, 0xf8, 0x1f, 0, 0, 1, 0, 0, 0, 0);   // length -8: extended clipboard caps
    const text = msg(6, 0, 0, 0, 0, 0, 0, 2, 0x68, 0x69);
    const f = filterWatching(Buffer.concat([caps, fbRequest, text, fbRequest]));
    expect(f.refused).toBeNull();
    expect(f.forward).toEqual(Buffer.concat([fbRequest, fbRequest]));
    expect(f.rest.length).toBe(0);
  });
});

describe("the bridge, browser side", () => {
  // A minimal browser: RFB 3.8, security None, ClientInit; returns the socket and ServerInit's size.
  async function browser(url: string) {
    const ws = new WebSocket(url);
    ws.binaryType = "nodebuffer";
    let buf = Buffer.alloc(0);
    const waiters: (() => void)[] = [];
    ws.on("message", (d: Buffer) => { buf = Buffer.concat([buf, d]); waiters.splice(0).forEach(w => w()); });
    const read = async (n: number) => { while (buf.length < n) await new Promise<void>(r => waiters.push(r)); const b = buf.subarray(0, n); buf = buf.subarray(n); return b; };
    await new Promise(r => ws.once("open", r));
    expect((await read(12)).toString()).toBe("RFB 003.008\n");
    ws.send(Buffer.from("RFB 003.008\n"));
    expect([...(await read(2))]).toEqual([1, 1]);
    ws.send(Buffer.from([1]));
    expect((await read(4)).readUInt32BE(0)).toBe(0);
    ws.send(Buffer.from([1]));
    const init = await read(24);
    const closed = new Promise<number>(r => ws.once("close", code => r(code)));
    await read(init.readUInt32BE(20));                                // the desktop's name
    return { ws, size: [init.readUInt16BE(0), init.readUInt16BE(2)], closed, read };
  }
  async function hub(control: boolean) {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", ws => void bridgeDesktop(ws, { host: "127.0.0.1", port, password: PASSWORD }, control, () => {}));
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, stop: () => { wss.close(); server.close(); } };
  }
  it("a watching browser sees the desktop, and its first key press ends the connection", async () => {
    if (!have) return;
    const h = await hub(false);
    const b = await browser(h.url);
    expect(b.size).toEqual([320, 200]);
    b.ws.send(Buffer.from([6, 0, 0, 0, 0xff, 0xff, 0xff, 0xf8, 0x1f, 0, 0, 1, 0, 0, 0, 0]));   // noVNC's clipboard announcement: dropped
    b.ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 1, 64, 0, 200]));         // a full update request
    expect((await b.read(1))[0]).toBe(0);                               // FramebufferUpdate: pixels flow while watching
    b.ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));                // KeyEvent "a"
    expect(await b.closed).toBe(4403);
    h.stop();
  });
  it("a control connection passes input through (negative control)", async () => {
    if (!have) return;
    const h = await hub(true);
    const b = await browser(h.url);
    b.ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]));
    b.ws.send(Buffer.from([3, 1, 0, 0, 0, 0, 1, 64, 0, 200]));         // and it still gets updates
    const open = await Promise.race([b.closed.then(() => false), new Promise(r => setTimeout(() => r(true), 500))]);
    expect(open).toBe(true);
    b.ws.close();
    h.stop();
  });
});
