// The archive reader (design §6.1 step 4, §10.2 step 6, §10.4 "a crafted archive"): a streaming reader for
// exactly what scripts/release/archive.ts packTree writes — gzip, ustar headers, and a POSIX pax `x` record
// carrying `path` for a long name — and a refusal for everything else: a path that leaves the tree, a link that
// points out (straight or by climbing through another link of the archive), anything written through a link,
// device nodes and GNU extensions, a duplicate path, a bad checksum, a truncated body, unbounded expansion. It
// writes only inside `dest`, under its own modes (files
// 0600, directories 0700): the installer sets the final modes from the signed file list, never from the archive.
// Format sources: POSIX pax, "ustar Interchange Format" and "pax Interchange Format",
// https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html (read 2026-10-21); Node 24 zlib
// createGunzip, https://nodejs.org/docs/latest-v24.x/api/zlib.html (read 2026-10-21). The rules are shared with
// the writer by reimplementation, not by import: scripts/ is the release pipeline's, not the updater's.
import { closeSync, createReadStream, lstatSync, mkdirSync, openSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

const BLOCK = 512;

export type TarEntry = { path: string; type: "file" | "dir" | "symlink"; link?: string };

export class TarRefused extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "TarRefused"; this.reason = reason; }
}

const refuse = (reason: string): never => { throw new TarRefused(reason); };

// Strict UTF-8: a name that does not decode is refused, not guessed at — a lossy decode could alias two paths.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const text = (bytes: Uint8Array): string => {
  try { return utf8.decode(bytes); } catch { return refuse("a name is not UTF-8"); }
};

// A ustar string field: the bytes before the first NUL (a full field needs no terminator).
const field = (block: Buffer, at: number, width: number): string => {
  const raw = block.subarray(at, at + width);
  const end = raw.indexOf(0);
  return text(end === -1 ? raw : raw.subarray(0, end));
};

// An octal field, digits up to the first NUL or space. NaN means the field is not octal at all.
const octal = (block: Buffer, at: number, width: number): number => {
  let end = at;
  while (end < at + width && block[end] !== 0 && block[end] !== 0x20) end += 1;
  const digits = block.toString("ascii", at, end);
  if (!/^[0-7]*$/.test(digits)) return Number.NaN;
  return digits === "" ? 0 : parseInt(digits, 8);
};

// The same rule as scripts/release/archive.ts linkLeaves: a target is refused when it is absolute, or when its
// ".." steps climb out of the tree from the link's own directory.
const linkLeaves = (path: string, target: string): boolean => {
  if (target.startsWith("/")) return true;
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
};

// A plain relative path: no leading "/", no empty, "." or ".." segment, no NUL, no backslash.
const pathFault = (path: string): string | null => {
  if (path === "") return "an empty path";
  if (path.startsWith("/")) return "a leading '/'";
  if (path.includes("\0")) return "a NUL byte";
  if (path.includes("\\")) return "a backslash";
  for (const part of path.split("/")) {
    if (part === "") return "an empty segment";
    if (part === ".") return "a '.' segment";
    if (part === "..") return "a '..' segment";
  }
  return null;
};

export async function extractTar(gzPath: string, dest: string, o: { maxBytes: number }): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const seen = new Map<string, "dir" | "file" | "symlink">();   // every path this archive has put in dest
  const links = new Map<string, string>();                      // every symlink's path -> target, for the check at the end
  const pax = new Map<string, string>();                        // records waiting for the entry they describe

  let buf: Buffer = Buffer.alloc(0);
  let total = 0;                        // decompressed bytes: headers, bodies and padding all count
  let state: "header" | "body" | "pad" = "header";
  let bodyKind: "pax" | "file" | "skip" = "skip";
  let bodySize = 0;
  let bodyLeft = 0;
  let padLeft = 0;
  let fd = -1;                          // the file a body is streaming into
  let paxBytes: Buffer = Buffer.alloc(0);
  let zeroBlocks = 0;
  let ended = false;

  const closeFile = () => { if (fd !== -1) { closeSync(fd); fd = -1; } };

  // A parent directory the archive has not named is created on demand, but never through a link or a file:
  // nothing is ever written to a path whose parent is not a directory of this archive.
  const ensureParents = (path: string): void => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const known = seen.get(parent);
      if (known === "dir") continue;
      if (known !== undefined) refuse(`refusing path ${path}: ${parent} is already ${known === "symlink" ? "a symlink" : "a file"}`);
      const full = join(dest, parent);
      let st: ReturnType<typeof lstatSync> | null = null;
      try { st = lstatSync(full); } catch { st = null; }
      if (st !== null && !st.isDirectory()) refuse(`refusing path ${path}: ${parent} is not a directory`);
      if (st === null) mkdirSync(full, 0o700);
      seen.set(parent, "dir");
    }
  };

  const makeDir = (path: string): void => {
    if (seen.get(path) === "dir") return;   // the same directory twice is nothing new
    if (seen.has(path)) refuse(`duplicate path ${path}`);
    ensureParents(path);
    mkdirSync(join(dest, path), 0o700);
    seen.set(path, "dir");
  };

  const makeFile = (path: string): void => {
    if (seen.has(path)) refuse(`duplicate path ${path}`);
    ensureParents(path);
    fd = openSync(join(dest, path), "wx", 0o600);   // "wx": a path that exists is never written over
    seen.set(path, "file");
  };

  const makeSymlink = (path: string, target: string): void => {
    if (seen.has(path)) refuse(`duplicate path ${path}`);
    if (target === "") refuse(`refusing link ${path}: an empty target`);
    if (linkLeaves(path, target)) refuse(`refusing link ${path} -> ${target}: it leaves the tree`);
    ensureParents(path);
    symlinkSync(target, join(dest, path));
    seen.set(path, "symlink");
    links.set(path, target);
  };

  // The lexical rule above cannot see through another link: "x/l1/.." looks harmless on its own while x/l1 is
  // itself a link, yet the kernel resolves a link l2 -> x/l1/.. to the parent of dest, because each ".." applies
  // after the link before it was substituted. So once the whole archive is known, every link's target is walked
  // again the way the kernel would inside this archive: a segment whose path so far names a link of this archive
  // gives way to that link's own target, resolved from that link's own directory. Linux caps one lookup at 40
  // link traversals (ELOOP, path_resolution(7)); more substitutions than that is a loop. Returns the refusal
  // reason, or null when the target ends inside the tree (existing or not).
  const LINK_STEPS = 40;
  const linkThroughLinks = (path: string, target: string): string | null => {
    const stack = path.split("/").slice(0, -1);   // where the walk stands: the link's own directory at first
    let rest = target.split("/");
    let steps = 0;
    while (rest.length > 0) {
      const part = rest.shift()!;
      if (part === "." || part === "") continue;
      if (part === "..") {
        if (stack.length === 0) return `refusing link ${path} -> ${target}: it leaves the tree through another link`;
        stack.pop();
        continue;
      }
      const own = links.get([...stack, part].join("/"));
      if (own === undefined) { stack.push(part); continue; }
      steps += 1;
      if (steps > LINK_STEPS) return `refusing link ${path} -> ${target}: a link loop`;
      rest = own.split("/").concat(rest);   // the substituted target walks from the stack as it stands: its link's own directory
    }
    return null;
  };

  // A pax body is `<len> <key>=<value>\n` records, each length counting the whole record, itself included.
  const takePax = (bytes: Buffer): void => {
    let at = 0;
    while (at < bytes.length) {
      let space = at;
      while (space < bytes.length && bytes[space]! >= 0x30 && bytes[space]! <= 0x39) space += 1;
      if (space === at || space >= bytes.length || bytes[space] !== 0x20) refuse("a pax record length");
      const length = parseInt(bytes.toString("ascii", at, space), 10);
      if (!Number.isInteger(length) || length <= 0 || at + length > bytes.length) refuse("a pax record length");
      const end = at + length;
      if (bytes[end - 1]! !== 0x0a) refuse("a pax record length");
      const equals = bytes.indexOf(0x3d, space + 1);
      if (equals === -1 || equals >= end - 1) refuse("a pax record length");
      const key = text(bytes.subarray(space + 1, equals));
      if (key !== "path" && key !== "linkpath") refuse(`the pax key '${key}'`);
      pax.set(key, text(bytes.subarray(equals + 1, end - 1)));
      at = end;
    }
  };

  const endBody = (): void => {
    if (bodyKind === "pax") takePax(paxBytes);
    if (bodyKind === "file") closeFile();
    bodyKind = "skip";
  };

  // Where a header's body goes; a size of 0 needs none at all.
  const bodyOf = (kind: "pax" | "file" | "skip", size: number): void => {
    bodyKind = kind;
    bodySize = size;
    bodyLeft = size;
    paxBytes = Buffer.alloc(0);
    if (size === 0) endBody();
  };

  const takeHeader = (block: Buffer): void => {
    let zero = true;
    for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) { zero = false; break; }
    if (zero) { zeroBlocks += 1; if (zeroBlocks === 2) ended = true; return; }   // two zero blocks end the archive
    if (zeroBlocks > 0) refuse("a zero block inside the archive");
    if (ended) refuse("bytes after the archive end");

    // the checksum: the header's bytes summed with the checksum field read as eight spaces
    const stored = octal(block, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    if (Number.isNaN(stored) || stored !== sum) refuse("the header checksum");
    if (block.toString("latin1", 257, 263) !== "ustar\0") refuse("the header magic");

    const typeflag = block[156] === 0 ? "0" : String.fromCharCode(block[156]!);
    const size = octal(block, 124, 12);
    if (Number.isNaN(size)) refuse("a header size");
    // a pax extended header carries records for the entry that follows it, so its own name means nothing
    if (typeflag === "x") { bodyOf("pax", size); return; }

    // the name: the pax `path`, else the ustar prefix and name; a directory's trailing "/" is dropped
    const name = field(block, 0, 100);
    const prefix = field(block, 345, 155);
    const raw = pax.has("path") ? pax.get("path")! : prefix === "" ? name : `${prefix}/${name}`;
    const path = raw.endsWith("/") ? raw.slice(0, -1) : raw;
    const fault = pathFault(path);
    if (fault !== null) refuse(`refusing path ${raw}: ${fault}`);

    if (typeflag === "0") {
      makeFile(path);
      entries.push({ path, type: "file" });
      bodyOf("file", size);
    } else if (typeflag === "5") {
      makeDir(path);
      entries.push({ path, type: "dir" });
      bodyOf("skip", size);
    } else if (typeflag === "2") {
      const target = pax.has("linkpath") ? pax.get("linkpath")! : field(block, 157, 100);
      makeSymlink(path, target);
      entries.push({ path, type: "symlink", link: target });
      bodyOf("skip", size);
    } else {
      refuse(`the typeflag '${typeflag}'`);
    }
    pax.clear();   // the described entry has taken its records
  };

  const feed = (chunk: Buffer): void => {
    total += chunk.length;
    if (total > o.maxBytes) refuse(`too large: past ${o.maxBytes} decompressed bytes`);
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (state === "header") {
        if (buf.length < BLOCK) return;
        takeHeader(buf.subarray(0, BLOCK));
        buf = buf.subarray(BLOCK);
        if (bodyLeft > 0) state = "body";
        continue;
      }
      if (state === "body") {
        if (buf.length === 0) return;
        const take = Math.min(buf.length, bodyLeft);
        const part = buf.subarray(0, take);
        buf = buf.subarray(take);
        bodyLeft -= take;
        if (bodyKind === "file") { let at = 0; while (at < part.length) at += writeSync(fd, part, at, part.length - at); }
        else if (bodyKind === "pax") paxBytes = Buffer.concat([paxBytes, part]);
        if (bodyLeft === 0) {
          endBody();
          padLeft = (BLOCK - (bodySize % BLOCK)) % BLOCK;
          state = padLeft === 0 ? "header" : "pad";
        }
        continue;
      }
      // state === "pad": the bytes that pad a body out to a block, never read
      if (buf.length === 0) return;
      const take = Math.min(buf.length, padLeft);
      buf = buf.subarray(take);
      padLeft -= take;
      if (padLeft === 0) state = "header";
    }
  };

  const source = createReadStream(gzPath);
  const gunzip = createGunzip();
  source.pipe(gunzip);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      closeFile();
      source.destroy();
      gunzip.destroy();
      reject(error instanceof TarRefused ? error : new TarRefused(`reading the archive: ${error instanceof Error ? error.message : String(error)}`));
    };
    source.on("error", fail);
    gunzip.on("error", fail);
    gunzip.on("data", (chunk: Buffer) => { try { feed(chunk); } catch (error) { fail(error); } });
    gunzip.on("end", () => {
      try {
        if (!ended) refuse("a truncated archive");
        for (const [path, target] of links) {
          const escape = linkThroughLinks(path, target);
          if (escape !== null) refuse(escape);
        }
        closeFile();
        settled = true;
        resolve();
      } catch (error) { fail(error); }
    });
  });
  return entries;
}
