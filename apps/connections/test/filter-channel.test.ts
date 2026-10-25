// The channel a pooled run's helper uses to give the run's output filter a key before the agent is given it (ADR-0037, decision 18): the run listens on a
// private socket, the helper sends the key and waits for the answer, no answer means no key. The keys are synthetic.
import { createServer, connect } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterSocketTrusted, sendToFilter, serveFilterChannel } from "../src/filter-channel.ts";

const KEY = "sk-ant-synthetic-channel-key-0001";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const serve = async (max?: number) => {
  const added: string[] = [];
  const channel = await serveFilterChannel({ add: keys => { added.push(...keys); }, accepts: () => true, ...(max === undefined ? {} : { max }) });
  closers.push(() => channel.close());
  return { channel, added };
};

describe("the filter channel", () => {
  it("adds the key to the filter before it answers, and the answer is yes", async () => {
    const { channel, added } = await serve();
    let seenAtAnswer: string[] = [];
    const ok = await sendToFilter(channel.path, KEY).then(result => { seenAtAnswer = [...added]; return result; });
    expect(ok).toBe(true);
    expect(seenAtAnswer).toEqual([KEY]);
  });

  it("lives in a private directory (0700) and is itself 0600", async () => {
    const { channel } = await serve();
    expect(statSync(dirname(channel.path)).mode & 0o777).toBe(0o700);
    expect(statSync(channel.path).mode & 0o777).toBe(0o600);
  });

  it("refuses an empty key, an oversized one and garbage, and adds nothing", async () => {
    const { channel, added } = await serve();
    expect(await sendToFilter(channel.path, "")).toBe(false);
    expect(await sendToFilter(channel.path, "x".repeat(5000))).toBe(false);
    const raw = await new Promise<string>(resolve => {
      const socket = connect(channel.path);
      let text = "";
      socket.on("data", chunk => { text += String(chunk); });
      socket.on("close", () => { resolve(text); });
      socket.write("not json\n");
    });
    expect(raw.trim()).toBe("no");
    expect(added).toEqual([]);
  });

  it("holds a bounded number of distinct keys; one it already has is still a yes", async () => {
    const { channel, added } = await serve(2);
    expect(await sendToFilter(channel.path, "alpha-synthetic-one")).toBe(true);
    expect(await sendToFilter(channel.path, "bravo-synthetic-two")).toBe(true);
    expect(await sendToFilter(channel.path, "charlie-synthetic-three")).toBe(false);
    expect(await sendToFilter(channel.path, "alpha-synthetic-one")).toBe(true);
    expect(added).toEqual(["alpha-synthetic-one", "bravo-synthetic-two"]);
  });

  it("says no when nobody listens, and after the run closed it; the directory goes with it", async () => {
    const { channel } = await serve();
    const path = channel.path;
    await channel.close();
    expect(existsSync(dirname(path))).toBe(false);
    expect(await sendToFilter(path, KEY)).toBe(false);
    expect(await sendToFilter("/nonexistent/dir/f.sock", KEY)).toBe(false);
  });

  it("says no when the listener never answers, within the time it was given", async () => {
    const { channel } = await serve();
    const quiet = createServer(socket => { socket.on("data", () => undefined); });
    const path = `${dirname(channel.path)}/quiet.sock`;
    await new Promise<void>(resolve => { quiet.listen(path, resolve); });
    closers.push(() => new Promise<void>(resolve => { quiet.close(() => { resolve(); }); }));
    const started = Date.now();
    expect(await sendToFilter(path, KEY, 150)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// Fix round 6. A same-user process that finds the socket can send it keys, and a helper under a grant must hand its key to that grant's own filter.
const accepting = (...keys: string[]) => (key: string): boolean => keys.includes(key);
const serveFor = async (accepts: (key: string) => boolean | Promise<boolean>, extra: { max?: number } = {}) => {
  const added: string[] = [];
  const channel = await serveFilterChannel({ add: list => { added.push(...list); }, accepts, ...extra });
  closers.push(() => channel.close());
  return { channel, added };
};

describe("fix round 6: only a key the pool vouches for, of a sane length, is added to the filter", () => {
  const REAL = "sk-ant-synthetic-member-key-0001";
  it("a key the pool does not know is refused and never added, however many are sent: the run's next real key is still taken", async () => {
    const { channel, added } = await serveFor(accepting(REAL));
    for (let i = 0; i < 100; i++) expect(await sendToFilter(channel.path, `junk-synthetic-key-number-${i}`)).toBe(false);
    expect(added).toEqual([]);
    expect(await sendToFilter(channel.path, REAL)).toBe(true);
    expect(added).toEqual([REAL]);
  });
  it("a key shorter than sixteen characters is refused even when the pool vouches for it; sixteen is taken", async () => {
    const short = "a";
    const edge = "x".repeat(15);
    const fine = "x".repeat(16);
    const { channel, added } = await serveFor(() => true);
    expect(await sendToFilter(channel.path, short)).toBe(false);
    expect(await sendToFilter(channel.path, edge)).toBe(false);
    expect(await sendToFilter(channel.path, fine)).toBe(true);
    expect(added).toEqual([fine]);
  });
  it("asks the pool before it adds, and adds before it answers", async () => {
    const order: string[] = [];
    const channel = await serveFilterChannel({
      accepts: async () => { order.push("accepts"); return true; },
      add: () => { order.push("add"); },
    });
    closers.push(() => channel.close());
    expect(await sendToFilter(channel.path, REAL)).toBe(true);
    expect(order).toEqual(["accepts", "add"]);
  });
  it("a pool that cannot answer (a throw, a rejection) is a no, and nothing is added", async () => {
    const thrown = await serveFor(() => { throw new Error("store busy"); });
    expect(await sendToFilter(thrown.channel.path, REAL)).toBe(false);
    const rejected = await serveFor(async () => { throw new Error("store busy"); });
    expect(await sendToFilter(rejected.channel.path, REAL)).toBe(false);
    expect(thrown.added).toEqual([]);
    expect(rejected.added).toEqual([]);
  });
  it("a long run with many rotations is not cut off: two hundred distinct real keys are all taken", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `sk-ant-synthetic-rotation-${String(i).padStart(4, "0")}`);
    const { channel, added } = await serveFor(accepting(...keys));
    for (const key of keys) expect(await sendToFilter(channel.path, key)).toBe(true);
    expect(added).toEqual(keys);
  });
});

describe("fix round 6: a helper sends a key only to a socket that looks like the run's own", () => {
  let scratch: string;
  const listen = (path: string) => new Promise<void>(resolve => {
    const server = createServer(socket => { socket.on("data", () => undefined); });
    server.listen(path, resolve);
    closers.push(() => new Promise<void>(done => { server.close(() => { done(); }); }));
  });
  const place = (mode: number, sockMode: number) => {
    const dir = mkdtempSync(join(scratch, "d-"));
    chmodSync(dir, mode);
    return { dir, path: join(dir, "f.sock"), sockMode };
  };
  const make = async (mode: number, sockMode: number) => {
    const spot = place(mode, sockMode);
    await listen(spot.path);
    chmodSync(spot.path, sockMode);
    return spot.path;
  };
  it("trusts the channel the run serves", async () => {
    scratch = mkdtempSync(join(tmpdir(), "morndo-trust-"));
    closers.push(() => { rmSync(scratch, { recursive: true, force: true }); });
    const { channel } = await serve();
    expect(filterSocketTrusted(channel.path)).toBe(true);
  });
  it("does not trust a socket others can reach (0666 or 0660), or one in a directory others can enter (0755)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "morndo-trust-"));
    closers.push(() => { rmSync(scratch, { recursive: true, force: true }); });
    expect(filterSocketTrusted(await make(0o700, 0o666))).toBe(false);
    expect(filterSocketTrusted(await make(0o700, 0o660))).toBe(false);
    expect(filterSocketTrusted(await make(0o755, 0o600))).toBe(false);
    expect(filterSocketTrusted(await make(0o700, 0o600))).toBe(true);
  });
  it("does not trust a socket owned by another user", async () => {
    const { channel } = await serve();
    const uid = process.getuid?.() ?? 0;
    expect(filterSocketTrusted(channel.path, uid + 1)).toBe(false);
    expect(filterSocketTrusted(channel.path, uid)).toBe(true);
  });
  it("does not trust a plain file, a symlink to a good socket, or a path that is not there", async () => {
    scratch = mkdtempSync(join(tmpdir(), "morndo-trust-"));
    closers.push(() => { rmSync(scratch, { recursive: true, force: true }); });
    const { channel } = await serve();
    const plain = place(0o700, 0o600);
    writeFileSync(plain.path, "");
    chmodSync(plain.path, 0o600);
    expect(filterSocketTrusted(plain.path)).toBe(false);
    const link = place(0o700, 0o600);
    symlinkSync(channel.path, link.path);
    expect(filterSocketTrusted(link.path)).toBe(false);
    expect(filterSocketTrusted(join(scratch, "nope", "f.sock"))).toBe(false);
  });
});

describe("fix round 6: a launcher killed outright leaves a directory the next start sweeps", () => {
  const DEAD = 2_147_483_646;
  let root: string;
  let was: string | undefined;
  const useRoot = () => {
    root = mkdtempSync(join(tmpdir(), "morndo-sweep-"));
    was = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = root;
    closers.push(() => {
      if (was === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = was;
      rmSync(root, { recursive: true, force: true });
    });
  };
  const leftBehind = (name: string, files: string[] = ["f.sock"]) => {
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    for (const file of files) writeFileSync(join(dir, file), "");
    return dir;
  };
  it("names its directory after the launcher's process, so a later start can tell whose it was", async () => {
    useRoot();
    const { channel } = await serve();
    expect(dirname(channel.path).split("/").at(-1)).toMatch(new RegExp(`^mf-${process.pid}-[A-Za-z0-9]{6}$`));
  });
  it("removes the directory of a process that is gone, and keeps one whose process is alive", async () => {
    useRoot();
    const dead = leftBehind(`mf-${DEAD}-abcdef`);
    const alive = leftBehind(`mf-${process.pid}-zzzzzz`);
    await serve();
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(alive)).toBe(true);
  });
  it("leaves alone what it did not make: another name, a directory with other files in it, an old-format name, a symlink", async () => {
    useRoot();
    const other = leftBehind("somebody-else");
    const extra = leftBehind(`mf-${DEAD}-qqqqqq`, ["f.sock", "notes.txt"]);
    const old = leftBehind("mf-AbC123");
    const target = mkdtempSync(join(tmpdir(), "morndo-sweep-target-"));
    closers.push(() => { rmSync(target, { recursive: true, force: true }); });
    const link = join(root, `mf-${DEAD}-linkxx`);
    symlinkSync(target, link);
    await serve();
    for (const kept of [other, extra, old, target]) expect(existsSync(kept)).toBe(true);
    expect(readdirSync(root)).toContain(`mf-${DEAD}-linkxx`);
  });
  it("a root whose path is too long for a socket fails closed with an error that says so, and leaves nothing behind", async () => {
    root = mkdtempSync(join(tmpdir(), "morndo-long-"));
    const long = join(root, "d".repeat(60), "e".repeat(60));
    mkdirSync(long, { recursive: true });
    was = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = long;
    closers.push(() => {
      if (was === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = was;
      rmSync(root, { recursive: true, force: true });
    });
    const error = await serveFilterChannel({ add: () => undefined, accepts: () => true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/socket path is too long/);
    expect((error as Error).message).toMatch(/TMPDIR|XDG_RUNTIME_DIR/);
    expect(readdirSync(long)).toEqual([]);
  });
});
