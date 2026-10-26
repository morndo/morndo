// The file a server's key is written to (ADR-0037, slice 4; plan 3.6): `NAME=value` through a temp file of fixed name, created 0600 and renamed
// over the old file, so a reader never sees half a file or a key anyone else can read. Nothing is written for a path in a git work tree, in a directory
// group or others can write, through a link, or under a protected directory. A name and a value are checked against a closed alphabet so that no quoting
// or escaping exists. A problem is a word; no path, value or system message is returned.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
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
  if (!writeThrough(sideTemp, `${input.path}.member`, `${input.member}\n${written.ino}:${Math.trunc(written.mtimeMs)}\n`)) return { ok: false, problem: "write_failed" };
  return { ok: true };
}

// The stamp a sidecar carries of the file it is about: the member whose key it names, when that file was written, and whether
// the pair still agrees. Null when there is no pair to read, or the sidecar is not a member name and an inode:mtime stamp.
export function readEnvStamp(path: string): { member: string; consistent: boolean; writtenAt: number } | null {
  let file: ReturnType<typeof statSync>;
  let side: string;
  try {
    file = statSync(path);
    side = readFileSync(`${path}.member`, "utf8");
  } catch { return null; }
  const lines = (side.endsWith("\n") ? side.slice(0, -1) : side).split("\n");
  const member = lines[0];
  const stamp = lines[1];
  if (lines.length !== 2 || member === undefined || stamp === undefined || !CONNECTION_NAME.test(member) || !/^\d+:\d+$/.test(stamp)) return null;
  return { member, consistent: stamp === `${file.ino}:${Math.trunc(file.mtimeMs)}`, writtenAt: file.mtimeMs };
}

const LOCK_POLL_MS = 50;
const LOCK_STALE_MS = 10 * 60_000;

// EPERM says the process is there but not ours to signal; only ESRCH says it is gone.
function alivePid(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH"); }
}

function tryEnvLock(lock: string): "taken" | "busy" | "retry" {
  try {
    const fd = openSync(lock, "wx", 0o600);
    try { writeSync(fd, `${process.pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    return "taken";
  } catch { /* held */ }
  // A symlink at the lock path is never removed, so it can never be taken over either.
  if (symlinked(lock)) return "busy";
  let pid = Number.NaN;
  let at = Number.NaN;
  try {
    pid = Number(readFileSync(lock, "utf8").trim());
    at = statSync(lock).mtimeMs;
  } catch { return "busy"; }
  if (Number.isInteger(pid) && pid > 0 && alivePid(pid) && Date.now() - at < LOCK_STALE_MS) return "busy";
  try { unlinkSync(lock); } catch { /* taken over meanwhile */ }
  return "retry";
}

// One writer at a time: the lock file holds the writer's pid. A holder that is gone, or a lock older than ten minutes, is stale and taken
// over; a live holder is waited for until waitMs has passed. `release` is idempotent and ignores a lock already gone.
export async function acquireEnvLock(path: string, options: { waitMs: number }): Promise<{ ok: true; release(): void } | { ok: false; problem: "busy" }> {
  const lock = `${path}.lock`;
  const began = Date.now();
  for (;;) {
    const taken = tryEnvLock(lock);
    if (taken === "taken") {
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          try { unlinkSync(lock); } catch { /* already gone */ }
        },
      };
    }
    if (taken === "busy" && Date.now() - began >= options.waitMs) return { ok: false, problem: "busy" };
    await new Promise<void>(resolve => { setTimeout(resolve, LOCK_POLL_MS); });
  }
}
