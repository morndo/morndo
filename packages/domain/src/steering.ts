// Steering: what the principal sends into a worker. Sending is a Command (AC7, access.ts); this holds the rules for the
// files he attaches to one (docs/domain.md, S1–S3). A file travels on the office's machine that the worker reads by
// its path, the way Claude Code takes a file it didn't get from its own clipboard.

import { capabilityReady, NO_CAPABILITY, sniffAudio, type AudioContainer, type TranscriptionCapability } from "./transcription.ts";
import { err, ok, unreachable, type EndpointId, type Result } from "./shared.ts";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type TextMime = "text/plain" | "text/markdown" | "application/json" | "text/csv" | "application/yaml";
export type UploadMime = ImageMime | TextMime | "application/pdf" | "audio/ogg" | "audio/webm" | "audio/mp4" | "audio/mpeg" | "audio/wav";
export type UploadKind = "image" | "text" | "pdf" | "audio";
export type Upload = { id: string; endpointId: EndpointId; path: string; mime: UploadMime; size: number; at: number };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;     // images and PDF: a photo or a document
export const TEXT_MAX_BYTES = 1 * 1024 * 1024;        // notes, config, and logs a lane reads from disk
export const MAX_UPLOADS_PER_COMMAND = 6;
export const UPLOAD_TTL_MS = 24 * 3_600_000;           // attachable for a day after it was uploaded

export const IMAGE_EXTENSION: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

const IMAGE_BY_EXT: Record<string, ImageMime> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
// S1: an audio extension names the container its bytes must be (transcription.ts). A Safari recording is .m4a.
const AUDIO_BY_EXT: Record<string, AudioContainer> = {
  ".ogg": "ogg", ".oga": "ogg", ".opus": "ogg", ".webm": "webm", ".m4a": "mp4", ".mp3": "mp3", ".wav": "wav",
};
const TEXT_BY_EXT: Record<string, TextMime> = {
  ".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain", ".json": "application/json", ".csv": "text/csv",
  ".yaml": "application/yaml", ".yml": "application/yaml",
};
// What the file picker may offer. The server still decides; this is the same list.
export const UPLOAD_ACCEPT = [...Object.keys(IMAGE_BY_EXT), ".pdf", ...Object.keys(TEXT_BY_EXT)].join(",");

// S1: an image is known by its own bytes, never by the type the browser claims. SVG (which can carry script) is not one.
export function sniffImage(b: Uint8Array): ImageMime | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return "image/gif";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

export type UploadRefusal = "not_an_image" | "too_big" | "not_allowed" | "not_utf8" | "bad_name";

// A name with no extension: an image by its bytes only (a paste that didn't carry a name). Anything else is refused.
export function acceptUpload(bytes: Uint8Array): Result<ImageMime, UploadRefusal> {
  if (bytes.length > MAX_UPLOAD_BYTES) return err("too_big");
  const mime = sniffImage(bytes);
  return mime ? ok(mime) : err("not_an_image");
}

export type AcceptedUpload =
  | { kind: "image"; mime: ImageMime; name: string }
  | { kind: "pdf"; mime: "application/pdf"; name: string }
  | { kind: "text"; mime: TextMime; name: string }
  | { kind: "audio"; container: AudioContainer; name: string };
// Without the Capability argument an audio name is always refused, so that call can never be answered with one.
export type NamedUpload = Exclude<AcceptedUpload, { kind: "audio" }>;
export type NamedKind = "image" | "text" | "pdf";

const starts = (b: Uint8Array, ...bytes: number[]) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);

function extensionOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
}

export const UPLOAD_NAME_MAX = 80;

// The stored name: the last path segment, no leading dots, only letters, digits, dot, underscore and hyphen.
// A name longer than 80 characters loses stem, never the extension, so a cut file is still the kind it claims.
export function safeUploadName(name: string): string | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.normalize("NFKC").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const ext = extensionOf(cleaned);
  if (!ext || ext.length >= UPLOAD_NAME_MAX) return null;
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, UPLOAD_NAME_MAX - ext.length);
  const cut = stem + ext;
  return extensionOf(cut) === ext ? cut : null;
}

// S1: the domain carries no platform, so UTF-8 is read here, byte by byte. An overlong form, a surrogate half, a code
// point past U+10FFFF or a sequence cut short is not text, and neither is a NUL byte: all of it comes back null.
export function utf8Text(b: Uint8Array): string | null {
  let out = "";
  let i = 0;
  while (i < b.length) {
    const lead = b[i++] ?? 0;
    if (lead === 0) return null;
    if (lead < 0x80) { out += String.fromCharCode(lead); continue; }
    const extra = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
    if (lead < 0xc2 || lead > 0xf4) return null;
    let cp = lead & (extra === 1 ? 0x1f : extra === 2 ? 0x0f : 0x07);
    for (let k = 0; k < extra; k++) {
      const c = b[i++];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    const least = extra === 1 ? 0x80 : extra === 2 ? 0x800 : 0x10000;
    if (cp < least || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
  }
  return out;
}

function textProblem(b: Uint8Array): "not_allowed" | "not_utf8" | null {
  const text = utf8Text(b);
  if (text === null) return b.includes(0) ? "not_allowed" : "not_utf8";
  return /^(<\?xml|<!doctype\s+html|<html|<svg)\b/i.test(text.replace(/^\uFEFF/, "").trimStart()) ? "not_allowed" : null;
}

export function uploadByteLimit(kind: UploadKind): number {
  switch (kind) {
    case "image":
    case "pdf":
    case "audio": return MAX_UPLOAD_BYTES;
    case "text": return TEXT_MAX_BYTES;
    default: return unreachable(kind);
  }
}

function kindOf(name: string): UploadKind | null {
  const ext = extensionOf(name);
  if (IMAGE_BY_EXT[ext]) return "image";
  if (AUDIO_BY_EXT[ext]) return "audio";
  if (ext === ".pdf") return "pdf";
  if (TEXT_BY_EXT[ext]) return "text";
  return null;
}

// Name and size, before anyone reads the bytes. A 3 GB movie is refused here. An audio name (S1, TX9) is on the
// list only while the Capability is there; the Capability comes in as an argument, so the rule stays pure.
export function screenNamedUpload(name: string, size: number): Result<{ kind: NamedKind; name: string }, UploadRefusal>;
export function screenNamedUpload(
  name: string,
  size: number,
  capability: TranscriptionCapability,
): Result<{ kind: UploadKind; name: string }, UploadRefusal>;
export function screenNamedUpload(
  name: string,
  size: number,
  capability: TranscriptionCapability = NO_CAPABILITY,
): Result<{ kind: UploadKind; name: string }, UploadRefusal> {
  const kind = kindOf(name);
  if (!kind) return err("not_allowed");
  if (kind === "audio" && !capabilityReady(capability)) return err("not_allowed");
  if (size > uploadByteLimit(kind)) return err("too_big");
  const safe = safeUploadName(name);
  if (!safe || extensionOf(safe) !== extensionOf(name)) return err("bad_name");
  return ok({ kind, name: safe });
}

// S1: the extension picks the kind. An image is then whatever image its bytes are. HTML, SVG, executables and archives
// are not on the list. Text is UTF-8 under 1 MiB; a PDF starts with %PDF- and, like an image, is at most 10 MiB.
export function acceptNamedUpload(bytes: Uint8Array, name: string): Result<NamedUpload, UploadRefusal>;
export function acceptNamedUpload(
  bytes: Uint8Array,
  name: string,
  capability: TranscriptionCapability,
): Result<AcceptedUpload, UploadRefusal>;
export function acceptNamedUpload(
  bytes: Uint8Array,
  name: string,
  capability: TranscriptionCapability = NO_CAPABILITY,
): Result<AcceptedUpload, UploadRefusal> {
  const screened = screenNamedUpload(name, bytes.length, capability);
  if (!screened.ok) return screened;
  const { kind, name: safe } = screened.value;
  const text = TEXT_BY_EXT[extensionOf(name)];
  if (kind === "audio") {
    const container = AUDIO_BY_EXT[extensionOf(name)]!;
    return sniffAudio(bytes) === container ? ok({ kind, container, name: safe }) : err("not_allowed");
  }
  if (kind === "image") {
    const mime = sniffImage(bytes);
    return mime ? ok({ kind, mime, name: safe }) : err("not_allowed");
  }
  if (kind === "pdf") return starts(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d) ? ok({ kind, mime: "application/pdf", name: safe }) : err("not_allowed");
  const problem = textProblem(bytes);
  return problem || !text ? err(problem ?? "not_allowed") : ok({ kind: "text", mime: text, name: safe });
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
