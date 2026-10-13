// Lay out one Version's tree (design §5, §9.3): node/, app/, bin/, units/, trust/, the licences,
// then files.json. Modes are normalised to 0444 or 0555 so a rebuild does not depend on umask.
// A symlink is judged against the tree root, not the link's parent. One that stays inside is stored
// as a symlink (Node's bin/npm -> ../lib/...). A workspace package is the exception: Node will not
// strip types under node_modules, so the staged copy is the compiled JavaScript when --compiled is set.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { TreeFile } from "./archive.ts";
import { listFiles } from "./files.ts";
import { LAUNCHERS, launcherSource } from "./launchers.ts";
import { thirdPartyNotice } from "./notice.ts";

const SKIP_DIR = new Set(["test", "e2e", ".cache"]);
const APP_TOP = ["package.json", "package-lock.json", "apps", "packages", "node_modules"];

export function stageRelease(p: { repo: string; nodeDir: string; dest: string; version: string; compiled?: string }): void {
  refuseEscapingLinks(p.repo);
  mkdirSync(p.dest, { recursive: true });
  const files: TreeFile[] = [];
  for (const name of APP_TOP) {
    const abs = join(p.repo, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) throw new Error(`symlink escapes the tree: ${name}`);
    if (st.isFile()) files.push({ path: `app/${name}`, bytes: readFileSync(abs), mode: "0444" });
    else if (st.isDirectory()) files.push(...walkCopied(abs, `app/${name}`, () => "0444", realpathSync(p.repo), p.compiled));
  }
  files.push(...walkCopied(p.nodeDir, "node", rel => rel.startsWith("node/bin/") ? "0555" : "0444", realpathSync(p.nodeDir)));
  for (const [name, entry] of Object.entries(LAUNCHERS)) {
    files.push({ path: `bin/${name}`, bytes: Buffer.from(launcherSource(entry)), mode: "0555" });
  }
  files.push({ path: "app/VERSION", bytes: Buffer.from(`${p.version}\n`), mode: "0444" });
  const license = readFileSync(join(p.repo, "LICENSE.md"));
  files.push({ path: "LICENSES/LICENSE.md", bytes: license, mode: "0444" });
  try {
    files.push({ path: "LICENSES/ee-LICENSE.md", bytes: readFileSync(join(p.repo, "ee/LICENSE.md")), mode: "0444" });
  } catch { /* the enterprise licence is absent from a fixture */ }
  const lockPath = join(p.repo, "package-lock.json");
  try {
    const lock: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (isLock(lock)) files.push({ path: "LICENSES/NOTICE", bytes: Buffer.from(thirdPartyNotice(lock)), mode: "0444" });
  } catch { /* a fixture may omit the lock */ }
  files.push({ path: "units", mode: "0555", directory: true }, { path: "trust", mode: "0555", directory: true });
  const listed = listFiles(files);
  files.push({ path: "files.json", bytes: Buffer.from(listed.json), mode: "0444" });
  for (const file of files) {
    const dest = join(p.dest, ...file.path.split("/"));
    mkdirSync(join(dest, ".."), { recursive: true });
    if ("directory" in file) mkdirSync(dest, { recursive: true });
    else if ("link" in file) symlinkSync(file.link, dest);
    else writeFileSync(dest, file.bytes, { mode: file.mode === "0555" ? 0o555 : 0o444 });
  }
}

function walkCopied(
  dir: string, prefix: string, mode: (rel: string) => "0444" | "0555", root: string, compiled?: string,
): TreeFile[] {
  const out: TreeFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    const rel = `${prefix}/${name}`;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      const real = realpathSync(abs);
      if (!inside(real, root)) throw new Error(`symlink escapes the tree: ${rel}`);
      const built = compiledPackage(real, compiled);
      if (built) out.push(...walkCopied(built, rel, mode, built));
      else if (shipped(real, root)) out.push({ path: rel, mode: "0555", link: linkTarget(abs, real) });
      else out.push(copiedUnshipped(abs, rel, real, mode));
      continue;
    }
    if (st.isDirectory()) out.push(...walkCopied(abs, rel, mode, root, compiled));
    else if (st.isFile()) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.js")) continue;
      out.push({ path: rel, bytes: readFileSync(abs), mode: mode(rel) });
    }
  }
  return out;
}

function compiledPackage(real: string, compiled: string | undefined): string | null {
  if (!compiled) return null;
  const name = workspaceName(real);
  if (!name) return null;
  const dest = join(compiled, name);
  try { if (!lstatSync(dest).isDirectory()) return null; }
  catch { return null; }
  return dest;
}

function workspaceName(real: string): string | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(real, "package.json"), "utf8")); }
  catch { return null; }
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") return null;
  if (!value.name.startsWith("@morndo/")) return null;
  return value.name.slice("@morndo/".length);
}

function shipped(real: string, root: string): boolean {
  const rel = relative(root, real).split(sep).join("/");
  const parts = rel.split("/");
  if (parts.some(part => SKIP_DIR.has(part))) return false;
  const base = parts.at(-1) ?? "";
  return !base.endsWith(".test.ts") && !base.endsWith(".test.js");
}

function copiedUnshipped(abs: string, rel: string, real: string, mode: (rel: string) => "0444" | "0555"): TreeFile {
  let st;
  try { st = lstatSync(real); }
  catch { throw new Error(`symlink target is not shipped: ${rel}`); }
  if (!st.isFile()) throw new Error(`symlink target is not shipped: ${rel}`);
  return { path: rel, bytes: readFileSync(abs), mode: mode(rel) };
}

function linkTarget(from: string, real: string): string {
  const rel = relative(realpathSync(dirname(from)), realpathSync(real)).split(sep).join("/");
  if (rel === "" || rel.startsWith("/")) throw new Error(`refusing link target ${rel}`);
  return rel;
}

function refuseEscapingLinks(repo: string): void {
  const root = realpathSync(repo);
  for (const name of readdirSync(repo)) {
    const abs = join(repo, name);
    if (!lstatSync(abs).isSymbolicLink()) continue;
    const target = realpathSync(abs);
    if (!inside(target, root)) throw new Error(`symlink escapes the tree: ${name}`);
  }
}

function inside(path: string, root: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(base);
}

function isLock(value: unknown): value is { packages: Record<string, { version?: string; dev?: boolean }> } {
  if (typeof value !== "object" || value === null || !("packages" in value)) return false;
  const packages = value.packages;
  return typeof packages === "object" && packages !== null;
}
