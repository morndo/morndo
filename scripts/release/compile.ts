// Workspace packages publish TypeScript (`exports` point at `./src/index.ts`). Node refuses to
// strip types for a file under node_modules (nodejs.org/docs/latest-v24.x/api/typescript.html,
// "Type stripping in dependencies", v24.21.0, read 2026-10-13). The staged copy is JavaScript,
// emitted by tsc with the repo's rewriteRelativeImportExtensions already on.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SKIP = new Set(["web"]);

export function compileWorkspaces(repo: string, out: string): void {
  const tsc = join(repo, "node_modules/typescript/lib/tsc.js");
  if (!existsSync(tsc)) throw new Error("typescript is not installed; compile before pruning dev dependencies");
  mkdirSync(out, { recursive: true });
  for (const group of ["packages", "apps"]) {
    const base = join(repo, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      if (SKIP.has(name)) continue;
      const dir = join(base, name);
      if (!existsSync(join(dir, "tsconfig.json"))) continue;
      compilePackage(repo, dir, join(out, name), join(out, `${name}.tsconfig.json`));
    }
  }
}

export function compilePackage(repo: string, dir: string, dest: string, config: string): void {
  const tsc = join(repo, "node_modules/typescript/lib/tsc.js");
  if (!existsSync(tsc)) throw new Error("typescript is not installed; compile before pruning dev dependencies");
  mkdirSync(dest, { recursive: true });
  // A config outside the package, with an explicit rootDir, so tsc never emits beside the sources.
  // Tests stay out: one app's tests import another app. Ambient declarations (*.d.ts) stay in.
  writeFileSync(config, `${JSON.stringify({
    extends: join(dir, "tsconfig.json"),
    compilerOptions: {
      noEmit: false, outDir: dest, rootDir: dir,
      typeRoots: [join(repo, "node_modules/@types")],
    },
    include: [join(dir, "src"), join(dir, "**/*.d.ts")],
  })}\n`);
  const run = spawnSync(process.execPath, [tsc, "-p", config, "--pretty", "false"], { cwd: repo, encoding: "utf8" });
  rmSync(config, { force: true });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || `tsc failed for ${dir}`);
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readFileSync(pkgPath, "utf8");
    writeFileSync(join(dest, "package.json"), rewritePackage(pkg));
    copyReferenced(dir, dest, pkg);
  }
}

function copyReferenced(dir: string, dest: string, pkgText: string): void {
  const assets = join(dir, "assets");
  if (existsSync(assets)) cpSync(assets, join(dest, "assets"), { recursive: true });
  for (const target of exportTargets(pkgText)) {
    if (target === "./package.json" || /\.(tsx?|jsx?|mjs|cjs)$/.test(target)) continue;
    const rel = target.replace(/^\.\//, "");
    const from = join(dir, rel);
    if (!existsSync(from) || !statSync(from).isFile()) throw new Error(`export target is missing: ${target}`);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

function exportTargets(pkgText: string): string[] {
  const pkg: unknown = JSON.parse(pkgText);
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("./")) found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  if (typeof pkg === "object" && pkg !== null && "exports" in pkg) walk(pkg.exports);
  return found;
}

function rewritePackage(text: string): string {
  const pkg: unknown = JSON.parse(text);
  if (typeof pkg === "object" && pkg !== null && "exports" in pkg) {
    return `${JSON.stringify({ ...pkg, exports: rewriteTs(pkg.exports) }, null, 2)}\n`;
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function rewriteTs(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\.tsx?$/g, ".js");
  if (Array.isArray(value)) return value.map(rewriteTs);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = rewriteTs(item);
    return out;
  }
  return value;
}
