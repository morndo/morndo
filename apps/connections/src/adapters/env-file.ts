// The file a server's key is written to (ADR-0037, slice 4; plan 3.6): `NAME=value` through a temp file in the same directory, created 0600 and renamed
// over the old file, so a reader never sees half a file or a key anyone else can read. Nothing is written for a path in a git work tree, in a directory
// group or others can write, through a link, or under a protected directory. A name and a value are checked against a closed alphabet so that no quoting
// or escaping exists. A problem is a word; no path, value or system message is returned.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CONNECTION_NAME } from "@morndo/domain";

export type EnvWrite = { path: string; name: string; value: string; member: string; protectedDirs: readonly string[] };
export type EnvWritten = { ok: true } | { ok: false; problem: string };

export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const VALUE = /^[A-Za-z0-9._~+/=-]{1,1024}$/;
const GROUP_OTHERS_WRITE = 0o022;

const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}/`);

function symlinked(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function realOf(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function inRepository(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return true;
    if (dirname(at) === at) return false;
  }
}

// The word for what is wrong with the place, or null: checked before a lease is taken, and again by the write.
export function envPathProblem(path: string, protectedDirs: readonly string[]): string | null {
  if (!isAbsolute(path) || path.endsWith("/")) return "bad_path";
  if (protectedDirs.some(root => inside(root, path))) return "protected";
  if (symlinked(path) || symlinked(`${path}.member`)) return "symlink";
  const dir = dirname(path);
  let mode: number;
  try {
    const found = statSync(dir);
    if (!found.isDirectory()) return "no_dir";
    mode = found.mode;
  } catch { return "no_dir"; }
  // The real place is judged as well as the spelling: a directory that is a link into a protected one is protected.
  if (protectedDirs.some(root => inside(realOf(root), join(realOf(dir), basename(path))))) return "protected";
  if (inRepository(dir)) return "in_repository";
  if ((mode & GROUP_OTHERS_WRITE) !== 0) return "dir_writable";
  return null;
}

function refusal(input: EnvWrite): string | null {
  if (!isAbsolute(input.path) || input.path.endsWith("/")) return "bad_path";
  if (!ENV_NAME.test(input.name)) return "bad_name";
  if (!VALUE.test(input.value)) return "bad_value";
  if (!CONNECTION_NAME.test(input.member)) return "bad_member";
  return envPathProblem(input.path, input.protectedDirs);
}

// The temp file is created 0600 before a byte goes in; rename makes it the file in one step. A failure removes the temp file and leaves the old file.
function replace(path: string, text: string): boolean {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, path);
    return true;
  } catch {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temp); } catch { /* never created */ }
    return false;
  }
}

export function writeEnvFile(input: EnvWrite): EnvWritten {
  const refused = refusal(input);
  if (refused !== null) return { ok: false, problem: refused };
  if (!replace(input.path, `${input.name}=${input.value}\n`)) return { ok: false, problem: "write_failed" };
  if (!replace(`${input.path}.member`, `${input.member}\n`)) return { ok: false, problem: "write_failed" };
  return { ok: true };
}
