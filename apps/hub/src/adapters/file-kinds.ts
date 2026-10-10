// What a file is, from its name: the MIME type it is served as, and how the app shows it. Text kinds are served as
// text/plain, so no file is ever rendered as a page of the hub's own origin (HTML, SVG opened directly).
import { basename, extname } from "node:path";
import type { AttachmentKind } from "@morndo/domain";

const TYPES: Record<string, [string, AttachmentKind]> = {
  ".png": ["image/png", "image"], ".jpg": ["image/jpeg", "image"], ".jpeg": ["image/jpeg", "image"], ".gif": ["image/gif", "image"],
  ".webp": ["image/webp", "image"], ".svg": ["image/svg+xml", "image"], ".avif": ["image/avif", "image"],
  ".mp4": ["video/mp4", "video"], ".webm": ["video/webm", "video"], ".mov": ["video/quicktime", "video"],
  ".mp3": ["audio/mpeg", "audio"], ".ogg": ["audio/ogg", "audio"], ".oga": ["audio/ogg", "audio"], ".wav": ["audio/wav", "audio"], ".m4a": ["audio/mp4", "audio"],
  ".pdf": ["application/pdf", "pdf"],
};
const TEXT = new Set([".md", ".markdown", ".txt", ".log", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".xml", ".html", ".htm",
  ".ts", ".tsx", ".js", ".mjs", ".svelte", ".py", ".sh", ".sql", ".diff", ".patch", ".css", ".ini", ".env.example"]);

export function describeFile(path: string): { name: string; mime: string; kind: AttachmentKind } {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  const known = TYPES[ext];
  if (known) return { name, mime: known[0], kind: known[1] };
  if (TEXT.has(ext)) return { name, mime: "text/plain; charset=utf-8", kind: "text" };
  return { name, mime: "application/octet-stream", kind: "file" };
}
