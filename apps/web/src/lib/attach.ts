// How an attached file is described in the composer. What may be attached is the domain's list (acceptNamedUpload);
// this only turns a refusal into a sentence and a chip's type and size.
import { UPLOAD_ACCEPT, type UploadKind, type UploadRefusal } from "@morndo/domain";

export { UPLOAD_ACCEPT };

export function refusalMessage(name: string, error: UploadRefusal): string {
  const shown = name || "That file";
  if (error === "too_big") return `${shown} is over ${/\.(md|txt|json|csv|yaml|yml|log)$/i.test(shown) ? "1 MB" : "10 MB"}.`;
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

export function fileType(name: string, kind: UploadKind | string): string {
  if (kind === "pdf") return "PDF";
  const ext = name.includes(".") ? name.split(".").pop()?.toUpperCase() ?? "" : "";
  return ext || "File";
}
