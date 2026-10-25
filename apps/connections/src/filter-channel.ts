// The socket a pooled run listens on so its helper can hand a key to the output filter before the agent is given it.
// One line of JSON in, `ok` or `no` out, and the connection ends. A key is never logged and never put in an error here.
//
// A same-user process that finds the socket can send keys. The channel takes one only when it is a sane length and
// `accepts` says it belongs to the run's pool. There is no way to listen without that check. A refusal, a throw or a
// rejection is `no` and adds nothing. A key already held is `ok` and is not asked about again. Two deliveries of one
// new key at once add it once and both are told `ok`. The cap on the held set is only a bound on memory.
import { createServer, connect, type Server, type Socket } from "node:net";
import { chmodSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_KEY = 1024;
// Real provider keys are far longer. Anything shorter can make the redactor hide ordinary text.
const MIN_KEY = 16;
// A pool plus every rotation of its members stays far under this. It only stops the set growing without bound.
const MAX_HELD = 1024;
// A valid key survives JSON escaping (`\uXXXX` is the long form). Anything past this is a line that is too long.
const MAX_LINE = MAX_KEY * 6 + 64;

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
}): Promise<{ path: string; close(): Promise<void> }> {
  const max = input.max ?? MAX_HELD;
  const base = process.env.XDG_RUNTIME_DIR;
  const root = typeof base === "string" && base !== "" ? base : tmpdir();
  const dir = mkdtempSync(join(root, "mf-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "f.sock");
  const held = new Set<string>();
  const open = new Set<Socket>();
  const server: Server = createServer(socket => {
    open.add(socket);
    socket.on("close", () => { open.delete(socket); });
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    let pending = "";
    let answered = false;
    let deciding = false;
    const reply = (word: "ok" | "no"): void => {
      if (answered) return;
      answered = true;
      pending = "";
      socket.end(`${word}\n`);
    };
    // Length is already enforced by readKey. Then the pool. After it answers, the set is checked again: the other
    // delivery may have added this key while this one waited, and that one add is enough for both to be told ok.
    const admit = async (key: string): Promise<void> => {
      let allowed = false;
      try { allowed = await input.accepts(key); }
      catch { reply("no"); return; }
      if (allowed !== true) { reply("no"); return; }
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
      const line = pending.slice(0, nl);
      if (line.length > MAX_LINE) { reply("no"); return; }
      const key = readKey(line);
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
        for (const socket of open) socket.destroy();
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
