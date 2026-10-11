// How an attached file is taken, on the desktop and on the phone. The domain decides the kind, the limit and the
// name (screenNamedUpload, before the bytes are read); this turns a refusal into a sentence and runs the upload.
import { MAX_UPLOADS_PER_COMMAND, acceptNamedUpload, screenNamedUpload, uploadByteLimit, UPLOAD_ACCEPT, type AttachmentKind, type UploadKind, type UploadRefusal } from "@morndo/domain";
import { ApiError, explain } from "./api.ts";

export { UPLOAD_ACCEPT };

const REFUSALS: readonly UploadRefusal[] = ["too_big", "not_allowed", "not_utf8", "bad_name", "not_an_image"];
const isRefusal = (code: string): code is UploadRefusal => (REFUSALS as readonly string[]).includes(code);

export function refusalMessage(name: string, error: UploadRefusal): string {
  const shown = name || "That file";
  if (error === "too_big") {
    const screened = screenNamedUpload(shown, 0);
    const bytes = screened.ok ? uploadByteLimit(screened.value.kind) : uploadByteLimit("image");
    return `${shown} is over ${bytes <= 1024 * 1024 ? "1 MB" : "10 MB"}.`;
  }
  if (error === "not_utf8") return `${shown} isn't valid UTF-8 text.`;
  if (error === "bad_name") return `${shown} has a file name that can't be kept.`;
  if (error === "not_an_image") return `${shown} isn't a PNG, JPEG, GIF or WebP image.`;
  return `${shown} can't be attached. Use an image, a PDF, or a text file (.md, .txt, .json, .csv, .yaml, .yml, .log).`;
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileType(name: string, kind: AttachmentKind): string {
  if (kind === "pdf") return "PDF";
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() ?? "" : "";
  return ext || "File";
}

export type SentFile = { name: string; kind: UploadKind; size: number };

export type AttachmentRow = {
  key: string;
  name: string;
  kind: UploadKind;
  size: number;
  preview: string;
  status: "uploading" | "ready" | "error";
  id?: string;
  error?: string;
};

// Synchronous: extension, size and the cap, before any byte is read. The rows are already "uploading", so Send waits.
export function beginAttachments(existing: number, list: File[]): { taken: { file: File; row: AttachmentRow }[]; note: string | null } {
  const problems: string[] = [];
  const taken: { file: File; row: AttachmentRow }[] = [];
  for (const file of list) {
    if (existing + taken.length >= MAX_UPLOADS_PER_COMMAND) { problems.push(`At most ${MAX_UPLOADS_PER_COMMAND} files per message.`); break; }
    const claimed = file.name || "pasted.png";
    const screened = screenNamedUpload(claimed, file.size);
    if (!screened.ok) { problems.push(refusalMessage(claimed, screened.error)); continue; }
    taken.push({
      file,
      row: { key: crypto.randomUUID(), name: screened.value.name, kind: screened.value.kind, size: file.size, preview: "", status: "uploading" },
    });
  }
  return { taken, note: problems[0] ?? null };
}

export function removalNote(rows: readonly { name: string; status: string }[]): string | null {
  const bad = rows.find(r => r.status === "error");
  return bad ? `Remove ${bad.name} before sending.` : null;
}

export async function settleAttachment(row: AttachmentRow, file: File, upload: (file: File) => Promise<{ id: string }>): Promise<void> {
  const claimed = file.name || row.name || "pasted.png";
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch (e) { row.status = "error"; row.error = explain(e); return; }
  const accepted = acceptNamedUpload(bytes, claimed);
  if (!accepted.ok) { row.status = "error"; row.error = refusalMessage(claimed, accepted.error); return; }
  row.name = accepted.value.name;
  row.kind = accepted.value.kind;
  if (accepted.value.kind === "image") row.preview = URL.createObjectURL(file);
  try {
    const ready = await upload(file);
    row.status = "ready";
    row.id = ready.id;
  } catch (e) {
    row.status = "error";
    row.error = e instanceof ApiError && isRefusal(e.code) ? refusalMessage(row.name, e.code) : explain(e);
  }
}
