// Lay out one Version's tree (design §5, §9.3): node/, app/, bin/, units/, trust/, the licences,
// then files.json. Modes are normalised to 0444 or 0555 so a rebuild does not depend on umask.
// A symlink that points outside the tree is refused; one that points inside is stored as a file.
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { TreeFile } from "./archive.ts";
import { listFiles } from "./files.ts";
import { LAUNCHERS, launcherSource } from "./launchers.ts";
import { thirdPartyNotice } from "./notice.ts";

const SKIP_DIR = new Set(["test", "e2e", ".cache"]);
const APP_TOP = ["package.json", "package-lock.json", "apps", "packages", "node_modules"];

export function stageRelease(p: { repo: string; nodeDir: string; dest: string; version: string }): void {
  refuseEscapingLinks(p.repo);
  mkdirSync(p.dest, { recursive: true });
  const files: TreeFile[] = [];
  for (const name of APP_TOP) {
    const abs = join(p.repo, name);
    let st;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) throw new Error(`symlink escapes the tree: ${name}`);
    if (st.isFile()) files.push({ path: `app/${name}`, bytes: readFileSync(abs), mode: "0444" });
    else if (st.isDirectory()) files.push(...walkApp(abs, `app/${name}`));
  }
  files.push(...walkCopied(p.nodeDir, "node", rel => rel.startsWith("node/bin/") ? "0555" : "0444"));
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
    const lock = readJson(readFileSync(lockPath, "utf8"));
    if (isLock(lock)) files.push({ path: "LICENSES/NOTICE", bytes: Buffer.from(thirdPartyNotice(lock)), mode: "0444" });
  } catch { /* a fixture may omit the lock */ }
  mkdirSync(join(p.dest, "units"), { recursive: true });
  mkdirSync(join(p.dest, "trust"), { recursive: true });
  const listed = listFiles(files);
  files.push({ path: "files.json", bytes: Buffer.from(listed.json), mode: "0444" });
  for (const file of files) {
    const dest = join(p.dest, ...file.path.split("/"));
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, file.bytes, { mode: file.mode === "0555" ? 0o555 : 0o444 });
  }
  void p.version;
}

function walkApp(dir: string, prefix: string): TreeFile[] {
  return walkCopied(dir, prefix, () => "0444").filter(file => !file.path.endsWith(".test.ts"));
}

function walkCopied(dir: string, prefix: string, mode: (rel: string) => "0444" | "0555"): TreeFile[] {
  const out: TreeFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    const rel = `${prefix}/${name}`;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      if (!inside(realpathSync(abs), dir)) throw new Error(`symlink escapes the tree: ${rel}`);
      const followed = lstatSync(realpathSync(abs));
      if (followed.isDirectory()) out.push(...walkCopied(realpathSync(abs), rel, mode));
      else if (followed.isFile()) out.push({ path: rel, bytes: readFileSync(realpathSync(abs)), mode: mode(rel) });
      continue;
    }
    if (st.isDirectory()) out.push(...walkCopied(abs, rel, mode));
    else if (st.isFile()) {
      if (name.endsWith(".test.ts")) continue;
      out.push({ path: rel, bytes: readFileSync(abs), mode: mode(rel) });
    }
  }
  return out;
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

function readJson(text: string): unknown {
  return JSON.parse(text);
}

function isLock(value: unknown): value is { packages: Record<string, { version?: string; dev?: boolean }> } {
  if (typeof value !== "object" || value === null || !("packages" in value)) return false;
  const packages = value.packages;
  return typeof packages === "object" && packages !== null;
}
