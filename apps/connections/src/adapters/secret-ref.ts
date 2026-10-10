import { createHash } from "node:crypto";
import { join } from "node:path";

export const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function fingerprintOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

export function secretPath(dir: string, ref: string, suffix = ""): string {
  if (!SECRET_REF.test(ref)) throw new Error("refused ref");
  return join(dir, `${ref}${suffix}`);
}
