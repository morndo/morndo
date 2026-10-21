// A tar.gz whose bytes depend only on the file bytes, their modes and the commit time (design §9.3:
// fixed order, owner and timestamp). gzip's header time is 0, which is what `gzip -n` writes and
// what Node's gzipSync emits for `mtime: 0` (nodejs.org/api/zlib.html, read 2026-10-13). Paths that
// fit in a ustar header stay there; a longer path gets one POSIX pax record so GNU tar and bsdtar
// both extract it. Owner and group are 0. No name, no atime.
import { gzipSync } from "node:zlib";

export type TreeFile =
  | { path: string; mode: "0444" | "0555"; bytes: Uint8Array }
  | { path: string; mode: "0555"; link: string }
  | { path: string; mode: "0555"; directory: true };

const BLOCK = 512;

export function packTree(files: readonly TreeFile[], mtimeSec: number): Buffer {
  if (!Number.isInteger(mtimeSec) || mtimeSec < 0) throw new Error("refusing a commit time that is not a whole second");
  const seen = new Map<string, { path: string; dir: boolean }>();   // every path that lands in the archive, by folded key
  const linkTargets = new Map<string, string>();   // every link's folded key -> its target
  const linkList: { path: string; target: string }[] = [];
  const dirs = new Set<string>();
  // A name is claimed once; only a directory may be named twice (explicitly and as someone's parent). Two
  // spellings that fold to one key are two entries in the archive but one file on a folding file system (APFS:
  // case, NFC/NFD), so such a pair is refused here — the reader refuses it too, and no real tree holds one (no
  // name in this repository's node_modules or Node's distribution collides once folded, checked 2026-10-21).
  const take = (path: string, dir: boolean): void => {
    const known = seen.get(foldKey(path));
    if (known === undefined) { seen.set(foldKey(path), { path, dir }); return; }
    if (known.path !== path) throw new Error(`names that collide when case and Unicode form are folded: ${known.path}, ${path}`);
    if (!(known.dir && dir)) throw new Error(`duplicate path ${path}`);
  };
  for (const file of files) {
    assertTreePath(file.path);
    if ("link" in file && linkLeaves(file.path, file.link)) {
      throw new Error(`refusing link target ${file.link}`);
    }
    take(file.path, "directory" in file);
    if ("link" in file) {
      linkTargets.set(foldKey(file.path), file.link);
      linkList.push({ path: file.path, target: file.link });
    }
    if ("directory" in file) dirs.add(`${file.path}/`);
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      take(parent, true);
      dirs.add(`${parent}/`);
    }
  }
  for (const { path, target } of linkList) {
    const escape = linkThroughTree(linkTargets, path, target);
    if (escape !== null) throw new Error(`refusing link ${path} -> ${target}: ${escape}`);
  }
  type Packed = Exclude<TreeFile, { directory: true }>;
  const isPacked = (file: TreeFile): file is Packed => !("directory" in file);
  type Entry = { path: string; dir: true } | { path: string; dir: false; file: Packed };
  const entries: Entry[] = [
    ...[...dirs].map(path => ({ path, dir: true as const })),
    ...files.filter(isPacked).map(file => ({ path: file.path, dir: false as const, file })),
  ];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  let pax = 0;
  const emit = (path: string, mode: number, type: string, body: Uint8Array | null, link = "") => {
    const size = body?.length ?? 0;
    const split = splitUstar(path);
    if (!split) {
      pax += 1;
      const record = paxRecord("path", path);
      chunks.push(header({ name: `PaxHeaders/${pax}`, prefix: "", size: Buffer.byteLength(record), mtime: mtimeSec, mode: 0o644, type: "x" }));
      chunks.push(pad(Buffer.from(record)));
      const base = path.replace(/\/$/, "").split("/").pop() ?? "file";
      const name = type === "5" ? `${base.slice(-99)}/` : base.slice(-100);
      chunks.push(header({ name, prefix: "", size, mtime: mtimeSec, mode, type, link }));
    } else {
      chunks.push(header({ name: split.name, prefix: split.prefix, size, mtime: mtimeSec, mode, type, link }));
    }
    if (body && body.length > 0) chunks.push(pad(Buffer.from(body)));
  };
  for (const entry of entries) {
    if (entry.dir) emit(entry.path, 0o755, "5", null);
    else if ("link" in entry.file) emit(entry.path, 0o755, "2", null, entry.file.link);
    else emit(entry.path, parseInt(entry.file.mode, 8), "0", Buffer.from(entry.file.bytes));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  // gzipSync writes header mtime 0 (gzip -n). ZlibOptions has no mtime field (@types/node 24);
  // passing one is ignored on Node 24.5.0, checked 2026-10-13.
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function linkLeaves(path: string, target: string): boolean {
  if (target.startsWith("/") || target.split("/").includes("")) return true;
  const stack = path.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (stack.length === 0) return true;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return false;
}

// A path's key: its spelling with case and Unicode form folded (below), the reader's rule of
// 2026-10-21. A file system may treat two spellings as one name — APFS, macOS's default, folds both — so names
// are compared by key here too, whatever system the archive is later unpacked on.
// Folded as far as a file system might: NFKC first (compatibility forms such as the ﬁ ligature become fi), then upper
// and back to lower case (ß becomes SS then ss; ς and σ both become Σ then σ), then NFC so composed and decomposed
// accents meet. Folding more only ever refuses an odd archive; folding less would let two spellings of one file
// through (review of 2026-10-21). No name in this repository's node_modules, apps, packages or Node 24.21.0's
// distribution collides under this fold (22,921 paths, checked 2026-10-21).
const foldKey = (path: string): string => path.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");

// The walk the reader (apps/updater/src/adapters/tar-read.ts) does once the archive is known: the target is
// followed through the tree's own links, each ".." applying after the link before it was substituted (the
// kernel's rule, path_resolution(7)), with names looked up by folded key so a differently spelled name still
// finds its link: `esc -> P/UP/..` climbs out where `p/up -> ..` is a normal parent link. `links` maps a link's
// folded key to its target. Returns the refusal reason, or null when the target ends inside the tree.
const LINK_STEPS = 40;   // Linux caps one lookup at 40 traversals (ELOOP); more substitutions than that is a loop
export function linkThroughTree(links: ReadonlyMap<string, string>, path: string, target: string): string | null {
  const stack = path.split("/").slice(0, -1);   // where the walk stands: the link's own directory at first
  const rest = [...target.split("/")];
  let steps = 0;
  while (rest.length > 0) {
    const part = rest.shift()!;
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (stack.length === 0) return "it leaves the tree through another link";
      stack.pop();
      continue;
    }
    const own = links.get(foldKey([...stack, part].join("/")));
    if (own === undefined) { stack.push(part); continue; }
    steps += 1;
    if (steps > LINK_STEPS) return "a link loop";
    rest.unshift(...own.split("/"));   // the substituted target walks from the stack as it stands: its link's own directory
  }
  return null;
}

export function assertTreePath(path: string): void {
  if (path.startsWith("/") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`refusing path ${path}`);
  }
}

function splitUstar(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (name.length > 0 && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

// A pax record's length counts itself (`<len> <key>=<value>\n`), so the digit width is found by growing it.
function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let digits = 1;
  for (;;) {
    const total = digits + Buffer.byteLength(suffix);
    if (String(total).length === digits) return `${total}${suffix}`;
    digits = String(total).length;
    if (digits > 12) throw new Error("pax record too large");
  }
}

function header(p: { name: string; prefix: string; size: number; mtime: number; mode: number; type: string; link?: string }): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  writeField(buf, 0, 100, p.name);
  writeOctal(buf, 100, 8, p.mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, p.size);
  writeOctal(buf, 136, 12, p.mtime);
  buf.fill(0x20, 148, 156);
  buf.write(p.type, 156, 1, "ascii");
  if (p.link) writeField(buf, 157, 100, p.link);
  buf.write("ustar\0", 257, 6, "binary");
  buf.write("00", 263, 2, "ascii");
  writeField(buf, 345, 155, p.prefix);
  let sum = 0;
  for (const byte of buf) sum += byte;
  const chk = sum.toString(8).padStart(6, "0");
  buf.write(chk, 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function writeField(buf: Buffer, at: number, width: number, text: string): void {
  const bytes = Buffer.from(text);
  if (bytes.length > width) throw new Error(`header field too long`);
  bytes.copy(buf, at);
}

function writeOctal(buf: Buffer, at: number, width: number, value: number): void {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length !== width - 1) throw new Error(`octal field overflow ${value}`);
  buf.write(digits, at, width - 1, "ascii");
  buf[at + width - 1] = 0;
}

function pad(buf: Buffer): Buffer {
  const extra = (BLOCK - (buf.length % BLOCK)) % BLOCK;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra)]);
}
