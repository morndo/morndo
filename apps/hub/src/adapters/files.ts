// The hub's own copies of the files agents send and the principal attaches (ADR-0006 addendum "Files"). A copy is made
// the first time a file is seen in a transcript, so the chat keeps showing what was sent after the original (often in
// a temporary scratchpad) is gone. Copies are content-addressed (SHA-256), live under the hub's data directory, and are
// served only by id, never by path.
// Refused whatever a transcript says: anything over the size cap, anything that isn't a regular file, and anything
// where credentials live (the deny list, checked on the resolved real path, so a symbolic link doesn't get around it).
// A copy is made in the background (fleet core §3.1): register() answers once it has landed, and the event loop is never
// blocked by a 25 MiB read (stream.pipeline with an async generator: https://nodejs.org/docs/latest-v24.x/api/stream.html#streampipelinesource-transforms-destination-options, read 2026-10-06).
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { realpath, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AttachmentKind } from "@morndo/domain";
import { MAX_FILE_BYTES, SECRET_NAME, deniedBy, openNoFollow, resolvedRoots } from "@morndo/node-ops";
import { describeFile } from "./file-kinds.ts";

export type StoredFile = { id: string; name: string; mime: string; kind: AttachmentKind; size: number };
export type Origin = { key: string; mtimeMs: number };            // where a copy came from, when that is not the path read
export type Files = {
  register(path: string, origin?: Origin): Promise<{ id: string | null; size: number | null }>;
  known(key: string): { id: string; size: number; mtimeMs: number } | null;
  get(id: string): { file: string; meta: StoredFile } | null;
};

const BUDGET_BYTES = 2 * 1024 ** 3;                    // not 2 << 30: shifts are 32-bit in JavaScript
// The rules themselves (the size cap, secret names, the deny list) are @morndo/node-ops' file-rules.ts.

type Index = { meta: Record<string, StoredFile>; byPath: Record<string, { id: string; size: number; mtimeMs: number }> };

export function fileStore(opts: { dir: string; deny: string[]; maxBytes?: number; budgetBytes?: number }): Files {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
  const budget = opts.budgetBytes ?? BUDGET_BYTES;
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const indexFile = join(opts.dir, "index.json");
  let index: Index = { meta: {}, byPath: {} };
  try { index = JSON.parse(readFileSync(indexFile, "utf8")) as Index; } catch { /* first start, or a bad index: start empty */ }
  const save = () => { const tmp = `${indexFile}.tmp`; writeFileSync(tmp, JSON.stringify(index)); renameSync(tmp, indexFile); };
  // The deny roots as given and resolved (node-ops' resolvedRoots, as a node's confine and lane.start judge them; final
  // review M10's twin here, the residual round): a real path never runs through a symbolic link, so a HOME behind one
  // (macOS keeps temporary folders under /var, a link to /private/var) would otherwise let its ~/.ssh through by its
  // real path. Resolved at each check, as node-ops does, so a root made after the hub started is caught too.
  const denied = (real: string) => SECRET_NAME.test(basename(real)) || deniedBy(real, resolvedRoots(opts.deny));

  // Oldest copies go first once the store is over its budget.
  function prune() {
    const files = Object.values(index.meta).map(m => ({ m, at: (() => { try { return statSync(join(opts.dir, m.id)).mtimeMs; } catch { return 0; } })() }))
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((n, f) => n + f.m.size, 0);
    for (const f of files) {
      if (total <= budget) break;
      try { unlinkSync(join(opts.dir, f.m.id)); } catch { /* gone */ }
      delete index.meta[f.m.id];
      for (const [p, e] of Object.entries(index.byPath)) if (e.id === f.m.id) delete index.byPath[p];
      total -= f.m.size;
    }
  }

  // The bytes pass once through SHA-256 on their way into a temporary file, which then becomes the copy named by the
  // hash (or goes, when that copy is there already). A file that grows past the cap while it is read is refused.
  async function register(path: string, origin?: Origin): Promise<{ id: string | null; size: number | null }> {
    const known = index.byPath[path];
    let real: string;
    let st: Stats;
    try { real = await realpath(path); st = await stat(real); }
    catch { return known && index.meta[known.id] ? { id: known.id, size: known.size } : { id: null, size: null }; }   // gone: the copy, if any
    if (!st.isFile() || st.size > maxBytes || denied(real) || denied(path)) return { id: null, size: st.isFile() ? st.size : null };
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && index.meta[known.id]) return { id: known.id, size: known.size };
    // Opened without following a link in the last component, then the open file must be the file that was judged
    // (same device and inode): a parent directory swapped for a link after the check opens another file and is refused.
    let fh: FileHandle;
    try {
      fh = await openNoFollow(real);
      const opened = await fh.stat();
      if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) { await fh.close(); return { id: null, size: null }; }
    } catch { return { id: null, size: null }; }
    const tmp = join(opts.dir, `.incoming-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(fh.createReadStream(), async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) throw new Error("the file grew past the size cap while it was copied");
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(tmp, { mode: 0o600 }));
    } catch {
      await rm(tmp, { force: true });
      return { id: null, size: size > maxBytes ? size : null };
    }
    const id = hash.digest("hex").slice(0, 32);
    const dest = join(opts.dir, id);
    if (existsSync(dest)) await rm(tmp, { force: true });
    else await rename(tmp, dest);
    index.meta[id] ??= { id, size, ...describeFile(path) };
    index.byPath[origin?.key ?? path] = { id, size, mtimeMs: origin?.mtimeMs ?? st.mtimeMs };
    prune();
    save();
    return index.meta[id] ? { id, size } : { id: null, size };
  }

  return {
    register,
    known(key) {
      const e = index.byPath[key];
      return e && index.meta[e.id] && existsSync(join(opts.dir, e.id)) ? { ...e } : null;
    },
    get(id) {
      if (!/^[0-9a-f]{32}$/.test(id)) return null;
      const meta = index.meta[id];
      const file = join(opts.dir, id);
      return meta && existsSync(file) ? { file, meta } : null;
    },
  };
}

// How a copy is served: never as a page of the hub's origin. Everything but PDF is sandboxed (no scripts, an opaque
// origin), so an SVG or anything else opened in its own tab can't act as the principal; Chrome's PDF viewer refuses a
// sandboxed document, so PDFs get a CSP that allows nothing instead. Text is served as text/plain.
export function servingHeaders(meta: StoredFile, download: boolean): Record<string, string> {
  const inline = !download && meta.kind !== "file";
  return {
    "Content-Type": meta.mime,
    "Content-Length": String(meta.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    "Content-Security-Policy": meta.kind === "pdf" ? "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
      : "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=31536000, immutable",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

// For a check: every copy the store holds (ids).
export const storedIds = (dir: string) => readdirSync(dir).filter(f => /^[0-9a-f]{32}$/.test(f));
