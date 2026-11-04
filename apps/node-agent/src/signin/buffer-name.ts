import { createHash } from "node:crypto";

export function signInBufferName(id: string): string {
  return `md-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}
