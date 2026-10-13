// The plain SHA256SUMS beside the Manifest (design §9.4). Two spaces, lowercase, filename order.
import { createHash } from "node:crypto";

export function sha256Sums(files: readonly { name: string; bytes: Uint8Array }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(file => `${createHash("sha256").update(file.bytes).digest("hex")}  ${file.name}`);
  return `${lines.join("\n")}\n`;
}
