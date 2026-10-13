// A tar.gz whose bytes depend only on the file bytes, their modes and the commit time (design §9.3:
// fixed order, owner and timestamp). gzip's header time is 0, which is what `gzip -n` writes and
// what Node's gzipSync emits for `mtime: 0` (nodejs.org/api/zlib.html, read 2026-10-13). Paths that
// fit in a ustar header stay there; a longer path gets one POSIX pax record so GNU tar and bsdtar
// both extract it. Owner and group are 0. No name, no atime.
import { gzipSync } from "node:zlib";

export type TreeFile = { path: string; bytes: Uint8Array; mode: "0444" | "0555" };

const BLOCK = 512;

export function packTree(files: readonly TreeFile[], mtimeSec: number): Buffer {
  if (!Number.isInteger(mtimeSec) || mtimeSec < 0) throw new Error("refusing a commit time that is not a whole second");
  const seen = new Set<string>();
  const dirs = new Set<string>();
  for (const file of files) {
    assertTreePath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate path ${file.path}`);
    seen.add(file.path);
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  type Entry = { path: string; dir: true } | { path: string; dir: false; file: TreeFile };
  const entries: Entry[] = [
    ...[...dirs].map(path => ({ path, dir: true as const })),
    ...files.map(file => ({ path: file.path, dir: false as const, file })),
  ];
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  let pax = 0;
  const emit = (path: string, mode: number, type: string, body: Uint8Array | null) => {
    const size = body?.length ?? 0;
    const split = splitUstar(path);
    if (!split) {
      pax += 1;
      const record = paxRecord("path", path);
      chunks.push(header({ name: `PaxHeaders/${pax}`, prefix: "", size: Buffer.byteLength(record), mtime: mtimeSec, mode: 0o644, type: "x" }));
      chunks.push(pad(Buffer.from(record)));
      const base = path.replace(/\/$/, "").split("/").pop() ?? "file";
      const name = type === "5" ? `${base.slice(-99)}/` : base.slice(-100);
      chunks.push(header({ name, prefix: "", size, mtime: mtimeSec, mode, type }));
    } else {
      chunks.push(header({ name: split.name, prefix: split.prefix, size, mtime: mtimeSec, mode, type }));
    }
    if (body && body.length > 0) chunks.push(pad(Buffer.from(body)));
  };
  for (const entry of entries) {
    if (entry.dir) emit(entry.path, 0o755, "5", null);
    else emit(entry.path, parseInt(entry.file.mode, 8), "0", Buffer.from(entry.file.bytes));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
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

function header(p: { name: string; prefix: string; size: number; mtime: number; mode: number; type: string }): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  writeField(buf, 0, 100, p.name);
  writeOctal(buf, 100, 8, p.mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, p.size);
  writeOctal(buf, 136, 12, p.mtime);
  buf.fill(0x20, 148, 156);
  buf.write(p.type, 156, 1, "ascii");
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
