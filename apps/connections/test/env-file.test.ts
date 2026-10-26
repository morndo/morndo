// The file a server's key is written to (ADR-0037, slice 4; plan 3.6): `NAME=value` through a temp file in the same directory, 0600 from the moment it is
// created, then renamed over the old one, so a reader never sees half a file or a key anyone else can read. A path in a repository, in a directory
// others can write, through a link, or under a protected directory is refused before anything is written. The sidecar names the member the key is of.
import { renameSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireEnvLock, readEnvStamp, writeEnvFile } from "../src/adapters/env-file.ts";

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
    expect(readFileSync(`${path}.member`, "utf8")).toMatch(/^k1\n\d+:\d+\n$/);
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
    expect(stamp).toEqual({ member: "k7", consistent: true, writtenAt: statSync(path).mtimeMs });
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

describe("one writer at a time: <path>.lock", () => {
  it("a lock is taken, held against another taker, and released", async () => {
    const dir = area();
    const path = join(dir, ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    expect(first.ok).toBe(true);
    expect(readdirSync(dir)).toEqual([".env.lock"]);
    expect(await acquireEnvLock(path, { waitMs: 150 })).toEqual({ ok: false, problem: "busy" });
    if (first.ok) first.release();
    expect(readdirSync(dir)).toEqual([]);
    const second = await acquireEnvLock(path, { waitMs: 0 });
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });
  it("a taker waits for the holder to let go", async () => {
    const path = join(area(), ".env");
    const first = await acquireEnvLock(path, { waitMs: 0 });
    setTimeout(() => { if (first.ok) first.release(); }, 200);
    const second = await acquireEnvLock(path, { waitMs: 3000 });
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
  });
  it("a lock whose holder is gone is taken over; so is one older than ten minutes", async () => {
    const dir = area();
    const path = join(dir, ".env");
    writeFileSync(`${path}.lock`, "2147483646\n");
    const gone = await acquireEnvLock(path, { waitMs: 0 });
    expect(gone.ok).toBe(true);
    if (gone.ok) gone.release();
    writeFileSync(`${path}.lock`, `${process.pid}\n`);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(`${path}.lock`, old, old);
    const stale = await acquireEnvLock(path, { waitMs: 0 });
    expect(stale.ok).toBe(true);
    if (stale.ok) stale.release();
  });
  it("a lock held by a live process is not taken over", async () => {
    const path = join(area(), ".env");
    writeFileSync(`${path}.lock`, `${process.pid}\n`);
    expect(await acquireEnvLock(path, { waitMs: 100 })).toEqual({ ok: false, problem: "busy" });
  });
});
