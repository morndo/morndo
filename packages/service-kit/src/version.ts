// One product Version, the root package.json, not a workspace package's own (design: releases, section 4.1).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = { name?: string; version?: string; workspaces?: unknown };

function readPackage(path: string): PackageJson | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as PackageJson; }
  catch { return null; }
}

// Walk up from a file or directory until the workspace root (name "morndo", with workspaces).
export function productVersion(from: string = fileURLToPath(import.meta.url)): string {
  let dir = from.endsWith("package.json") ? dirname(from) : from;
  if (!from.endsWith("package.json") && /\.[cm]?[jt]s$/.test(from)) dir = dirname(from);
  for (let i = 0; i < 8; i++) {
    const pkg = readPackage(join(dir, "package.json"));
    if (pkg?.name === "morndo" && pkg.workspaces !== undefined && typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("the root package.json has no product version");
}
