// Fixtures for the tar reader and the installer (design §6.1 step 4, §13 fault injection). Good archives come
// from the release pipeline's own packTree and listFiles — scripts/release is the other half of the contract the
// updater reads — and evil ones from the raw ustar writer below, because packTree refuses evil input on purpose.
import { gzipSync } from "node:zlib";
import { packTree, type TreeFile } from "../../../../scripts/release/archive.ts";
import { listFiles } from "../../../../scripts/release/files.ts";

// ---- good archives: the pipeline's writer, plus the signed list inside the tree

// A release archive as CI ships it: the tree and files.json, whose digest is the Manifest's filesSha256.
export function buildRelease(files: readonly TreeFile[], mtimeSec = 0): { gz: Buffer; filesSha256: string; filesJson: string } {
  const { json, sha256 } = listFiles(files);
  return { gz: packWithList(files, json, mtimeSec), filesSha256: sha256, filesJson: json };
}

// An archive whose files.json is `filesJson` verbatim: the tampered cases, where the tree and the list disagree.
export function packWithList(files: readonly TreeFile[], filesJson: string, mtimeSec = 0): Buffer {
  const tree: TreeFile[] = [...files, { path: "files.json", mode: "0444", bytes: Buffer.from(filesJson) }];
  return packTree(tree, mtimeSec);
}

// ---- evil archives: a raw ustar writer with no opinions

export type RawEntry = {
  name: string;
  type?: string;            // ustar typeflag, "0" by default
  link?: string;            // the linkname field
  body?: Uint8Array;
  prefix?: string;          // the ustar prefix field
  badChecksum?: boolean;    // store zeros where the checksum belongs
};

const BLOCK = 512;

// A pax record's length counts itself (`<len> <key>=<value>\n`), so the digit width is found by growing it —
// the same arithmetic as scripts/release/archive.ts, kept here so the writer stays dumb.
export function paxBody(records: readonly [key: string, value: string][]): Buffer {
  const out: string[] = [];
  for (const [key, value] of records) {
    const suffix = ` ${key}=${value}\n`;
    let digits = 1;
    for (;;) {
      const total = digits + Buffer.byteLength(suffix);
      if (String(total).length === digits) { out.push(`${total}${suffix}`); break; }
      digits += 1;
    }
  }
  return Buffer.from(out.join(""));
}

function header(e: RawEntry, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(e.name.slice(0, 100), 0, "utf8");
  writeOctal(buf, 100, 8, 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf.write(e.type ?? "0", 156, 1, "ascii");
  if (e.link !== undefined) buf.write(e.link.slice(0, 100), 157, "utf8");
  buf.write("ustar\0", 257, 6, "binary");
  buf.write("00", 263, 2, "ascii");
  if (e.prefix !== undefined) buf.write(e.prefix.slice(0, 155), 345, "utf8");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(e.badChecksum ? "000000" : sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function writeOctal(buf: Buffer, at: number, width: number, value: number): void {
  buf.write(value.toString(8).padStart(width - 1, "0"), at, width - 1, "ascii");
}

function pad(body: Buffer): Buffer {
  const extra = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return extra === 0 ? body : Buffer.concat([body, Buffer.alloc(extra)]);
}

// A plain ustar archive: these headers, two zero blocks, no pax machinery unless a test writes it with type "x".
export function rawTar(entries: readonly RawEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const body = e.body === undefined ? null : Buffer.from(e.body);
    chunks.push(header(e, body?.length ?? 0));
    if (body !== null && body.length > 0) chunks.push(pad(body));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

export const evilGz = (entries: readonly RawEntry[]): Buffer => gzipSync(rawTar(entries));
