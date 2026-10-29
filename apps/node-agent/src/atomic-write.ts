// A file written whole or not at all: the bytes go to a temporary file in the same directory, are flushed to disk,
// and the temporary file is renamed over the target (rename(2) is atomic within one file system). A crash leaves the
// old file or the new one, never half of one, and never a stray temporary file after an error.
// The running agent uses the async one: its fsync runs on libuv's thread pool, not on the event loop (T-532), so a
// saturated disk cannot stall the agent's only thread on a status or fleet-view write. The sync one stays for the
// `join` CLI and callers that must block.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { mkdir, open as openAsync, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  let open = true;                                      // closed once only: a second close could hit a reused descriptor
  try {
    writeSync(fd, data);
    fsyncSync(fd);
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

// One file that many writes keep up to date (status.json, fleet-view.json): the writes run one at a time, in order,
// and one asked for while another still waits to start is folded into it; that one reads the content when it starts.
// So an older write that the disk held up never lands over a newer one, and a slow disk queues at most one. The
// promise settles once the latest write asked for so far has landed (or failed: `onError` has it, never the caller).
export function inOrder(onError: (e: unknown) => void): (write: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  let next: (() => Promise<void>) | null = null;
  return write => {
    if (next === null) {
      chain = chain.then(async () => {
        const run = next;
        next = null;
        if (run) await run();
      }).catch(onError);
    }
    next = write;
    return chain;
  };
}
