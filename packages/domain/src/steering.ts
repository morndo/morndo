// Steering: what the principal sends into a worker. Sending is a Command (AC7, access.ts); this holds the rules for the
// images he attaches to one (docs/domain.md, S1–S3). An image travels as a file on the office's machine that the
// worker reads by its path, the way Claude Code takes images it didn't get from its own clipboard.

import { err, ok, type EndpointId, type Result } from "./shared.ts";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type Upload = { id: string; endpointId: EndpointId; path: string; mime: ImageMime; size: number; at: number };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOADS_PER_COMMAND = 6;
export const UPLOAD_TTL_MS = 24 * 3_600_000;           // attachable for a day after it was uploaded

export const IMAGE_EXTENSION: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// S1: an upload is an image by its own bytes, never by the type the browser claims, and at most 10 MB. SVG (which can
// carry script) and anything else is refused.
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export type UploadRefusal = "not_an_image" | "too_big";
export function acceptUpload(bytes: Uint8Array): Result<ImageMime, UploadRefusal> {
  if (bytes.length > MAX_UPLOAD_BYTES) return err("too_big");
  const mime = sniffImage(bytes);
  return mime ? ok(mime) : err("not_an_image");
}

// S2: a Command attaches only uploads made from its own Endpoint, still within their day, each once, at most six.
export type AttachRefusal = "unknown_upload" | "not_yours" | "expired" | "too_many";
export function attachable(ids: string[], find: (id: string) => Upload | undefined, endpointId: EndpointId, now: number): Result<Upload[], AttachRefusal> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_UPLOADS_PER_COMMAND) return err("too_many");
  const out: Upload[] = [];
  for (const id of unique) {
    const u = find(id);
    if (!u) return err("unknown_upload");
    if (u.endpointId !== endpointId) return err("not_yours");
    if (now - u.at >= UPLOAD_TTL_MS) return err("expired");
    out.push(u);
  }
  return ok(out);
}

// S3: the Command names each attached image after the principal's own text, one note per image, in the note form the
// workers already read (the adapter supplies it); a Command may be only images.
export function commandText(text: string, notes: string[]): string {
  const body = text.trim();
  return [body, notes.join("\n")].filter(Boolean).join("\n\n");
}
