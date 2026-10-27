// The file a server's key is written to (ADR-0037, slice 4; plan 3.6): `NAME=value` through a temp file of fixed name, created 0600 and renamed
// over the old file, so a reader never sees half a file or a key anyone else can read. Nothing is written for a path in a git work tree, in a directory
// group or others can write, through a link, or under a protected directory. A name and a value are checked against a closed alphabet so that no quoting
// or escaping exists. A problem is a word; no path, value or system message is returned.
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { processIdentity } from "@morndo/node-ops";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CONNECTION_NAME } from "@morndo/domain";

export type EnvWrite = { path: string; name: string; value: string; member: string; protectedDirs: readonly string[] };
export type EnvWritten = { ok: true } | { ok: false; problem: string };

export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const VALUE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const GROUP_OTHERS_WRITE = 0o022;

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

function symlinked(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function realOf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function inRepository(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

// The word for what is wrong with the place, or null: checked before a lease is taken, and again by the write.
export function envPathProblem(path: string, protectedDirs: readonly string[]): string | null {
  if (!isAbsolute(path) || path.endsWith("/")) return "bad_path";
  if (symlinked(path) || symlinked(`${path}.member`)) return "symlink";
  const dir = dirname(path);
  let mode: number;
  try {
    const found = statSync(dir);
    if (!found.isDirectory()) return "no_dir";
    mode = found.mode;
  } catch { return "no_dir"; }
  // The real place is judged, not the spelling: a directory that is a link into a protected one is protected.
  if (protectedDirs.some(root => inside(realOf(root), join(realOf(dir), basename(path))))) return "protected";
  if (inRepository(dir)) return "in_repository";
  if ((mode & GROUP_OTHERS_WRITE) !== 0) return "dir_writable";
  return null;
}

function refusal(input: EnvWrite): string | null {
  if (!isAbsolute(input.path) || input.path.endsWith("/")) return "bad_path";
  if (!ENV_NAME.test(input.name)) return "bad_name";
  if (!VALUE.test(input.value)) return "bad_value";
  if (!CONNECTION_NAME.test(input.member)) return "bad_member";
  return envPathProblem(input.path, input.protectedDirs);
}

// A write passes through a fixed temp name, so one that was killed leaves a file the next write replaces and the deny list knows. The temp file
// is created 0600 before a byte goes in; rename makes it the file in one step. A failure removes the temp file and leaves the old file.
function writeThrough(temp: string, path: string, text: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    return true;
  } catch {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* never created */ }
    return false;
  }
}

export function writeEnvFile(input: EnvWrite): EnvWritten {
  const refused = refusal(input);
  if (refused !== null) return { ok: false, problem: refused };
  const keyTemp = `${input.path}.tmp`;
  const sideTemp = `${input.path}.member.tmp`;
  // A link in a temp file's place is written through never and removed never; a stale temp file of a killed write is replaced.
  if (symlinked(keyTemp) || symlinked(sideTemp)) return { ok: false, problem: "symlink" };
  for (const temp of [keyTemp, sideTemp]) { try { unlinkSync(temp); } catch { /* not there */ } }
  if (!writeThrough(keyTemp, input.path, `${input.name}=${input.value}\n`)) return { ok: false, problem: "write_failed" };
  // The sidecar is stamped with the file as just renamed, so a reader can tell this pair from one cut short or replaced since.
  let written: { ino: number; mtimeMs: number };
  try { written = statSync(input.path); } catch { return { ok: false, problem: "write_failed" }; }
  const at = Math.trunc(written.mtimeMs);
  const history = [...earlier(input.path), { at, member: input.member }].slice(-HISTORY_MAX);
  const text = `${input.member}\n${written.ino}:${at}\n${history.map(row => `${row.at} ${row.member}\n`).join("")}`;
  if (!writeThrough(sideTemp, `${input.path}.member`, text)) return { ok: false, problem: "write_failed" };
  return { ok: true };
}

// What a sidecar says: the member whose key was last written, whether the pair still agrees, when the file was written, and the last writes
// (newest last) so that the key a server loaded at its start can be named. Null when there is no pair to read, or the sidecar is not a stamp.
export type EnvStamp = { member: string; consistent: boolean; writtenAt: number; history: { at: number; member: string }[] };
const HISTORY_MAX = 8;

function parseSidecar(text: string): { member: string; stamp: string; history: { at: number; member: string }[] } | null {
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const member = lines[0];
  const stamp = lines[1];
  if (lines.length < 2 || member === undefined || stamp === undefined || !CONNECTION_NAME.test(member) || !/^\d+:\d+$/.test(stamp)) return null;
  const history: { at: number; member: string }[] = [];
  for (const line of lines.slice(2)) {
    const match = /^(\d+) (\S+)$/.exec(line);
    if (!match || !CONNECTION_NAME.test(match[2] ?? "")) return null;
    history.push({ at: Number(match[1]), member: match[2] ?? "" });
  }
  return { member, stamp, history };
}

// The writes on record before a new one, whether or not the file still agrees with them.
function earlier(path: string): { at: number; member: string }[] {
  try { return parseSidecar(readFileSync(`${path}.member`, "utf8"))?.history ?? []; } catch { return []; }
}

export function readEnvStamp(path: string): EnvStamp | null {
  let file: ReturnType<typeof statSync>;
  let side: string;
  try {
    file = statSync(path);
    side = readFileSync(`${path}.member`, "utf8");
  } catch { return null; }
  const parsed = parseSidecar(side);
  if (parsed === null) return null;
  const at = Math.trunc(file.mtimeMs);
  return {
    member: parsed.member, consistent: parsed.stamp === `${file.ino}:${at}`, writtenAt: file.mtimeMs,
    history: parsed.history.length > 0 ? parsed.history : [{ at, member: parsed.member }],
  };
}

// The key a server holds is the one in the file when it started: the member of the last write at or before its start. A start known only to the clock's
// resolution is a window, and a write inside it cannot be told apart from one the server started after, so nobody is blamed. Nobody when the pair does
// not agree, or the server started before the first write on record.
export function memberLoadedAt(stamp: { consistent: boolean; history: readonly { at: number; member: string }[] }, start: number | { from: number; to: number }): string | null {
  if (!stamp.consistent) return null;
  const { from, to } = typeof start === "number" ? { from: start, to: start } : start;
  if (stamp.history.some(row => from < row.at && row.at <= to)) return null;
  let found: string | null = null;
  for (const row of stamp.history) if (row.at <= from) found = row.member;
  return found;
}

const LOCK_POLL_MS = 50;

// The pid namespace this process runs in, as a number: an owner in another namespace cannot be looked up here.
function pidNamespace(): number | null {
  let link: string | null;
  try { link = readlinkSync("/proc/self/ns/pid"); } catch { return null; }
  const ns = Number(/\[(\d+)\]/.exec(link)?.[1]);
  return Number.isInteger(ns) && ns > 0 ? ns : null;
}

// The lock names its owner by pid, start ticks and pid namespace, so a pid that was reused, or lives where we cannot look it up, is not mistaken for the owner.
function ownerText(): string | null {
  const id = processIdentity(process.pid);
  const ns = pidNamespace();
  return id !== null && ns !== null ? `${process.pid} ${id.ticks} ${ns}\n` : null;
}

// The lock is created with its owner already in it: written to a temp file and linked into place, so there is no moment at which it exists empty.
// A stale lock is taken over by one rename of the exact file that was read, so a newer lock that appeared meanwhile is put back, never removed.
function tryEnvLock(lock: string, beforeTakeover?: () => void): "taken" | "busy" | "retry" {
  const owner = ownerText();
  if (owner === null) return "busy";
  const temp = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeSync(fd, owner); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, lock);
    return "taken";
  } catch { /* held, or the directory is not ours to write in */ } finally {
    try { unlinkSync(temp); } catch { /* never made */ }
  }
  // A symlink at the lock path is never removed, so it can never be taken over either.
  if (symlinked(lock)) return "busy";
  let text: string;
  try { text = readFileSync(lock, "utf8"); } catch { return "busy"; }
  // Stale means provably gone and nothing else: the lock must name our pid namespace (the older two-field form is an unknown namespace), and then the
  // pid must be gone, or belong to another process than the one that took the lock. An empty, partial or unreadable lock is an unknown owner, and a
  // live owner is never stale however old the lock.
  const match = /^(\d+) (\d+) (\d+)\n$/.exec(text);
  const mine = pidNamespace();
  if (!match || mine === null || Number(match[3]) !== mine) return "busy";
  const live = processIdentity(Number(match[1]));
  if (live !== null && String(live.ticks) === match[2]) return "busy";
  // Another taker may have removed it and made its own meanwhile: move the exact file that was read aside, and remove it only after checking it is
  // still the stale one.
  beforeTakeover?.();
  const grave = `${lock}.stale.${process.pid}.${randomBytes(6).toString("hex")}`;
  try { renameSync(lock, grave); } catch { return "retry"; }
  let moved: string;
  try { moved = readFileSync(grave, "utf8"); } catch {
    try { unlinkSync(grave); } catch { /* already gone */ }
    return "retry";
  }
  if (moved !== text) {
    // A newer, live lock was moved: put it back where it stood and wait for its holder.
    try { linkSync(grave, lock); } catch { /* another lock already stands */ }
    try { unlinkSync(grave); } catch { /* already gone */ }
    return "busy";
  }
  try { unlinkSync(grave); } catch { /* already gone */ }
  return "retry";
}

// One writer at a time: the lock file names its owner by pid, start ticks and pid namespace. A holder in another namespace is never taken over; a
// stale one is taken over through a rename that cannot hit a newer lock. A live holder is waited for until waitMs has passed. `release` is idempotent,
// ignores a lock already gone, and removes only the lock this process wrote.
export async function acquireEnvLock(path: string, options: { waitMs: number; beforeTakeover?: () => void }): Promise<{ ok: true; release(): void } | { ok: false; problem: "busy" }> {
  const lock = `${path}.lock`;
  const began = Date.now();
  for (;;) {
    const taken = tryEnvLock(lock, options.beforeTakeover);
    if (taken === "taken") {
      let released = false;
      const owner = ownerText();
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          try { if (owner !== null && readFileSync(lock, "utf8") === owner) unlinkSync(lock); } catch { /* already gone */ }
        },
      };
    }
    if (taken === "busy" && Date.now() - began >= options.waitMs) return { ok: false, problem: "busy" };
    await new Promise<void>(resolve => { setTimeout(resolve, LOCK_POLL_MS); });
  }
}
