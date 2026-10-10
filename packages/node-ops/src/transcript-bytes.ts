// A transcript's bytes on this machine (docs/design/fleet-core/README.md §3.1): its size, a bounded read at an offset,
// and where the last line holding a needle starts. The hub's reader parses them (a pure parser over bytes); a node only
// serves them (`transcript.size`, `transcript.read`, `transcript.locate`), so it never interprets a transcript. Reads
// are at most one chunk (LIMITS.chunkBytes), what one fleet message carries.
import { open, stat, type FileHandle } from "node:fs/promises";
import { LIMITS } from "@morndo/protocol";

export type TranscriptBytes = {
  size(): Promise<number | null>;
  read(offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>;
  locate(needle: string): Promise<number | null>;
};

const LOCATE_STEP = 1 << 20;                                 // locate reads backwards this much at a time

async function openFile(path: string): Promise<FileHandle | null> {
  let fh: FileHandle;
  try { fh = await open(path, "r"); } catch { return null; }   // gone, or not ours to read
  if ((await fh.stat()).isFile()) return fh;
  await fh.close();
  return null;
}

// `length` bytes at `position`, fewer only where the file ends.
async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

// Where the line that runs through `pos` starts: just after the last newline before it, or 0.
async function lineStart(fh: FileHandle, pos: number): Promise<number> {
  while (pos > 0) {
    const start = Math.max(0, pos - LOCATE_STEP);
    const nl = (await readAt(fh, start, pos - start)).lastIndexOf(0x0a);
    if (nl !== -1) return start + nl + 1;
    pos = start;
  }
  return 0;
}

export function localTranscriptBytes(path: string): TranscriptBytes {
  return {
    // null: no file there to read
    async size() {
      try { const st = await stat(path); return st.isFile() ? st.size : null; } catch { return null; }
    },
    // At most `max` bytes from `offset`, and never more than one chunk; `eof`: nothing lies past them.
    async read(offset, max) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 0) throw new RangeError(`read(${offset}, ${max})`);
      const fh = await openFile(path);
      if (!fh) return null;
      try {
        const size = (await fh.stat()).size;
        const bytes = await readAt(fh, offset, Math.max(0, Math.min(max, LIMITS.chunkBytes, size - offset)));
        return { bytes, eof: offset + bytes.length >= size };
      } finally { await fh.close(); }
    },
    // The byte offset where the last line holding `needle` starts, or null. The search runs from the end backwards,
    // where the pages a reader asks for usually are, one window at a time; a needle across a window's edge is found.
    async locate(needle) {
      const n = Buffer.from(needle, "utf8");
      if (!n.length) return null;
      const fh = await openFile(path);
      if (!fh) return null;
      try {
        let end = (await fh.stat()).size;
        let after = Buffer.alloc(0);                         // the first bytes of the window after this one
        while (end > 0) {
          const start = Math.max(0, end - LOCATE_STEP);
          const buf = Buffer.concat([await readAt(fh, start, end - start), after]);
          const hit = buf.lastIndexOf(n);
          if (hit !== -1) {
            const nl = hit > 0 ? buf.lastIndexOf(0x0a, hit - 1) : -1;
            return nl !== -1 ? start + nl + 1 : await lineStart(fh, start);
          }
          after = buf.subarray(0, n.length - 1);
          end = start;
        }
        return null;
      } finally { await fh.close(); }
    },
  };
}
