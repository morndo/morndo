// One product Version, the root package.json, not a workspace package's own (design: releases, section 4.1).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = { name?: string; version?: string; workspaces?: unknown };

function readPackage(path: string): PackageJson | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as PackageJson; }
  catch { return null; }
}

// The workspace root (name "morndo", with workspaces) above a file or directory.
function productRoot(from: string): { dir: string; pkg: PackageJson } {
  let dir = from.endsWith("package.json") ? dirname(from) : from;
  if (!from.endsWith("package.json") && /\.[cm]?[jt]s$/.test(from)) dir = dirname(from);
  for (let i = 0; i < 8; i++) {
    const pkg = readPackage(join(dir, "package.json"));
    if (pkg?.name === "morndo" && pkg.workspaces !== undefined && typeof pkg.version === "string" && pkg.version.length > 0) return { dir, pkg };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("the root package.json has no product version");
}

// What a tree runs: the Version and the commit it was built from. `commit` is null when nothing says.
export type ProductBuild = { version: string; commit: string | null };

// The build stamp, written at the root of a release tree when it is staged: { version, commit } (design: updates, section 9.1).
export const BUILD_STAMP = "build.json";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT = /^[0-9a-f]{40}$/;

function readStamp(dir: string): ProductBuild | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dir, BUILD_STAMP), "utf8"));
    if (typeof v !== "object" || v === null) return null;
    const { version, commit } = v as { version?: unknown; commit?: unknown };
    if (typeof version === "string" && SEMVER.test(version) && typeof commit === "string" && COMMIT.test(commit)) return { version, commit };
  } catch { /* no stamp */ }
  return null;
}

// The HEAD of a checkout at `dir`, or null when it is not one (no .git, no git, or an unborn HEAD).
function gitHead(dir: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return COMMIT.test(out) ? out : null;
  } catch { return null; }
}

const builds = new Map<string, ProductBuild>();

// The build this tree runs. A stamped tree reports its stamp (a Release's Version and its commit). An unstamped
// checkout reports the root package.json version and its git HEAD. Read once per tree: a service reads it at start.
export function productBuild(from: string = fileURLToPath(import.meta.url)): ProductBuild {
  const { dir, pkg } = productRoot(from);
  let b = builds.get(dir);
  if (!b) {
    b = readStamp(dir) ?? { version: pkg.version as string, commit: gitHead(dir) };
    builds.set(dir, b);
  }
  return b;
}

// The product Version: the stamp's when the tree has one, else the root package.json's.
export function productVersion(from?: string): string { return productBuild(from).version; }

// `0.4.2+3fa2c1d09b7e`: the Version with the first 12 characters of the commit as SemVer build metadata; the bare Version without a commit.
export function buildLabel(from?: string): string {
  const { version, commit } = productBuild(from);
  return commit === null ? version : `${version}+${commit.slice(0, 12)}`;
}

// `--version` only when it is the first argument, and only in the part before `--`.
export function argvWantsVersion(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const stop = args.indexOf("--");
  const head = stop === -1 ? args : args.slice(0, stop);
  return head[0] === "--version";
}

// `{ version, commit }` for a health answer; no commit key when the tree has none.
export function productStamp(from?: string): { version: string; commit?: string } {
  const { version, commit } = productBuild(from);
  return commit === null ? { version } : { version, commit };
}
