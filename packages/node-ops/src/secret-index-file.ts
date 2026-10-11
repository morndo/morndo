// The index file adapter (ADR-0022; design §8.1): reads the index the Secrets service writes and hands the scanner its
// entries. One descriptor, opened without following a link and without blocking, is checked and read, so the file can't
// be swapped between the check and the read: a regular file, owned by this user, with no group or other bits (0600 or
// tighter). Without O_NONBLOCK, opening a FIFO would wait for a writer and hang every output path that reads the index.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { emptySecretIndex, parseIndex, type SecretIndex } from "./secret-scan.ts";

export type IndexFileProblem = "mode" | "owner" | "kind" | "format";
export class IndexFileRefused extends Error {
  readonly problem: IndexFileProblem;
  constructor(problem: IndexFileProblem, path: string) {
    super(`refused ${path}: ${problem}`);
    this.name = "IndexFileRefused";
    this.problem = problem;
  }
}

// No file reads as an empty index: no Secret has been stored on this node yet (the writer creates it before the first
// store confirms). A link (O_NOFOLLOW gives ELOOP) and a socket (ENXIO) are refused as the wrong kind of file; a FIFO, a
// device or a directory opens at once and is refused by its fstat.
export function readSecretIndex(path: string, uid: number = process.getuid?.() ?? -1): SecretIndex {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptySecretIndex();
    if (code === "ELOOP" || code === "ENXIO") throw new IndexFileRefused("kind", path);
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new IndexFileRefused("kind", path);
    if (st.uid !== uid) throw new IndexFileRefused("owner", path);
    if ((st.mode & 0o077) !== 0) throw new IndexFileRefused("mode", path);
    const index = parseIndex(readFileSync(fd, "utf8"));
    if (!index) throw new IndexFileRefused("format", path);
    return index;
  } finally {
    closeSync(fd);
  }
}
