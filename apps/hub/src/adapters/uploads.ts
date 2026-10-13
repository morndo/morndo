// The inbox for images the principal pastes or attaches in the app (Steering, S1–S3 in docs/domain.md). Each is saved
// as a file on the office's machine for a worker to open by its path: outside the hub's data directory (the file
// store keeps its own copy when the message shows up in the conversation), readable by this user only, and without
// the metadata a photo or a recording carries (location, camera, text): JPEG APP1/APP13/comment segments and PNG
// text, time and EXIF chunks are dropped, as an m4a's udta, an mp3's ID3 tags, a wav's LIST INFO, an Ogg comment
// header and a webm's Tags are, since the file goes on to a worker and a model provider. Files older than a week
// are removed.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IMAGE_EXTENSION, NO_CAPABILITY, UPLOAD_TTL_MS, acceptNamedUpload, acceptUpload, sniffAudio, type AudioContainer, type EndpointId, type ImageMime, type Result, type TranscriptionCapability, type Upload, type UploadRefusal } from "@morndo/domain";

const KEEP_FILES_MS = 7 * 24 * 3_600_000;

// What an audio file loses on the way in, by its own container (sniffAudio names it): the delimited blocks a
// recorder writes its metadata into are dropped or blanked in place, and the audio's own data is never touched —
// the same rule as a photo's. What each container keeps its metadata in:
// - mp4 (ISO/IEC 14496-12): the `udta` (§8.10) and `meta` (§8.11) boxes — a recorder's title and date, and the iOS
//   location atom ©xyz, which sits in moov/udta;
// - mp3 (id3.org): the ID3v2 tag whose header names its size, and the ID3v1 "TAG" tail;
// - wav (RIFF): `LIST` chunks — the INFO list a recorder writes (IART, ICMT, ISFT…) — and `id3 ` chunks;
// - ogg: the comment header packet (the Vorbis comment header, RFC 3533's framing; OpusTags, RFC 7845 §5.2) —
//   blanked where it sits, keeping the page framing and its checksum, so the audio pages around it are untouched;
// - webm (Matroska's EBML): `Tags` elements (0x1254c367), where a muxer writes titles and dates.
export function stripMetadata(b: Uint8Array, mime: ImageMime | AudioContainer): Uint8Array {
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
  if (mime === "mp4") return stripMp4(b);
  if (mime === "mp3") return stripMp3(b);
  if (mime === "wav") return stripWav(b);
  if (mime === "ogg") return stripOgg(b);
  return stripWebm(b);
}

const u32be = (b: Uint8Array, i: number) => b[i]! * 2 ** 24 + b[i + 1]! * 2 ** 16 + b[i + 2]! * 2 ** 8 + b[i + 3]!;
const u32le = (b: Uint8Array, i: number) => b[i]! + b[i + 1]! * 256 + b[i + 2]! * 2 ** 16 + b[i + 3]! * 2 ** 24;
const latin = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

// mp4: drop `udta` and `meta` wherever they sit (a recorder's title, date and location live there), walking only the
// boxes that hold boxes. A size of 0 or 1 (to-end, or 64-bit) ends the walk keeping what follows as it is.
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex"]);
function stripMp4(b: Uint8Array): Uint8Array {
  const walk = (view: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    let i = 0;
    while (i + 8 <= view.length) {
      const size = u32be(view, i);
      const type = latin(view, i + 4, 4);
      if (size < 8) { parts.push(view.subarray(i)); break; }                        // a broken tail stays
      if (i + size > view.length) { parts.push(view.subarray(i)); break; }
      if (type === "udta" || type === "meta") { i += size; continue; }              // the metadata blocks go
      if (MP4_CONTAINERS.has(type)) {
        const inner = walk(view.subarray(i + 8, i + size));
        const box = new Uint8Array(8 + inner.length);
        box.set(view.subarray(i, i + 8), 0);
        new DataView(box.buffer).setUint32(0, box.length);
        box.set(inner, 8);
        parts.push(box);
      }
      else parts.push(view.subarray(i, i + size));
      i += size;
    }
    return Buffer.concat(parts);
  };
  return walk(b);
}

// mp3: skip the ID3v2 tag (its header names its size sync-safe, footer included when its flag says one follows),
// drop the ID3v1 tail (the last 128 bytes when they begin "TAG").
function stripMp3(b: Uint8Array): Uint8Array {
  let start = 0;
  let end = b.length;
  if (latin(b, 0, 3) === "ID3" && b.length >= 10) {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    start = 10 + size + (b[5]! & 0x10 ? 10 : 0);
  }
  if (end - start >= 128 && latin(b, end - 128, 3) === "TAG") end -= 128;
  return b.subarray(start, end);
}

// wav: drop LIST chunks (the INFO list) and `id3 ` chunks; RIFF chunks are word-aligned and the walk keeps them so.
function stripWav(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 12)];
  let i = 12;
  while (i + 8 <= b.length) {
    const id = latin(b, i, 4);
    const size = u32le(b, i + 4);
    const whole = 8 + size + (size % 2);
    if (id === "LIST" || id === "id3 ") { i += whole; continue; }
    parts.push(b.subarray(i, Math.min(i + whole, b.length)));
    i += whole;
  }
  if (i < b.length) parts.push(b.subarray(i));                                     // a broken tail stays
  return Buffer.concat(parts);
}

// The Ogg page checksum (RFC 3533 §5): CRC-32 with polynomial 0x04c11db7, no reflection, no final xor.
const OGG_CRC: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  OGG_CRC.push(c >>> 0);
}
function oggCrc32(b: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = (((c << 8) >>> 0) ^ OGG_CRC[((c >>> 24) ^ b[i]!) & 0xff]!) >>> 0;
  return c >>> 0;
}

// ogg: a page whose one whole packet is a comment header (the Vorbis comment header, or OpusTags) has that packet
// blanked in place — magic kept, vendor length and comment count zeroed — and its checksum recomputed. The framing,
// the lacing and every other page are untouched, so what a decoder reads is the same audio with no comments.
function stripOgg(b: Uint8Array): Uint8Array {
  const out = Buffer.from(b);
  let i = 0;
  while (i + 27 <= out.length && latin(out, i, 4) === "OggS") {
    const nseg = out[i + 26]!;
    let len = 27 + nseg;
    for (let s = 0; s < nseg; s++) len += out[i + 27 + s]!;
    if (i + len > out.length) break;
    const payload = i + 27 + nseg;
    const packetLen = nseg > 0 ? out[i + 27]! : 0;
    const magic = latin(out, payload, 8);
    const onePacket = nseg === 1 && packetLen < 255;                                // the packet begins and ends here
    if (onePacket && (magic === "OpusTags" || latin(out, payload, 7) === "\x03vorbis")) {
      const after = payload + (magic === "OpusTags" ? 8 : 7);
      out.fill(0, after, payload + packetLen);                                      // no vendor, no comments
      out.writeUInt32LE(0, i + 22);
      out.writeUInt32LE(oggCrc32(out.subarray(i, i + len)), i + 22);
    }
    i += len;
  }
  return out;
}

// webm: Matroska vints (a marker bit names the length; a size of all ones means "to the end"). Drop Tags elements
// (0x1254c367) among the Segment's children; a streamed Segment is unknown-size, so its children run to the end.
function stripWebm(b: Uint8Array): Uint8Array {
  const vintLen = (i: number): number => {
    for (let k = 0; k < 8; k++) if (b[i]! & (0x80 >> k)) return k + 1;
    return 0;
  };
  const vintId = (i: number, len: number) => { let v = 0; for (let k = 0; k < len; k++) v = v * 256 + b[i + k]!; return v; };
  const vintSize = (i: number, len: number) => {
    let v = b[i]! & (0xff >> len);
    for (let k = 1; k < len; k++) v = v * 256 + b[i + k]!;
    return v;
  };
  const dropTags = (start: number, end: number): Uint8Array => {
    const parts: Uint8Array[] = [];
    let i = start;
    while (i + 2 <= end) {
      const idLen = vintLen(i);
      if (idLen === 0) { parts.push(b.subarray(i, end)); break; }
      const id = vintId(i, idLen);
      let j = i + idLen;
      const sizeLen = vintLen(j);
      if (sizeLen === 0) { parts.push(b.subarray(i, end)); break; }
      const size = vintSize(j, sizeLen);
      j += sizeLen;
      const stop = size === 2 ** (7 * sizeLen) - 1 ? end : Math.min(end, j + size);   // all ones: streamed to the end
      if (id === 0x1254c367) { i = stop; continue; }                                 // Tags: where a muxer writes its words
      parts.push(b.subarray(i, stop));
      if (stop <= i) { parts.pop(); parts.push(b.subarray(i, end)); break; }         // nothing consumed: not EBML
      i = stop;
    }
    return Buffer.concat(parts);
  };
  // Past the EBML header, the Segment is the one top-level element that matters.
  let i = 0;
  while (i + 2 <= b.length) {
    const idLen = vintLen(i);
    if (idLen === 0) break;
    const id = vintId(i, idLen);
    let j = i + idLen;
    const sizeLen = vintLen(j);
    if (sizeLen === 0) break;
    const size = vintSize(j, sizeLen);
    j += sizeLen;
    const stop = size === 2 ** (7 * sizeLen) - 1 ? b.length : Math.min(b.length, j + size);
    if (id === 0x18538067) return Buffer.concat([b.subarray(0, j), dropTags(j, stop)]);   // the Segment
    if (stop <= i) break;
    i = stop;
  }
  return b;
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
  save(bytes: Uint8Array, endpointId: EndpointId, name?: string, capability?: TranscriptionCapability): Result<Upload, UploadRefusal>;
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
    save(bytes, endpointId, name = "", capability = NO_CAPABILITY) {
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
          clean = stripMetadata(bytes, accepted.value.container);   // as a photo's: recorder metadata never lands
        } else {
          mime = accepted.value.mime;
          clean = accepted.value.kind === "image" ? stripMetadata(bytes, accepted.value.mime) : bytes;
        }
      } else {
        const accepted = acceptUpload(bytes);
        if (!accepted.ok) return accepted;
        pathName = `pasted-${stamp(at)}-${id6}.${IMAGE_EXTENSION[accepted.value]}`;
        mime = accepted.value;
        clean = stripMetadata(bytes, accepted.value);
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
