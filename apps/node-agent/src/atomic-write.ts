// A file written whole or not at all: the bytes go to a temporary file in the same directory, are flushed to disk,
// and the temporary file is renamed over the target (rename(2) is atomic within one file system). A crash leaves the
// old file or the new one, never half of one, and never a stray temporary file after an error.
// The running agent never fsyncs on its event loop (T-532: on a saturated disk one fsync held its only thread for over
// 12 s). A file that must outlive the machine goes through writeFileAtomicAsync, whose fsync runs on libuv's thread
// pool. Runtime state that a restart rewrites anyway (status.json, fleet-view.json) goes through writeFileReplace:
// atomic for its readers at once, not synced. The synced writeFileAtomic stays for the `join` CLI and callers that
// must block.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { mkdir, open as openAsync, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path: string, data: string, mode = 0o600): void { replace(path, data, mode, true); }

// Whole or not at all for whoever reads it (the rename), but not flushed: after a power loss it may hold the old
// content, or none. For a file the agent writes again when it starts, and that a reader judges by its own clock.
export function writeFileReplace(path: string, data: string, mode = 0o600): void { replace(path, data, mode, false); }

function replace(path: string, data: string, mode: number, sync: boolean): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  let open = true;                                      // closed once only: a second close could hit a reused descriptor
  try {
    writeSync(fd, data);
    if (sync) fsyncSync(fd);
    closeSync(fd);
    open = false;
    renameSync(tmp, path);
  } catch (e) {
    if (open) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
}

export async function writeFileAtomicAsync(path: string, data: string, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fh = await openAsync(tmp, "wx", mode);
  let open = true;                                      // closed once only: a second close could hit a reused descriptor
  try {
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    open = false;
    await rename(tmp, path);
  } catch (e) {
    if (open) await fh.close().catch(() => { /* a descriptor that failed to close is not closed twice */ });
    await rm(tmp, { force: true });
    throw e;
  }
}
