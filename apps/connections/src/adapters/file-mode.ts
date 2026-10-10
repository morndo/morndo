// A vault file is 0600 and a vault directory is 0700, both owned by this user (design section 5).
// Anything looser, or owned by someone else, is refused before it is read.
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export class FileRefused extends Error {
  readonly reason: "mode" | "owner";
  constructor(reason: "mode" | "owner", path: string) {
    super(reason === "mode" ? `${path} is looser than a private file` : `${path} is owned by someone else`);
    this.name = "FileRefused";
    this.reason = reason;
  }
}

// Missing paths are left for the caller. A path that exists must be private.
export function assertPrivate(path: string, kind: "file" | "dir", uid: number): void {
  let mode: number;
  let owner: number;
  try {
    const st = statSync(path);
    mode = st.mode & 0o777;
    owner = st.uid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (owner !== uid) throw new FileRefused("owner", path);
  const limit = kind === "dir" ? 0o700 : 0o600;
  if ((mode & ~limit) !== 0) throw new FileRefused("mode", path);
}

// A directory this process creates is 0700. One that already exists is only checked: ownership first,
// then the mode. It is never chmod'd, so a home directory cannot be tightened by accident.
export function ensurePrivateDir(dir: string, uid: number): void {
  refuseBareDirectory(dir);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      assertPrivate(dir, "dir", uid);
      return;
    }
    if (code !== "ENOENT") throw error;
    ensurePrivateDir(dirname(dir), uid);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (again) {
      if ((again as NodeJS.ErrnoException).code === "EEXIST") {
        assertPrivate(dir, "dir", uid);
        return;
      }
      throw again;
    }
  }
  if (statSync(dir).uid !== uid) throw new FileRefused("owner", dir);
  chmodSync(dir, 0o700);
  assertPrivate(dir, "dir", uid);
}

export function refuseBareHome(path: string, home = homedir()): void {
  const target = resolve(path);
  const root = resolve(home);
  const config = resolve(root, ".config");
  const parent = resolve(dirname(path));
  if (target === root || target === config || parent === root || parent === config) {
    throw new Error(`${path} must not sit directly in the home directory or in ~/.config`);
  }
}

function refuseBareDirectory(dir: string): void {
  const target = resolve(dir);
  const root = resolve(homedir());
  if (target === root || target === resolve(root, ".config")) {
    throw new Error(`${dir} must not sit directly in the home directory or in ~/.config`);
  }
}

export const durable = { fsync: fsyncSync };

function writeTemp(dir: string, name: string, bytes: Uint8Array, uid: number): string {
  const tmp = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try { writeSync(fd, bytes); durable.fsync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    assertPrivate(tmp, "file", uid);
    return tmp;
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp is already gone */ }
    throw error;
  }
}

export function writePrivate(path: string, bytes: Uint8Array, uid: number): void {
  refuseBareHome(path);
  const dir = dirname(path);
  ensurePrivateDir(dir, uid);
  const tmp = writeTemp(dir, basename(path), bytes, uid);
  try { renameSync(tmp, path); fsyncDir(dir); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
  assertPrivate(path, "file", uid);
}

// Two files land in a fixed order: both temps are durable before the first rename, then the
// ciphertext, then the fingerprint. A reader checks the fingerprint against the ciphertext.
export function writePrivatePair(first: string, firstBytes: Uint8Array, second: string, secondBytes: Uint8Array, uid: number): void {
  const dir = dirname(first);
  if (dirname(second) !== dir) throw new Error("paired files must share a directory");
  ensurePrivateDir(dir, uid);
  const firstTemp = writeTemp(dir, basename(first), firstBytes, uid);
  let secondTemp: string | null = null;
  try {
    secondTemp = writeTemp(dir, basename(second), secondBytes, uid);
    renameSync(firstTemp, first);
    fsyncDir(dir);
    renameSync(secondTemp, second);
    fsyncDir(dir);
  } finally {
    if (existsSync(firstTemp)) unlinkSync(firstTemp);
    if (secondTemp && existsSync(secondTemp)) unlinkSync(secondTemp);
  }
  assertPrivate(first, "file", uid);
  assertPrivate(second, "file", uid);
}

// link(2) fails with EEXIST instead of replacing, so two creators cannot overwrite each other.
// The first writer wins; the caller reads that file. O_EXCL on the temp file too.
export function writeNew(path: string, bytes: Uint8Array, uid: number): boolean {
  refuseBareHome(path);
  const dir = dirname(path);
  ensurePrivateDir(dir, uid);
  const tmp = writeTemp(dir, basename(path), bytes, uid);
  try {
    try { linkSync(tmp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    fsyncDir(dir);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
  assertPrivate(path, "file", uid);
  return true;
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { durable.fsync(fd); } finally { closeSync(fd); }
}

export function readPrivate(path: string, uid: number): Uint8Array {
  assertPrivate(dirname(path), "dir", uid);
  assertPrivate(path, "file", uid);
  return new Uint8Array(readFileSync(path));
}
