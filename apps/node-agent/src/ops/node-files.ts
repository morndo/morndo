// Which files of this node the fleet may read (spec §3.1, §8): today's rules through node-ops' openConfined (symlinks
// resolved, credential places and the control plane's own state denied, secret names skipped, 25 MiB), with the
// agent's state directory as the data directory it denies, plus the agent's configuration directory, which holds the
// node's private key. openConfined opens the resolved path with O_NOFOLLOW and checks the open file again, so a link
// put in its place after the check is refused, never followed. Copies the hook relay made (relay-files) are read by
// their ref only, never by path, also with O_NOFOLLOW.
import { realpathSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { MAX_FILE_BYTES, SECRET_NAME, denyConfigFromEnv, openConfined, openNoFollow } from "@morndo/node-ops";

export type Opened = Awaited<ReturnType<typeof openConfined>>;

// A finished upload in the node's own inbox: the one place under the state directory the fleet may read (the hub
// copies the owner's image from here into its store). Judged on the resolved path, so a link out of the inbox is
// judged by its target; the partial uploads are not offered; the secret-name and size rules still apply.
async function openInbox(path: string, inboxDir: string): Promise<Opened | null> {
  if (!isAbsolute(path)) return null;
  let real: string;
  let root: string;
  try { real = realpathSync.native(path); root = realpathSync.native(inboxDir); } catch { return null; }
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) || rel.split(sep)[0] === ".partial") return null;
  if (SECRET_NAME.test(basename(real))) return { ok: false, reason: "secret" };
  let fh: FileHandle;
  try { fh = await openNoFollow(real); } catch { return { ok: false, reason: "denied" }; }
  const st = await fh.stat();
  const reason = !st.isFile() ? "not_file" : st.size > MAX_FILE_BYTES ? "too_large" : null;
  if (reason) { await fh.close(); return { ok: false, reason }; }
  return { ok: true, fh, real, size: st.size };
}

export function nodeOpener(o: { home: string; stateDir: string; configDir: string; inboxDir?: string; fileRoots?: string[] }): (path: string) => Promise<Opened> {
  const inConfig = (p: string) => p === o.configDir || p.startsWith(o.configDir + sep);
  return async path => {
    if (inConfig(path)) return { ok: false, reason: "denied" };
    if (o.inboxDir) { const inbox = await openInbox(path, o.inboxDir); if (inbox) return inbox; }
    const c = await openConfined(path, { home: o.home, dataDir: o.stateDir, deny: denyConfigFromEnv(process.env), ...(o.fileRoots ? { roots: o.fileRoots } : {}) });
    if (c.ok && inConfig(c.real)) { await c.fh.close(); return { ok: false, reason: "denied" }; }
    return c;
  };
}

// A relay copy by its ref (relay_files, written by the hook relay).
export function relayRef(db: Database.Database): (ref: string) => { file: string; size: number } | null {
  const q = db.prepare("SELECT file, size FROM relay_files WHERE ref = ?");
  return ref => (q.get(ref) as { file: string; size: number } | undefined) ?? null;
}

// A file of the agent's own (a relay copy): opened without following a link (node-ops' openNoFollow), and only if it
// is a regular file; null otherwise.
export async function openOwn(file: string): Promise<FileHandle | null> {
  let fh: FileHandle;
  try { fh = await openNoFollow(file); } catch { return null; }
  if ((await fh.stat()).isFile()) return fh;
  await fh.close();
  return null;
}

export async function readChunk(fh: FileHandle, offset: number, max: number): Promise<{ bytes: string; size: number; eof: boolean }> {
  const size = (await fh.stat()).size;
  const n = Math.max(0, Math.min(max, size - offset));
  const buf = Buffer.alloc(n);
  const { bytesRead } = n > 0 ? await fh.read(buf, 0, n, offset) : { bytesRead: 0 };
  return { bytes: buf.subarray(0, bytesRead).toString("base64"), size, eof: offset + bytesRead >= size };
}
