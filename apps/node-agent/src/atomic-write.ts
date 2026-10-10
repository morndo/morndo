// A file written whole or not at all: the bytes go to a temporary file in the same directory, are flushed to disk,
// and the temporary file is renamed over the target (rename(2) is atomic within one file system). A crash leaves the
// old file or the new one, never half of one, and never a stray temporary file after an error.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
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
