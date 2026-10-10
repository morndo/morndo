// The inbox for images the principal pastes or attaches in the app (Steering, S1–S3 in docs/domain.md). Each is saved
// as a file on the office's machine for a worker to open by its path: outside the hub's data directory (the file
// store keeps its own copy when the message shows up in the conversation), readable by this user only, and without
// the metadata a photo carries (location, camera, text): JPEG APP1/APP13/comment segments and PNG text, time and EXIF
// chunks are dropped, since the image goes on to a model provider. Files older than a week are removed.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_EXTENSION, UPLOAD_TTL_MS, acceptUpload, type EndpointId, type ImageMime, type Result, type Upload, type UploadRefusal } from "@morndo/domain";

const KEEP_FILES_MS = 7 * 24 * 3_600_000;

export function stripMetadata(b: Uint8Array, mime: ImageMime): Uint8Array {
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
  return b;
}

export type Inbox = {
  save(bytes: Uint8Array, endpointId: EndpointId): Result<Upload, UploadRefusal>;
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
    save(bytes, endpointId) {
      const accepted = acceptUpload(bytes);
      if (!accepted.ok) return accepted;
      const mime = accepted.value;
      const at = now();
      const id = randomBytes(12).toString("hex");
      const path = join(opts.dir, `pasted-${stamp(at)}-${id.slice(0, 6)}.${IMAGE_EXTENSION[mime]}`);
      const clean = stripMetadata(bytes, mime);
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
