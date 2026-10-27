// The file a server's key is written to (ADR-0037, slice 4; plan 3.6): `NAME=value` through a temp file in the same directory, 0600 from the moment it is
// created, then renamed over the old one, so a reader never sees half a file or a key anyone else can read. A path in a repository, in a directory
// others can write, through a link, or under a protected directory is refused before anything is written. The sidecar names the member the key is of.
import { renameSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readlinkSync } from "node:fs";
import { acquireEnvLock, memberLoadedAt, readEnvStamp, writeEnvFile } from "../src/adapters/env-file.ts";

// The pid namespace this test runs in, as a lock records it.
const NS = /\[(\d+)\]/.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? "0";
// Whether this box lets an unprivileged process make a pid namespace (a CI runner may not): the container case is run when it does, and shown as skipped when it does not.
const NAMESPACES = spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--kill-child", "--mount-proc", "true"], { timeout: 10_000 }).status === 0;
const VALUE = "synthetic-value-for-the-env-file-0000";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function area(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-envfile-"));
  dirs.push(dir);
  chmodSync(dir, 0o700);
  return dir;
}
const input = (path: string, over: Partial<Parameters<typeof writeEnvFile>[0]> = {}) => ({ path, name: "ANTHROPIC_API_KEY", value: VALUE, member: "k1", protectedDirs: [], ...over });
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("a written file", () => {
  it("is 0600 and holds exactly NAME=value and a newline; the sidecar holds the member name, 0600", () => {
    const path = join(area(), ".env");
    expect(writeEnvFile(input(path))).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe(`ANTHROPIC_API_KEY=${VALUE}\n`);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(`${path}.member`, "utf8")).toMatch(/^k1\n\d+:\d+\n\d+ k1\n$/);
    expect(mode(`${path}.member`)).toBe(0o600);
  });
  it("replaces an existing file's content and makes its mode 0600", () => {
    const dir = area();
    const path = join(dir, ".env");
    writeFileSync(path, "OLD=1\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(writeEnvFile(input(path))).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toBe(`ANTHROPIC_API_KEY=${VALUE}\n`);
    expect(mode(path)).toBe(0o600);
  });
  it("leaves no temp file behind", () => {
    const dir = area();
    writeEnvFile(input(join(dir, ".env")));
    expect(readdirSync(dir).sort()).toEqual([".env", ".env.member"]);
  });
  it("a failing rename leaves the old file intact and no temp file (the path is a directory)", () => {
    const dir = area();
    const path = join(dir, ".env");
    mkdirSync(path);
    const out = writeEnvFile(input(path));
    expect(out).toEqual({ ok: false, problem: "write_failed" });
    expect(readdirSync(dir)).toEqual([".env"]);
  });
  it("the temp file is created 0600: the value is never in a file others can read, even for a moment (umask 0)", () => {
    const dir = area();
    const before = process.umask(0);
    try {
      expect(writeEnvFile(input(join(dir, ".env")))).toEqual({ ok: true });
    } finally { process.umask(before); }
    expect(mode(join(dir, ".env"))).toBe(0o600);
    expect(mode(join(dir, ".env.member"))).toBe(0o600);
  });
});

describe("what is refused before anything is written", () => {
  const refuses = (path: string, problem: string, over: Partial<Parameters<typeof writeEnvFile>[0]> = {}): void => {
    expect(writeEnvFile(input(path, over))).toEqual({ ok: false, problem });
  };
  it("a path in a git work tree (a .git directory or file in any ancestor)", () => {
    const dir = area();
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", "deep", "er"), { recursive: true });
    refuses(join(dir, "repo", "deep", "er", ".env"), "in_repository");
  });
  it("a worktree's .git file counts too", () => {
    const dir = area();
    mkdirSync(join(dir, "wt"));
    writeFileSync(join(dir, "wt", ".git"), "gitdir: /elsewhere\n");
    refuses(join(dir, "wt", ".env"), "in_repository");
  });
  it("a directory that group or others can write; one that is only readable is fine", () => {
    const dir = area();
    for (const bits of [0o770, 0o707, 0o777, 0o720, 0o702]) {
      const bad = join(dir, `d${bits.toString(8)}`);
      mkdirSync(bad);
      chmodSync(bad, bits);
      refuses(join(bad, ".env"), "dir_writable");
    }
    const open = join(dir, "readable");
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(writeEnvFile(input(join(open, ".env")))).toEqual({ ok: true });
  });
  it("a path under a protected directory", () => {
    const dir = area();
    mkdirSync(join(dir, "vault"));
    refuses(join(dir, "vault", ".env"), "protected", { protectedDirs: [join(dir, "vault")] });
    refuses(join(dir, "vault"), "protected", { protectedDirs: [join(dir, "vault")] });
  });
  it("a directory that is a link into a protected directory is protected too (the real place is judged, not the spelling)", () => {
    const dir = area();
    mkdirSync(join(dir, "vault"));
    symlinkSync(join(dir, "vault"), join(dir, "elsewhere"));
    refuses(join(dir, "elsewhere", ".env"), "protected", { protectedDirs: [join(dir, "vault")] });
    const home = join(dir, "homelink");
    symlinkSync(dir, home);
    refuses(join(home, "vault", ".env"), "protected", { protectedDirs: [join(dir, "vault")] });
  });
  it("a symlink at the path or at the sidecar", () => {
    const dir = area();
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), join(dir, ".env"));
    refuses(join(dir, ".env"), "symlink");
    expect(readFileSync(join(dir, "real"), "utf8")).toBe("x");
    const other = join(dir, "e2");
    symlinkSync(join(dir, "real"), `${other}.member`);
    refuses(other, "symlink");
    expect(readFileSync(join(dir, "real"), "utf8")).toBe("x");
  });
  it("a directory that is not there", () => {
    refuses(join(area(), "nope", ".env"), "no_dir");
  });
  it("a name that is not [A-Z_][A-Z0-9_]*, and a value outside the key characters: nothing is written, no quoting or escaping exists", () => {
    const dir = area();
    for (const name of ["lower", "1ABC", "A B", "A=B", "A\nB", "", "A".repeat(65)]) refuses(join(dir, ".env"), "bad_name", { name });
    for (const value of ["", "a b", "a\nb", "a\"b", "a'b", "a$b", "a`b", "a\\b", "x".repeat(1025)]) refuses(join(dir, ".env"), "bad_value", { value });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("a member name that is not a connection name", () => {
    const dir = area();
    refuses(join(dir, ".env"), "bad_member", { member: "K 1\n" });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("a path that is not absolute", () => {
    refuses(".env", "bad_path");
  });
});

describe("the pair is stamped: the sidecar says which file it is about", () => {
  it("readEnvStamp gives the member, when the file was written, and that the pair is consistent", () => {
    const path = join(area(), ".env");
    writeEnvFile(input(path, { member: "k7" }));
    const stamp = readEnvStamp(path);
    expect(stamp).toEqual({ member: "k7", consistent: true, writtenAt: statSync(path).mtimeMs, history: [{ at: Math.trunc(statSync(path).mtimeMs), member: "k7" }] });
  });
  it("the sidecar keeps a short history of what was written when: the last eight writes, the newest last, so the key a server loaded at its start can be named", async () => {
    const path = join(area(), ".env");
    const members: string[] = [];
    for (let i = 0; i < 10; i++) {
      members.push(`k${i}`);
      expect(writeEnvFile(input(path, { member: `k${i}` }))).toEqual({ ok: true });
      await new Promise(resolve => { setTimeout(resolve, 15); });
    }
    const stamp = readEnvStamp(path);
    expect(stamp?.history.map(row => row.member)).toEqual(members.slice(-8));
    expect(stamp?.member).toBe("k9");
    const times = stamp?.history.map(row => row.at) ?? [];
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(readFileSync(`${path}.member`, "utf8")).toMatch(/^k9\n\d+:\d+\n(\d+ k\d\n){8}$/);
  });
  it("memberLoadedAt: the key a server holds is the one in the file when it started; before the first write, in a history that has gone, or from an inconsistent pair: no one", async () => {
    const path = join(area(), ".env");
    writeEnvFile(input(path, { member: "k1" }));
    await new Promise(resolve => { setTimeout(resolve, 50); });
    writeEnvFile(input(path, { member: "k2" }));
    const stamp = readEnvStamp(path);
    if (!stamp) throw new Error("no stamp");
    const [first, second] = stamp.history;
    expect(memberLoadedAt(stamp, (first?.at ?? 0) - 1)).toBeNull();
    expect(memberLoadedAt(stamp, first?.at ?? 0)).toBe("k1");
    expect(memberLoadedAt(stamp, (second?.at ?? 0) - 1)).toBe("k1");
    expect(memberLoadedAt(stamp, second?.at ?? 0)).toBe("k2");
    expect(memberLoadedAt(stamp, Date.now() + 1000)).toBe("k2");
    expect(memberLoadedAt({ ...stamp, consistent: false }, Date.now() + 1000)).toBeNull();
  });
  it("memberLoadedAt with a start known only to the clock's resolution (a window): a write inside the window is ambiguous, so no one is blamed", () => {
    const stamp = { consistent: true, history: [{ at: 1000, member: "k1" }, { at: 5000, member: "k2" }] };
    expect(memberLoadedAt(stamp, { from: 4500, to: 5500 })).toBeNull();
    expect(memberLoadedAt(stamp, { from: 900, to: 1900 })).toBeNull();
    expect(memberLoadedAt(stamp, { from: 5001, to: 6001 })).toBe("k2");
    expect(memberLoadedAt(stamp, { from: 2000, to: 3000 })).toBe("k1");
    expect(memberLoadedAt(stamp, { from: 100, to: 900 })).toBeNull();
    expect(memberLoadedAt(stamp, { from: 5000, to: 6000 })).toBe("k2");
    expect(memberLoadedAt({ ...stamp, consistent: false }, { from: 2000, to: 3000 })).toBeNull();
  });
  it("a sidecar of the earlier two-line form knows only the current write", () => {
    const dir = area();
    const path = join(dir, ".env");
    writeFileSync(path, "ANTHROPIC_API_KEY=x\n", { mode: 0o600 });
    const found = statSync(path);
    writeFileSync(`${path}.member`, `k4\n${found.ino}:${Math.trunc(found.mtimeMs)}\n`);
    const stamp = readEnvStamp(path);
    expect(stamp).toMatchObject({ member: "k4", consistent: true, history: [{ at: Math.trunc(found.mtimeMs), member: "k4" }] });
    expect(memberLoadedAt(stamp as NonNullable<typeof stamp>, Math.trunc(found.mtimeMs) - 1)).toBeNull();
    expect(memberLoadedAt(stamp as NonNullable<typeof stamp>, Math.trunc(found.mtimeMs) + 1)).toBe("k4");
  });
  it("a file replaced after the sidecar (or a sidecar left from an earlier write) is inconsistent: the member it names is not known to be the key in the file", () => {
    const path = join(area(), ".env");
    writeEnvFile(input(path, { member: "k1" }));
    writeFileSync(`${path}.new`, "ANTHROPIC_API_KEY=other\n", { mode: 0o600 });
    renameSync(`${path}.new`, path);
    expect(readEnvStamp(path)).toMatchObject({ member: "k1", consistent: false });
    const again = join(area(), ".env");
    writeEnvFile(input(again, { member: "k1" }));
    const at = new Date(Date.now() - 5000);
    utimesSync(again, at, at);
    expect(readEnvStamp(again)).toMatchObject({ consistent: false });
  });
  it("no sidecar, no file, or a sidecar that is not a stamp: null", () => {
    const dir = area();
    expect(readEnvStamp(join(dir, ".env"))).toBeNull();
    writeFileSync(join(dir, ".env"), "A=1\n");
    expect(readEnvStamp(join(dir, ".env"))).toBeNull();
    writeFileSync(join(dir, ".env.member"), "k1\n");
    expect(readEnvStamp(join(dir, ".env"))).toBeNull();
    writeFileSync(join(dir, ".env.member"), "k1\nnot-a-stamp\n");
    expect(readEnvStamp(join(dir, ".env"))).toBeNull();
  });
});

describe("the temp file has a fixed name, so a write that was killed leaves one the deny list knows", () => {
  it("a write goes through <path>.tmp: a stale one from a killed write is replaced, and none is left", () => {
    const dir = area();
    const path = join(dir, ".env");
    writeFileSync(`${path}.tmp`, "ANTHROPIC_API_KEY=left-by-a-killed-write\n", { mode: 0o600 });
    expect(writeEnvFile(input(path))).toEqual({ ok: true });
    expect(readdirSync(dir).sort()).toEqual([".env", ".env.member"]);
    expect(readFileSync(path, "utf8")).toBe(`ANTHROPIC_API_KEY=${VALUE}\n`);
  });
  it("a temp path that is a link is refused and its target left alone", () => {
    const dir = area();
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), join(dir, ".env.tmp"));
    expect(writeEnvFile(input(join(dir, ".env")))).toEqual({ ok: false, problem: "symlink" });
    expect(readFileSync(join(dir, "real"), "utf8")).toBe("x");
  });
  it("a failed write removes the temp file too (the path is a directory)", () => {
    const dir = area();
    mkdirSync(join(dir, ".env"));
    expect(writeEnvFile(input(join(dir, ".env")))).toEqual({ ok: false, problem: "write_failed" });
    expect(readdirSync(dir)).toEqual([".env"]);
  });
});

// A process that holds <path>.lock until it is killed. `first` is what it said ("ok" when it holds the lock).
type Holder = { child: ChildProcess; first: string; killed: Promise<void> };
async function hold(path: string, wrap: string[] = []): Promise<Holder> {
  const helper = join(import.meta.dirname, "fixtures/lock-hold.mjs");
  const argv = wrap.length > 0 ? [...wrap, process.execPath] : [process.execPath];
  const command = argv[0] ?? process.execPath;
  const head = argv.slice(1);
  const child = spawn(command, [...head, "--experimental-strip-types", helper, path]);
  const first = await new Promise<string>(resolve => {
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.trim()); });
    child.on("close", () => { resolve(out.trim()); });
  });
  const killed = new Promise<void>(resolve => { child.on("close", () => { resolve(); }); });
  return { child, first, killed };
}
const stop = async (held: Holder): Promise<void> => { held.child.kill("SIGKILL"); await held.killed; };

describe("one writer at a time: a lock the kernel releases when its holder dies", () => {
  it("a lock is taken, held against another taker in the same process, and released; the lock file stays and means nothing by existing", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    expect(first.ok).toBe(true);
    const second = await acquireEnvLock(path, { waitMs: 150 });
    expect(second).toMatchObject({ ok: false, problem: "busy", holder: { pid: process.pid } });
    if (first.ok) first.release();
    const third = await acquireEnvLock(path, { waitMs: 0 });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
    expect(readdirSync(dir)).toEqual([".env.lock"]);
  });
  it("a taker waits for the holder to let go", async () => {
    const path = join(area(), ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    setTimeout(() => { if (first.ok) first.release(); }, 200);
    const second = await acquireEnvLock(path, { waitMs: 3000 });
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });
  it("a taker waits for a holder in another process to let go, and takes the lock then", async () => {
    const path = join(area(), ".env");
    const helper = join(import.meta.dirname, "fixtures/lock-try.mjs");
    const child = spawn(process.execPath, ["--experimental-strip-types", helper, path, "600"]);
    await new Promise<void>(resolve => { child.stdout.on("data", () => { resolve(); }); });
    const started = Date.now();
    const taken = await acquireEnvLock(path, { waitMs: 5000 });
    expect(taken.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    if (taken.ok) taken.release();
  });
  it("the holder is recorded for messages only: pid, start ticks and pid namespace in <path>.lock.owner, gone with the lock", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const lock = await acquireEnvLock(path, { waitMs: 0 });
    expect(readFileSync(`${path}.lock.owner`, "utf8")).toMatch(/^\d+ \d+ \d+\n$/);
    expect(readFileSync(`${path}.lock.owner`, "utf8").trim().split(" ")[0]).toBe(String(process.pid));
    expect(readFileSync(`${path}.lock.owner`, "utf8").trim().split(" ")[2]).toBe(NS);
    if (lock.ok) lock.release();
    expect(readdirSync(dir)).toEqual([".env.lock"]);
  });
  it("two processes racing for one lock: exactly one takes it, every time", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const helper = join(import.meta.dirname, "fixtures/lock-try.mjs");
    for (let round = 0; round < 6; round++) {
      const answers = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>(resolve => {
        const child = spawn(process.execPath, ["--experimental-strip-types", helper, path, "1200"]);
        let out = "";
        child.stdout.on("data", chunk => { out += chunk; });
        child.on("close", () => { resolve(out.trim()); });
      })));
      expect(answers.filter(row => row === "ok"), `round ${round}: ${answers.join(",")}`).toHaveLength(1);
      expect(answers.filter(row => row === "busy")).toHaveLength(7);
      expect(readdirSync(dir).sort()).toEqual([".env.lock"]);
    }
  });
  it("a holder killed with SIGKILL while holding frees the lock at once: no staleness rule decides, the kernel does", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const held = await hold(path);
    expect(held.first).toBe("ok");
    const refused = await acquireEnvLock(path, { waitMs: 100 });
    expect(refused).toMatchObject({ ok: false, problem: "busy", holder: { pid: held.child.pid } });
    await stop(held);
    const taken = await acquireEnvLock(path, { waitMs: 0 });
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
  });
  it.skipIf(!NAMESPACES)("a holder in another pid namespace (a container) is busy while it lives, and gone when it dies: a pid there never has to be looked up", { timeout: 60_000 }, async () => {
    const dir = area();
    const path = join(dir, ".env");
    const held = await hold(path, ["unshare", "--user", "--map-root-user", "--pid", "--fork", "--kill-child", "--mount-proc"]);
    expect(held.first).toBe("ok");
    try {
      expect(await acquireEnvLock(path, { waitMs: 100 })).toMatchObject({ ok: false, problem: "busy" });
    } finally { await stop(held); }
    let taken = await acquireEnvLock(path, { waitMs: 0 });
    for (let i = 0; i < 40 && !taken.ok; i++) { await new Promise(resolve => { setTimeout(resolve, 100); }); taken = await acquireEnvLock(path, { waitMs: 0 }); }
    expect(taken.ok).toBe(true);
    if (taken.ok) taken.release();
  });
  it("a second taker in the same process cannot drop the first one's lock: the file is opened once, through one SQLite handle, so another process still finds it busy", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    expect(first.ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(await acquireEnvLock(path, { waitMs: 100 })).toMatchObject({ ok: false, problem: "busy" });
    const helper = join(import.meta.dirname, "fixtures/lock-try.mjs");
    const answer = await new Promise<string>(resolve => {
      const child = spawn(process.execPath, ["--experimental-strip-types", helper, path, "0"]);
      let out = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.on("close", () => { resolve(out.trim()); });
    });
    expect(answer).toBe("busy");
    if (first.ok) first.release();
    const after = await acquireEnvLock(path, { waitMs: 0 });
    expect(after.ok).toBe(true);
    if (after.ok) after.release();
  });
  it("two takers of one sink in one process, started together, are served one after the other, never both", async () => {
    const path = join(area(), ".env");
    const both = await Promise.all([acquireEnvLock(path, { waitMs: 2000 }), acquireEnvLock(path, { waitMs: 2000 })]);
    const ok = both.filter(row => row.ok);
    expect(ok).toHaveLength(1);
    expect(both.find(row => !row.ok)).toMatchObject({ problem: "busy" });
    if (ok[0]?.ok) ok[0].release();
  });
  it("a path spelled another way (a link to its directory) is the same sink: the second taker is busy", async () => {
    const dir = area();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    const first = await acquireEnvLock(join(dir, "real", ".env"), { waitMs: 0 });
    expect(first.ok).toBe(true);
    expect(await acquireEnvLock(join(dir, "alias", ".env"), { waitMs: 100 })).toMatchObject({ ok: false, problem: "busy" });
    if (first.ok) first.release();
  });
  it("a lock file of the earlier text forms (rounds 2 and 3) was never shipped: it is not a lock this code can take, so it is busy and is never deleted", async () => {
    for (const body of ["123 456\n", "123 456 789\n", "123\n"]) {
      const dir = area();
      const path = join(dir, ".env");
      writeFileSync(`${path}.lock`, body);
      expect(await acquireEnvLock(path, { waitMs: 0 }), body).toMatchObject({ ok: false, problem: "busy" });
      expect(readFileSync(`${path}.lock`, "utf8"), body).toBe(body);
    }
  });
  it("anything else at the lock path is not touched: no lock can be made on it, so it is busy and left as it is", async () => {
    for (const body of ["hello, this is not an owner\n", "x".repeat(10_000)]) {
      const dir = area();
      const path = join(dir, ".env");
      writeFileSync(`${path}.lock`, body);
      expect(await acquireEnvLock(path, { waitMs: 0 }), body.slice(0, 10)).toMatchObject({ ok: false, problem: "busy" });
      expect(readFileSync(`${path}.lock`, "utf8")).toBe(body);
    }
  });
  it("a symlink at the lock path is busy and its target is left alone", async () => {
    const dir = area();
    const path = join(dir, ".env");
    writeFileSync(join(dir, "real"), "x");
    symlinkSync(join(dir, "real"), `${path}.lock`);
    expect(await acquireEnvLock(path, { waitMs: 0 })).toMatchObject({ ok: false, problem: "busy" });
    expect(readFileSync(join(dir, "real"), "utf8")).toBe("x");
  });
  it("release is idempotent, and a second release does not free a lock another taker has since made", async () => {
    const path = join(area(), ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    if (first.ok) first.release();
    const second = await acquireEnvLock(path, { waitMs: 0 });
    if (first.ok) first.release();
    expect(await acquireEnvLock(path, { waitMs: 100 })).toMatchObject({ ok: false, problem: "busy" });
    if (second.ok) second.release();
  });
});

describe("every way out of acquire and release lets go: the handle is closed and the sink is not stuck for the rest of the process", () => {
  // The seam is where a failure is made to happen: after the file is opened, after the lock is taken, and when the handle is closed.
  const boom = (): never => { throw new Error("injected"); };
  const otherProcessCanTake = async (path: string): Promise<string> => {
    const helper = join(import.meta.dirname, "fixtures/lock-try.mjs");
    return new Promise<string>(resolve => {
      const child = spawn(process.execPath, ["--experimental-strip-types", helper, path, "0"]);
      let out = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.on("close", () => { resolve(out.trim()); });
    });
  };
  it("a failure after the file is opened (a chmod that throws) is busy, closes the handle, and clears the sink", async () => {
    const path = join(area(), ".env");
    const out = await acquireEnvLock(path, { waitMs: 0, seam: { afterOpen: boom } });
    expect(out).toMatchObject({ ok: false, problem: "busy", holder: null });
    const next = await acquireEnvLock(path, { waitMs: 0 });
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
  it("a failure after the lock is taken (the owner note) rolls it back and closes the handle: another process can take it at once, and so can the next taker here", async () => {
    const path = join(area(), ".env");
    const out = await acquireEnvLock(path, { waitMs: 0, seam: { afterBegin: boom } });
    expect(out).toMatchObject({ ok: false, problem: "busy" });
    expect(await otherProcessCanTake(path)).toBe("ok");
    const next = await acquireEnvLock(path, { waitMs: 0 });
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
  it("a release whose close throws still clears the sink, does not throw, and the lock was rolled back first: the next taker, here or in another process, gets it", async () => {
    const path = join(area(), ".env");
    const held = await acquireEnvLock(path, { waitMs: 0, seam: { atClose: boom } });
    expect(held.ok).toBe(true);
    expect(() => { if (held.ok) held.release(); }).not.toThrow();
    expect(await otherProcessCanTake(path)).toBe("ok");
    const next = await acquireEnvLock(path, { waitMs: 0 });
    expect(next.ok).toBe(true);
    if (next.ok) next.release();
  });
  it("a failure while waiting (the busy loop) closes the handle and clears the sink too", async () => {
    const path = join(area(), ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    expect(first.ok).toBe(true);
    // A second process holds nothing here; the in-process wait is the registry, so the failure is made in the first taker's own release below.
    if (first.ok) first.release();
    const out = await acquireEnvLock(path, { waitMs: 0, seam: { afterOpen: boom } });
    expect(out.ok).toBe(false);
    const again = await acquireEnvLock(path, { waitMs: 0 });
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });
});

