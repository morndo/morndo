// The socket a pooled run listens on so its helper can hand a key to the output filter before the agent is given it.
// One line of JSON in, `ok` or `no` out, and the connection ends. A key is never logged and never put in an error here.
//
// A same-user process that finds the socket can send keys. The channel takes one only when it is a sane length and
// `accepts` says it belongs to the run's pool. There is no way to listen without that check. A refusal, a throw or a
// rejection is `no` and adds nothing. A key already held is `ok` and is not asked about again. Two deliveries of one
// new key at once add it once and both are told `ok`. The cap on the held set is only a bound on memory.
//
// Junk senders must not make the real helper's wait lapse (it gives the channel two seconds). A socket that has not said its
// piece within a second is cut loose; at the cap on open sockets the oldest one that has not finished a line makes room, and a
// new one is refused when every open socket is waiting for the pool; the pool is asked about one key at a time, with a bounded
// line behind the one being asked. A same-user process that floods with distinct keys can still delay or deny the hand-off
// (fail closed: no key is printed), as it could by killing the run.
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_KEY = 1024;
// Real provider keys are far longer. Anything shorter can make the redactor hide ordinary text.
const MIN_KEY = 16;
// A pool plus every rotation of its members stays far under this. It only stops the set growing without bound.
const MAX_HELD = 1024;
// A valid key survives JSON escaping (`\uXXXX` is the long form). Anything past this is a line that is too long.
const MAX_LINE = MAX_KEY * 6 + 64;
// A sender writes its line the moment it connects. One that has not finished a line within this is cut loose.
const IDLE_MS = 1000;
// Open sockets at once. At the cap the oldest socket that has not finished a line makes room; if all have, the new one is refused.
const MAX_OPEN = 32;
// Keys waiting for the pool at once, the one being asked included. The check opens the run's home, so it runs one at a time.
const MAX_QUEUE = 8;
// A directory younger than this is left alone: a launcher may be between making it and listening in it.
const SWEEP_MIN_AGE_MS = 60_000;
// A directory this module made: `mf-<pid>-<6 chars>`. An older name (`mf-` and six characters only) is not this.
const FILTER_DIR = /^mf-(\d+)-[A-Za-z0-9]{6}$/;
// sockaddr_un.sun_path is 108 bytes on Linux and 104 on macOS, and one byte is the terminating NUL.
const MAX_FILTER_SOCKET_PATH = process.platform === "darwin" ? 103 : 107;

// Alive, or not provably gone. EPERM means the process exists and we may not signal it. Only ESRCH means it is gone.
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

// Whether anything answers on this socket. A refused connection, a file that is not a socket, or no file at all means nobody
// does. Anything else (a listener that accepted, a timeout, an unexpected error) counts as someone, and the directory is kept.
// This is what tells a dead launcher from a live one whose pid this namespace cannot see.
function listening(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path);
    const done = (value: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => { done(true); }, 500);
    socket.once("connect", () => { done(true); });
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      done(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK");
    });
  });
}

// A launcher killed outright cannot remove its socket directory. The next start removes one only when it is a real
// directory this module named, owned by this user, at least a minute old, whose process is gone, which holds nothing but the
// socket, and on whose socket nobody answers (a launcher in another pid namespace shows no pid here but still answers).
// A failure here never stops the channel that is about to listen, and a symlink is never followed or removed.
async function sweepStaleFilterDirs(root: string): Promise<void> {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  const uid = process.getuid?.() ?? -1;
  for (const name of names) {
    try {
      const text = FILTER_DIR.exec(name)?.[1];
      if (text === undefined) continue;
      const pid = Number(text);
      if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== text || pid === process.pid) continue;
      const dir = join(root, name);
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) continue;
      if (Date.now() - stat.mtimeMs < SWEEP_MIN_AGE_MS) continue;
      if (!processGone(pid)) continue;
      if (readdirSync(dir).some(entry => entry !== "f.sock")) continue;
      if (await listening(join(dir, "f.sock"))) continue;
      rmSync(dir, { recursive: true, force: true });
    } catch { /* leave this entry; the new channel still starts */ }
  }
}

function readKey(line: string): string | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== "object" || value === null || !("key" in value)) return null;
  const key = (value as { key: unknown }).key;
  if (typeof key !== "string" || key.length < MIN_KEY || key.length > MAX_KEY) return null;
  return key;
}

export async function serveFilterChannel(input: {
  add: (keys: readonly string[]) => void;
  accepts: (key: string) => boolean | Promise<boolean>;
  max?: number;
  idleMs?: number;
  maxOpen?: number;
  maxQueue?: number;
}): Promise<{ path: string; close(): Promise<void> }> {
  const max = input.max ?? MAX_HELD;
  const idleMs = input.idleMs ?? IDLE_MS;
  const maxOpen = input.maxOpen ?? MAX_OPEN;
  const maxQueue = input.maxQueue ?? MAX_QUEUE;
  const base = process.env.XDG_RUNTIME_DIR;
  const root = typeof base === "string" && base !== "" ? base : tmpdir();
  const socketPath = join(root, "mf-" + process.pid + "-XXXXXX", "f.sock");
  const socketBytes = Buffer.byteLength(socketPath);
  if (socketBytes > MAX_FILTER_SOCKET_PATH) {
    throw new Error(`the filter socket path is too long (${socketBytes} bytes, at most ${MAX_FILTER_SOCKET_PATH}): set XDG_RUNTIME_DIR or TMPDIR to a shorter directory`);
  }
  await sweepStaleFilterDirs(root);
  const dir = mkdtempSync(join(root, `mf-${process.pid}-`));
  chmodSync(dir, 0o700);
  const path = join(dir, "f.sock");
  const held = new Set<string>();
  // Insertion order is connection order: the first one still without a finished line is the oldest silent one.
  const open = new Map<Socket, { complete: boolean }>();
  // The pool is asked about one key at a time: each check opens the run's home. `queued` counts the one being asked and those behind it.
  let queued = 0;
  let line: Promise<unknown> = Promise.resolve();
  const ask = (key: string, wanted: () => boolean): Promise<boolean> | null => {
    if (queued >= maxQueue) return null;
    queued += 1;
    const result = line.then(async (): Promise<boolean> => {
      if (!wanted()) return false;
      try { return (await input.accepts(key)) === true; }
      catch { return false; }
    });
    line = result;
    void result.then(() => { queued -= 1; });
    return result;
  };
  const server: Server = createServer(socket => {
    if (open.size >= maxOpen) {
      let oldest: Socket | undefined;
      for (const [other, state] of open) if (!state.complete) { oldest = other; break; }
      if (oldest === undefined) { socket.destroy(); return; }
      oldest.destroy();
      open.delete(oldest);
    }
    const state = { complete: false };
    open.set(socket, state);
    const idle = setTimeout(() => { socket.destroy(); }, idleMs);
    idle.unref();
    socket.on("close", () => { clearTimeout(idle); open.delete(socket); });
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let pending = "";
    let answered = false;
    let deciding = false;
    const reply = (word: "ok" | "no"): void => {
      if (answered) return;
      answered = true;
      clearTimeout(idle);
      pending = "";
      socket.end(`${word}\n`);
    };
    // Length is already enforced by readKey. Then the pool, one at a time. After it answers, the set is checked again: the other
    // delivery may have added this key while this one waited, and that one add is enough for both to be told ok.
    const admit = async (key: string): Promise<void> => {
      const asked = ask(key, () => !socket.destroyed);
      if (asked === null) { reply("no"); return; }
      if (!await asked) { reply("no"); return; }
      if (held.has(key)) { reply("ok"); return; }
      if (held.size >= max) { reply("no"); return; }
      held.add(key);
      // The filter holds the key before the helper is told it may print it.
      try { input.add([key]); }
      catch { held.delete(key); reply("no"); return; }
      reply("ok");
    };
    socket.on("data", (chunk: string) => {
      if (answered || deciding) return;
      pending += chunk;
      const nl = pending.indexOf("\n");
      if (nl === -1) {
        if (pending.length > MAX_LINE) reply("no");
        return;
      }
      // The sender has said its piece: from here the wait is the pool's, which the queue bounds.
      state.complete = true;
      clearTimeout(idle);
      const text = pending.slice(0, nl);
      if (text.length > MAX_LINE) { reply("no"); return; }
      const key = readKey(text);
      if (key === null) { reply("no"); return; }
      if (held.has(key)) { reply("ok"); return; }
      deciding = true;
      void admit(key).catch(() => { reply("no"); });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { reject(error); };
      server.once("error", fail);
      server.listen(path, () => {
        server.off("error", fail);
        try { chmodSync(path, 0o600); resolve(); }
        catch (error) { reject(error instanceof Error ? error : new Error("socket")); }
      });
    });
  } catch (error) {
    try { server.close(); } catch { /* not listening */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the directory may already be gone */ }
    throw error instanceof Error ? error : new Error("filter channel");
  }
  server.on("error", () => undefined);
  let closing: Promise<void> | null = null;
  return {
    path,
    close(): Promise<void> {
      if (closing !== null) return closing;
      closing = new Promise(resolve => {
        const done = (): void => {
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
          resolve();
        };
        for (const socket of open.keys()) socket.destroy();
        if (!server.listening) { done(); return; }
        server.close(() => { done(); });
      });
      return closing;
    },
  };
}

// True only when the listener answered `ok`. A missing socket, any other answer, a close, or the timeout is false.
export function sendToFilter(path: string, key: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let socket: Socket;
    try { socket = connect(path); }
    catch { resolve(false); return; }
    let done = false;
    let text = "";
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
      try { socket.end(); } catch { /* already closed */ }
    };
    const timer = setTimeout(() => { finish(false); }, timeoutMs);
    const yes = (): boolean => text === "ok" || text.startsWith("ok\n");
    socket.setEncoding("utf8");
    socket.on("error", () => { finish(false); });
    socket.on("data", (chunk: string) => {
      text += chunk;
      if (text.length > 32 || text.includes("\n")) finish(yes());
    });
    socket.on("close", () => { finish(yes()); });
    socket.on("connect", () => { socket.write(`${JSON.stringify({ key })}\n`); });
  });
}

// A socket the run itself would have made: owned by this user, mode 0600, in a directory owned by this user, mode 0700.
// A symlink, a plain file, or anything missing is not that socket.
export function filterSocketTrusted(path: string, uid: number = process.getuid?.() ?? -1): boolean {
  try {
    const sock = lstatSync(path);
    if (sock.isSymbolicLink() || !sock.isSocket() || sock.uid !== uid || (sock.mode & 0o777) !== 0o600) return false;
    const parent = lstatSync(dirname(path));
    return !parent.isSymbolicLink() && parent.isDirectory() && parent.uid === uid && (parent.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}
