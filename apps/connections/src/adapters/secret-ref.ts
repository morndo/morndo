import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { RefNotRemoved } from "../application/ports.ts";
import { assertPrivate } from "./file-mode.ts";

export const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function fingerprintOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

// The age vault's names in a vault directory, which the plaintext vault shares: the sealed file, and its fingerprint mark.
// Here, so the plaintext vault can remove a sealed file without a copy of them (round 2, points 2 and 5).
export const SEALED_SUFFIX = ".age";
export const MARK_SUFFIX = `${SEALED_SUFFIX}.fingerprint`;

export function secretPath(dir: string, ref: string, suffix = ""): string {
  if (!SECRET_REF.test(ref)) throw new Error("refused ref");
  return join(dir, `${ref}${suffix}`);
}

// The files of a ref in a vault directory, whichever vault wrote them, as the two share it: the plaintext file and the
// sealed file hold the value, and the sealed file may have a fingerprint mark. Both vaults remove a ref by this one rule
// (round 3, point 6).
export function refFiles(dir: string, ref: string): { values: string[]; mark: string } {
  return { values: [secretPath(dir, ref), secretPath(dir, ref, SEALED_SUFFIX)], mark: secretPath(dir, ref, MARK_SUFFIX) };
}

// Removes every file of `ref` there is, the value files first, each checked private before it goes. When one can't be
// removed after another went, RefNotRemoved names exactly what went and what is left; when the first can't, nothing went
// and its own error (a FileRefused, say) is thrown as it is. A ref with no value file throws RefNotRemoved too, after its
// stray mark is removed, so none is left to fail every later removal (round 3, point 5).
export function removeRef(dir: string, ref: string, uid: number): void {
  const { values, mark } = refFiles(dir, ref);
  const present = [...values, mark].filter(path => existsSync(path));
  const missing = !values.some(path => present.includes(path));
  const removed: string[] = [];
  for (const [i, path] of present.entries()) {
    try {
      assertPrivate(dir, "dir", uid);
      assertPrivate(path, "file", uid);
      unlinkSync(path);
    } catch (error) {
      if (removed.length === 0) throw error;
      throw new RefNotRemoved(ref, removed, present.slice(i).map(p => basename(p)), missing, error);
    }
    removed.push(basename(path));
  }
  if (missing) throw new RefNotRemoved(ref, removed, [], true);
}

// The refs a vault directory's file names stand for, that start with `prefix`: a name is the ref plus the vault's
// `suffix`. A temp file starts with a dot and a fingerprint mark has a suffix of its own, so neither matches. The ref
// grammar stays here, so no vault keeps a copy of it.
export function refsIn(names: readonly string[], prefix: string, suffix: string): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const ref = name.slice(0, name.length - suffix.length);
    if (SECRET_REF.test(ref)) out.push(ref);
  }
  return out.sort();
}
