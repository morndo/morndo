// Workspace packages publish TypeScript (`exports` point at `./src/index.ts`). Node refuses to
// strip types for a file under node_modules (nodejs.org/docs/latest-v24.x/api/typescript.html,
// "Type stripping in dependencies", v24.21.0, read 2026-10-13). The staged copy is JavaScript,
// emitted by tsc with the repo's rewriteRelativeImportExtensions already on.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
      const dest = join(out, name);
      mkdirSync(dest, { recursive: true });
      // Tests import other apps, so a rootDir of the package cannot include them. Emit src only.
      const config = join(out, `${name}.tsconfig.json`);
      writeFileSync(config, `${JSON.stringify({
        extends: join(dir, "tsconfig.json"),
        compilerOptions: { noEmit: false, outDir: dest, rootDir: dir },
        include: [join(dir, "src")],
      })}\n`);
      const run = spawnSync(process.execPath, [
        tsc, "-p", config, "--pretty", "false",
      ], { cwd: repo, encoding: "utf8" });
      rmSync(config, { force: true });
      if (run.status !== 0) throw new Error(run.stderr || run.stdout || `tsc failed for ${name}`);
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) writeFileSync(join(dest, "package.json"), rewritePackage(readFileSync(pkgPath, "utf8")));
    }
  }
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
