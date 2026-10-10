// Desktop adapter: a WebSocket-to-RFB bridge to the office's VNC server (RFC 6143), like websockify, with two things a
// plain bridge doesn't do:
// - the hub logs in to the server itself, with the password from the server's password file, and offers the browser
//   only security type None, so the password never leaves the hub;
// - on a watching connection every client message is parsed: clipboard is dropped, and any other input (keys, pointer,
//   resizing, power) closes the connection. Input reaches the desktop only on a control connection (AC9).
// The browser side is noVNC (MPL-2.0), unmodified, which speaks RFB 3.8 over the WebSocket.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import type { WebSocket } from "ws";

// VNC's DES is single DES with the bits of each key byte mirrored (VNC's d3des.c builds its key schedule that way).
// Node's OpenSSL 3 has no single DES; 3DES with three equal keys is the same cipher.
const mirror = (b: number) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; };
const desKey = (key: Buffer) => { const m = Buffer.from([...key.subarray(0, 8)].map(mirror)); return Buffer.concat([m, m, m]); };

export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "latin1").copy(key, 0, 0, 8);
  const c = createCipheriv("des-ede3-ecb", desKey(key), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(challenge), c.final()]);
}

// The file vncpasswd writes: the password (at most 8 bytes) DES-encrypted with VNC's fixed key.
const FIXED_KEY = Buffer.from([23, 82, 107, 6, 35, 78, 88, 7]);
export function readVncPassword(file: string): string {
  const d = createDecipheriv("des-ede3-ecb", desKey(FIXED_KEY), null);
  d.setAutoPadding(false);
  const plain = Buffer.concat([d.update(readFileSync(file).subarray(0, 8)), d.final()]);
  const end = plain.indexOf(0);
  return plain.subarray(0, end === -1 ? 8 : end).toString("latin1");
}

// Reads exact byte counts from a stream of chunks.
class Reader {
  #buf = Buffer.alloc(0);
  #wait: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  #failed: Error | null = null;
  push(chunk: Buffer) { this.#buf = Buffer.concat([this.#buf, chunk]); this.#serve(); }
  fail(e: Error) { this.#failed ??= e; this.#serve(); }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => { this.#wait = { n, resolve, reject }; this.#serve(); });
  }
  rest(): Buffer { const b = this.#buf; this.#buf = Buffer.alloc(0); return b; }
  #serve() {
    const w = this.#wait;
    if (!w) return;
    if (this.#buf.length >= w.n) {
      this.#wait = null;
      const out = Buffer.from(this.#buf.subarray(0, w.n));
      this.#buf = this.#buf.subarray(w.n);
      w.resolve(out);
    } else if (this.#failed) {
      this.#wait = null;
      w.reject(this.#failed);
    }
  }
}

// Client-to-server messages a watching browser may send: they only shape what it receives. Lengths per RFC 6143 and
// the extensions noVNC uses (EnableContinuousUpdates, Fence). Anything else is input or unknown: refused.
const WATCH_OK: Record<number, (b: Buffer) => number | null> = {
  0: () => 20,                                                    // SetPixelFormat
  2: b => (b.length >= 4 ? 4 + 4 * b.readUInt16BE(2) : null),    // SetEncodings
  3: () => 10,                                                    // FramebufferUpdateRequest
  150: () => 10,                                                  // EnableContinuousUpdates
  248: b => (b.length >= 9 ? 9 + (b[8] ?? 0) : null),             // ClientFence
};

// Clipboard from the browser (ClientCutText, or noVNC's extended clipboard with a negative length, which it announces
// right after connecting even when it only watches) is dropped while watching: the desktop gets nothing from it.
const dropWatching = (b: Buffer): number | null => (b[0] === 6 && b.length >= 8 ? 8 + Math.abs(b.readInt32BE(4)) : null);

// Under control, only the principal's own input counts as use toward the idle limit (AC5): KeyEvent, PointerEvent and
// ClientCutText. What the browser sends by itself (update requests, fence answers, encodings, a resize) doesn't. A type
// not listed, or a message split across chunks, counts as input. Lengths as in WATCH_OK, plus SetDesktopSize.
const CONTROL_LEN: Record<number, (b: Buffer) => number | null> = {
  ...WATCH_OK,
  251: b => (b.length >= 8 ? 8 + 16 * (b[6] ?? 0) : null),        // SetDesktopSize: 16 bytes per screen
};
export function principalInput(chunk: Buffer): boolean {
  let i = 0;
  while (i < chunk.length) {
    const len = CONTROL_LEN[chunk[i] as number];                   // KeyEvent 4, PointerEvent 5, ClientCutText 6: absent
    const n = len ? len(chunk.subarray(i)) : null;
    if (n === null || i + n > chunk.length) return true;
    i += n;
  }
  return false;
}

// Splits a watching client's bytes into whole messages; returns the allowed bytes to forward, what's left over, or the
// type of a refused message.
export function filterWatching(buf: Buffer): { forward: Buffer; rest: Buffer; refused: number | null } {
  const keep: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const type = buf[i] as number;
    const tail = buf.subarray(i);
    const len = WATCH_OK[type];
    if (len) {
      const n = len(tail);
      if (n === null || i + n > buf.length) break;               // incomplete: wait for more
      keep.push(buf.subarray(i, i + n));
      i += n;
    } else if (type === 6) {
      const n = dropWatching(tail);
      if (n === null || i + n > buf.length) break;
      i += n;
    } else {
      return { forward: Buffer.concat(keep), rest: Buffer.alloc(0), refused: type };
    }
  }
  return { forward: Buffer.concat(keep), rest: buf.subarray(i), refused: null };
}

export type DesktopTarget = { host: string; port: number; password: string | null };

// Logs in to the VNC server; resolves with the open socket, positioned right before ClientInit.
export async function loginToServer(target: DesktopTarget, timeoutMs = 5000): Promise<{ sock: Socket; reader: Reader }> {
  const sock = connect(target.port, target.host);
  const reader = new Reader();
  sock.on("data", d => reader.push(d));
  sock.on("error", e => reader.fail(e));
  sock.on("close", () => reader.fail(new Error("closed")));
  const timer = setTimeout(() => sock.destroy(new Error("login timed out")), timeoutMs);
  try {
    const version = (await reader.read(12)).toString("latin1");
    if (!/^RFB \d{3}\.\d{3}\n$/.test(version)) throw new Error("not an RFB server");
    sock.write("RFB 003.008\n");
    const n = (await reader.read(1))[0] ?? 0;
    if (n === 0) throw new Error(`server refused: ${(await reader.read((await reader.read(4)).readUInt32BE(0))).toString("utf8")}`);
    const types = [...(await reader.read(n))];
    if (target.password !== null && types.includes(2)) {
      sock.write(Buffer.from([2]));
      sock.write(vncAuthResponse(target.password, await reader.read(16)));
    } else if (types.includes(1)) {
      sock.write(Buffer.from([1]));
    } else {
      throw new Error(`no usable security type (server offers ${types.join(",")})`);
    }
    if ((await reader.read(4)).readUInt32BE(0) !== 0) {
      const len = (await reader.read(4).catch(() => Buffer.alloc(4))).readUInt32BE(0);
      throw new Error(`login refused${len ? `: ${(await reader.read(len)).toString("utf8")}` : ""}`);
    }
    return { sock, reader };
  } catch (e) {
    sock.destroy();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Bridges one browser WebSocket to the desktop. The browser sees a server with security type None. `mayControl` is
// asked before each piece of control input reaches the desktop (AC9: control lapses as soon as AC7 stops holding), with
// whether it holds the principal's own input (`use`, AC5).
export async function bridgeDesktop(ws: WebSocket, target: DesktopTarget, control: boolean, onClose: (why: string) => void, mayControl: (use: boolean) => boolean = () => true) {
  const client = new Reader();
  let closed = false;
  let sock: Socket | null = null;
  const close = (code: number, why: string) => {
    if (closed) return;
    closed = true;
    sock?.destroy();
    if (ws.readyState === ws.OPEN) ws.close(code, why.slice(0, 120));
    onClose(why);
  };
  ws.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) client.push(d); else close(1003, "binary only"); });
  ws.on("close", () => close(1000, "browser left"));
  try {
    const server = await loginToServer(target);
    sock = server.sock;
    if (closed) { sock.destroy(); return; }
    ws.send(Buffer.from("RFB 003.008\n"));
    if (!(await client.read(12)).toString("latin1").startsWith("RFB 003.")) return close(1002, "bad client version");
    ws.send(Buffer.from([1, 1]));                                  // one security type: None
    if ((await client.read(1))[0] !== 1) return close(1002, "bad security choice");
    ws.send(Buffer.from([0, 0, 0, 0]));                            // SecurityResult: OK
    // From here on, bytes flow both ways; the server's must go to the browser first, without our Reader.
    sock.removeAllListeners("data");
    const early = server.reader.rest();
    if (early.length) ws.send(early);
    sock.on("data", d => {
      ws.send(d);
      if (ws.bufferedAmount > 16 << 20) {                          // a slow browser: let the server wait
        sock?.pause();
        const resume = setInterval(() => { if (ws.bufferedAmount < 4 << 20 || closed) { clearInterval(resume); sock?.resume(); } }, 50);
      }
    });
    sock.on("close", () => close(1000, "desktop closed"));
    const init = await client.read(1);                             // ClientInit (shared flag)
    sock.write(Buffer.from([1]));                                  // always shared: never disconnect the others
    void init;
    let pending = client.rest();
    const forward = (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;                       // the hub has ended this connection (AC4, AC9)
      if (control) { if (mayControl(principalInput(chunk))) sock?.write(chunk); return; }
      pending = Buffer.concat([pending, chunk]);
      const f = filterWatching(pending);
      if (f.forward.length) sock?.write(f.forward);
      pending = f.rest;
      if (f.refused !== null) close(4403, "input needs control");
    };
    ws.removeAllListeners("message");
    ws.on("message", (d: Buffer, isBinary: boolean) => { if (isBinary) forward(d); });
    if (pending.length) { const p = pending; pending = Buffer.alloc(0); forward(p); }
  } catch (e) {
    close(1011, `desktop unavailable: ${(e as Error).message}`);
  }
}
