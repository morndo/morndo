// Lay out one Version's tree (design §5, §9.3): node/, app/, bin/, units/, trust/, the licences,
// then files.json. Modes are normalised to 0444 or 0555 so a rebuild does not depend on umask.
// A symlink is judged against the tree root, not the link's parent. One that stays inside is stored
// as a symlink (Node's bin/npm -> ../lib/...). A workspace package is the exception: Node will not
// strip types under node_modules, so the staged copy is the compiled JavaScript when --compiled is set.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { TreeFile } from "./archive.ts";
import { listFiles } from "./files.ts";
import { launcherSource, launchersFrom } from "./launchers.ts";
import { thirdPartyNotice } from "./notice.ts";

const SKIP_DIR = new Set(["test", "e2e", ".cache"]);
const APP_TOP = ["package.json", "package-lock.json", "apps", "packages", "node_modules"];

export function stageRelease(p: { repo: string; nodeDir: string; dest: string; version: string; commit: string; compiled?: string }): void {
  refuseEscapingLinks(p.repo);
  mkdirSync(p.dest, { recursive: true });
  const files: TreeFile[] = [];
  for (const name of APP_TOP) {
    const abs = join(p.repo, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) throw new Error(`symlink escapes the tree: ${name}`);
    if (st.isFile()) files.push({ path: `app/${name}`, bytes: readFileSync(abs), mode: "0444" });
    else if (st.isDirectory()) files.push(...walkCopied(abs, `app/${name}`, () => "0444", realpathSync(p.repo), p.compiled, APP_TOP));
  }
  files.push(...walkCopied(p.nodeDir, "node", rel => rel.startsWith("node/bin/") ? "0555" : "0444", realpathSync(p.nodeDir), undefined, null));
  for (const [name, entry] of Object.entries(launchersFrom(p.repo))) {
    files.push({ path: `bin/${name}`, bytes: Buffer.from(launcherSource(entry)), mode: "0555" });
  }
  // The build stamp (packages/service-kit/src/version.ts, BUILD_STAMP) every service reads at start: the Release's Version and the commit it was built from.
  files.push({ path: "app/build.json", bytes: Buffer.from(`${JSON.stringify({ version: p.version, commit: p.commit })}\n`), mode: "0444" });
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
  files.push({ path: "units", mode: "0555", directory: true }, ...unitTemplates(p.repo), { path: "trust", mode: "0555", directory: true });
  // trust/ is the Key set this Version ships with (design §5): the repo's keys.json and root's signature over it. An
  // installer refuses a tree without trust/keys.json (T-354). The release build verifies the signature against the pinned
  // root signer before and after staging (check-key-set.sh); a keys.json without a readable, non-empty signature is
  // refused here too, so the Key set ships signed or not at all. The signers files are the pipeline's own and do not
  // ship. A fixture tree without trust/keys.json stages trust/ empty.
  if (existsSync(join(p.repo, "trust", "keys.json"))) {
    for (const name of ["keys.json", "keys.json.sig"]) {
      let bytes: Buffer;
      try { bytes = readFileSync(join(p.repo, "trust", name)); }
      catch { throw new Error(`trust/${name} is missing or unreadable: the Key set ships signed or not at all`); }
      if (bytes.length === 0) throw new Error(`trust/${name} is empty: the Key set ships signed or not at all`);
      files.push({ path: `trust/${name}`, bytes, mode: "0444" });
    }
  }
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

// The pack step's walk of a staged tree (design §9.3): every file, link and empty directory it holds,
// with the modes the walk knows, plus one entry for every directory files.json lists — trust/ and
// units/ are named even when they are not empty, so the archive carries the mode files.json is checked
// against. A listed directory whose mode is not 0555 would promise a mode the tree does not keep: refused.
export function stagedTreeFiles(root: string): TreeFile[] {
  const out: TreeFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        out.push({ path: rel, mode: "0555", link: readlinkSync(abs).split(sep).join("/") });
      } else if (st.isDirectory()) {
        if (readdirSync(abs).length === 0) out.push({ path: rel, mode: "0555", directory: true });
        else walk(abs, rel);
      } else if (st.isFile()) {
        const mode = rel.startsWith("bin/") || rel.startsWith("node/bin/") ? "0555" : "0444";
        out.push({ path: rel, bytes: readFileSync(abs), mode });
      }
    }
  };
  walk(root, "");
  const walked = new Set(out.filter(file => "directory" in file).map(file => file.path));
  const list = JSON.parse(readFileSync(join(root, "files.json"), "utf8")) as { path: string; mode: string }[];
  for (const entry of list) {
    let st;
    try { st = lstatSync(join(root, entry.path)); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (entry.mode !== "0555") throw new Error(`${entry.path}: a listed directory's mode is ${entry.mode}, not 0555`);
    if (walked.has(entry.path)) continue;
    out.push({ path: entry.path, mode: "0555", directory: true });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The service templates (design §5): apps/updater/units/** ships inside every Version as units/, read-only
// like the rest of the tree, so the signed file list covers what renderUnits writes for the service manager.
// A fixture repository without the directory keeps the empty units/ this function always made.
function unitTemplates(repo: string): TreeFile[] {
  const dir = join(repo, "apps/updater/units");
  if (!existsSync(dir)) return [];
  const walk = (from: string, prefix: string): TreeFile[] =>
    readdirSync(from).sort().flatMap(name => {
      const abs = join(from, name);
      return lstatSync(abs).isDirectory() ? walk(abs, `${prefix}${name}/`)
        : [{ path: `${prefix}${name}`, bytes: readFileSync(abs), mode: "0444" as const }];
    });
  return walk(dir, "units/");
}

function walkCopied(
  dir: string, prefix: string, mode: (rel: string) => "0444" | "0555", root: string, compiled?: string,
  tops: readonly string[] | null = null,
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
      else if (shipped(real, root, tops)) out.push({ path: rel, mode: "0555", link: linkTarget(abs, real) });
      else out.push(copiedUnshipped(abs, rel, real, mode));
      continue;
    }
    if (st.isDirectory()) out.push(...walkCopied(abs, rel, mode, root, compiled, tops));
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

function shipped(real: string, root: string, tops: readonly string[] | null): boolean {
  const rel = relative(root, real).split(sep).join("/");
  const parts = rel.split("/").filter(Boolean);
  if (tops && !tops.includes(parts[0] ?? "")) return false;
  if (parts.some(part => SKIP_DIR.has(part))) return false;
  const base = parts.at(-1) ?? "";
  return !base.endsWith(".test.ts") && !base.endsWith(".test.js");
}

function copiedUnshipped(abs: string, rel: string, real: string, mode: (rel: string) => "0444" | "0555"): TreeFile {
  let st;
  try { st = lstatSync(real); }
  catch { throw new Error(`symlink target is not shipped: ${rel}`); }
  if (st.isDirectory()) throw new Error(`symlink target is an unshipped directory: ${real}`);
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
