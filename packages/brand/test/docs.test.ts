// The docs only point to commands and files that exist: every `npm run <x>` is a script of this
// package, a workspace command (`-w @morndo/brand`) appears only once a root npm workspace includes
// packages/*, and `.nvmrc` is mentioned only if one exists.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ROOT, "../..");
const adr = readdirSync(join(REPO, "docs/adr")).filter(f => f.startsWith("0007-")).map(f => join(REPO, "docs/adr", f));
const DOCS = [...["README.md", "COLOR.md", "USAGE.md", "WIRING-web.md", "scripts/build.ts", "src/index.ts"].map(f => join(ROOT, f)), ...adr];
const scripts = Object.keys((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts);
const rootPkg = join(REPO, "package.json");
const workspace = existsSync(rootPkg) && ((JSON.parse(readFileSync(rootPkg, "utf8")) as { workspaces?: string[] }).workspaces ?? []).includes("packages/*");

describe.each(DOCS.map(f => [f.slice(REPO.length + 1), f]))("%s", (_name, file) => {
  const text = readFileSync(file, "utf8");
  it("names only npm scripts that exist in packages/brand/package.json", () => {
    const named = [...text.matchAll(/npm run ([a-z][\w:-]*)/g)].map(m => m[1]);
    expect(named.filter(n => !scripts.includes(n ?? ""))).toEqual([]);
  });
  it("uses a workspace command (-w @morndo/brand) only when a root workspace includes packages/*", () => {
    if (!workspace) expect(text).not.toMatch(/-w @morndo\/brand/);
  });
  it("mentions .nvmrc only if one exists", () => {
    if (!existsSync(join(ROOT, ".nvmrc")) && !existsSync(join(REPO, ".nvmrc"))) expect(text).not.toMatch(/\.nvmrc/);
  });
});
