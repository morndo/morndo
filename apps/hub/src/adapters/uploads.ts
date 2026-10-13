// The inbox for images the principal pastes or attaches in the app (Steering, S1–S3 in docs/domain.md). Each is saved
// as a file on the office's machine for a worker to open by its path: outside the hub's data directory (the file
// store keeps its own copy when the message shows up in the conversation), readable by this user only, and without
// the metadata a photo carries (location, camera, text): JPEG APP1/APP13/comment segments and PNG text, time and
// EXIF chunks are dropped. A recording loses its tags only where that can be done without corrupting the audio
// (docs/design/transcription, section 8). Files older than a week are removed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { IMAGE_EXTENSION, NO_CAPABILITY, UPLOAD_TTL_MS, acceptNamedUpload, acceptUpload, sniffAudio, type AudioContainer, type EndpointId, type ImageMime, type Result, type TranscriptionCapability, type Upload, type UploadRefusal } from "@morndo/domain";

const KEEP_FILES_MS = 7 * 24 * 3_600_000;

// What an audio file loses on the way in. A photo's segments can be dropped because each one names its own length.
// A recording cannot: an mp4 chunk offset, an Ogg page and a Matroska element size all count the bytes around them,
// so those three are remuxed (ffmpeg -map_metadata -1 -c copy) or stored unchanged. A wav's RIFF size and an mp3's
// tags are the fields this file rewrites itself. The choice is written in docs/design/transcription (section 8).
export async function stripMetadata(b: Uint8Array, mime: ImageMime | AudioContainer, timeoutMs = 30_000): Promise<Uint8Array> {
  if (mime === "image/jpeg") {
    const out: Uint8Array[] = [b.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
      const marker = b[i + 1] as number;
      if (marker === 0xda || marker === 0xd9) break;                              // start of scan: the rest is image data
      const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
      const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;          // APP1 (EXIF, XMP), APP13 (IPTC), comment
      if (!drop) out.push(b.subarray(i, i + 2 + len));
      i += 2 + len;
    }
    out.push(b.subarray(i));
    return Buffer.concat(out);
  }
  if (mime === "image/png") {
    const out: Uint8Array[] = [b.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = Buffer.from(b.buffer, b.byteOffset + i, 4).readUInt32BE(0);
      const type = Buffer.from(b.subarray(i + 4, i + 8)).toString("latin1");
      if (!["tEXt", "iTXt", "zTXt", "eXIf", "tIME"].includes(type)) out.push(b.subarray(i, i + 12 + len));
      i += 12 + len;
      if (type === "IEND") break;
    }
    return Buffer.concat(out);
  }
  // Audio (a gif or webp passes through as before), and only when the bytes are what the name claimed (the sniff
  // already ran before the save): a strip never walks bytes of another shape than the container it was told.
  if (sniffAudio(b) !== mime) return b;
  if (mime === "mp4" || mime === "ogg" || mime === "webm") return stripByRemux(b, mime, timeoutMs);
  if (mime === "mp3") return stripMp3(b);
  if (mime === "wav") return stripWav(b);
  return b;
}

const u32le = (b: Uint8Array, i: number) => b[i]! + b[i + 1]! * 256 + b[i + 2]! * 2 ** 16 + b[i + 3]! * 2 ** 24;
const latin = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const frameSync = (b: Uint8Array) => b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0;

// mp4, ogg, webm: ffmpeg rewrites every size and offset when it copies the streams without metadata.
// The spawn is asynchronous, with a timeout that kills it, so a slow remux never stalls the hub.
// A missing ffmpeg, or a remux that fails, keeps the bytes: a hand edit of those containers would corrupt them.
const REMUX_FORMAT = { mp4: "mp4", ogg: "ogg", webm: "webm" } as const;
async function stripByRemux(b: Uint8Array, container: keyof typeof REMUX_FORMAT, timeoutMs: number): Promise<Uint8Array> {
  const ext = container === "mp4" ? "m4a" : container;
  const folder = mkdtempSync(join(tmpdir(), "morndo-strip-"));
  try {
    const input = join(folder, `in.${ext}`);
    const output = join(folder, `out.${ext}`);
    writeFileSync(input, b, { mode: 0o600 });
    const code = await runFfmpeg([
      "-nostdin", "-v", "error", "-y", "-i", input,
      "-map_metadata", "-1", "-c", "copy", "-f", REMUX_FORMAT[container], output,
    ], timeoutMs);
    if (code !== 0) return b;
    const out = readFileSync(output);
    return out.length > 0 && sniffAudio(out) === container ? out : b;
  } catch {
    return b;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", code => finish(code));
  });
}

// mp3: drop a whole ID3v2 tag (header, body, and the 10-byte footer when its flag is set) and an ID3v1 tail.
// What remains has to open on a frame sync. Anything else is stored as it arrived.
function stripMp3(b: Uint8Array): Uint8Array {
  let start = 0;
  let end = b.length;
  if (latin(b, 0, 3) === "ID3" && b.length >= 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const tagEnd = 10 + size + ((b[5]! & 0x10) !== 0 ? 10 : 0);
    if (tagEnd > b.length) return b;
    start = tagEnd;
  }
  if (end - start >= 128 && latin(b, end - 128, 3) === "TAG") end -= 128;
  if (start === 0 && end === b.length) return b;
  const out = b.subarray(start, end);
  return frameSync(out) ? out : b;
}

// wav: drop LIST and id3 chunks. The RIFF size at offset 4 is the file length minus 8, so it is rewritten to
// match. An RF64 file marks that field 0xFFFFFFFF and keeps the real sizes in ds64; those stay untouched.
function stripWav(b: Uint8Array): Uint8Array {
  if (b.length < 12 || u32le(b, 4) === 0xffffffff) return b;
  const parts: Uint8Array[] = [];
  let i = 12;
  let dropped = false;
  while (i + 8 <= b.length) {
    const id = latin(b, i, 4);
    const size = u32le(b, i + 4);
    if (size === 0xffffffff) return b;
    const whole = 8 + size + (size % 2);
    if (i + whole > b.length) { parts.push(b.subarray(i)); i = b.length; break; }
    if (id === "LIST" || id === "id3 ") { dropped = true; i += whole; continue; }
    parts.push(b.subarray(i, i + whole));
    i += whole;
  }
  if (i < b.length) parts.push(b.subarray(i));
  if (!dropped) return b;
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(12 + body.length);
  out.set(b.subarray(0, 12), 0);
  out.set(body, 12);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

// The hub stores `pasted-<stamp>-<id6>-<safe name>`. The node is asked for the safe name, not that prefix:
// the prefix is 30 characters, and a name the domain already kept under 80 would otherwise lose its extension there.
export function stagedUploadName(storedPath: string): string {
  const base = basename(storedPath);
  const named = /^pasted-\d{8}-\d{6}-[0-9a-f]{6}-(.+)$/.exec(base);
  return named?.[1] || base;
}

const AUDIO_MIME: Record<AudioContainer, Upload["mime"]> = {
  ogg: "audio/ogg", webm: "audio/webm", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav",
};

export type Inbox = {
  save(bytes: Uint8Array, endpointId: EndpointId, name?: string, capability?: TranscriptionCapability): Promise<Result<Upload, UploadRefusal>>;
  get(id: string): Upload | undefined;
  sweep(): void;
};

// Where the inbox remembers what was uploaded: the hub's store (persisted, ADR-0008 phase C), else memory.
export type UploadRegistry = { saveUpload(u: Upload): void; upload(id: string): Upload | undefined; pruneUploads(before: number): number };

function memoryRegistry(): UploadRegistry {
  const known = new Map<string, Upload>();
  return {
    saveUpload: u => { known.set(u.id, u); },
    upload: id => known.get(id),
    pruneUploads: before => { let n = 0; for (const [id, u] of known) if (u.at < before) { known.delete(id); n++; } return n; },
  };
}

export function uploadInbox(opts: { dir: string; now?: () => number; registry?: UploadRegistry }): Inbox {
  const now = opts.now ?? Date.now;
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const known = opts.registry ?? memoryRegistry();
  const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return {
    async save(bytes, endpointId, name = "", capability = NO_CAPABILITY) {
      const at = now();
      const id = randomBytes(12).toString("hex");
      const id6 = id.slice(0, 6);
      let pathName: string;
      let mime: Upload["mime"];
      let clean: Uint8Array;
      if (name) {
        const accepted = acceptNamedUpload(bytes, name, capability);
        if (!accepted.ok) return accepted;
        pathName = `pasted-${stamp(at)}-${id6}-${accepted.value.name}`;
        if (accepted.value.kind === "audio") {
          mime = AUDIO_MIME[accepted.value.container];
          clean = await stripMetadata(bytes, accepted.value.container);   // tags go when that can be done without corrupting the audio
        } else {
          mime = accepted.value.mime;
          clean = accepted.value.kind === "image" ? await stripMetadata(bytes, accepted.value.mime) : bytes;
        }
      } else {
        const accepted = acceptUpload(bytes);
        if (!accepted.ok) return accepted;
        pathName = `pasted-${stamp(at)}-${id6}.${IMAGE_EXTENSION[accepted.value]}`;
        mime = accepted.value;
        clean = await stripMetadata(bytes, accepted.value);
      }
      const path = join(opts.dir, pathName);
      writeFileSync(path, clean, { mode: 0o600 });
      const upload: Upload = { id, endpointId, path, mime, size: clean.length, at };
      known.saveUpload(upload);
      return { ok: true, value: upload };
    },
    get: id => known.upload(id),
    sweep() {
      const t = now();
      known.pruneUploads(t - UPLOAD_TTL_MS);
      for (const f of readdirSync(opts.dir)) {
        const p = join(opts.dir, f);
        try { if (t - statSync(p).mtimeMs > KEEP_FILES_MS) unlinkSync(p); } catch { /* gone */ }
      }
    },
  };
}
