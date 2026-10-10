// The build deletes and rewrites its output folder, so it must refuse any folder other than
// assets/ or a .build-* scratch folder inside this package. Every case runs on a sandbox copy of
// the package, so even if the guard regresses, these tests can never wipe the real package.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A copy of the package (scripts, src, source) in a fresh temp folder, node_modules linked. */
function sandbox(): { base: string; pkg: string } {
  const base = mkdtempSync(join(tmpdir(), "morndo-brand-safety-"));
  const pkg = join(base, "pkg");
  for (const d of ["scripts", "src", "source"]) cpSync(join(ROOT, d), join(pkg, d), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(pkg, "package.json"));
  // Its own node_modules when installed alone; as an npm workspace member its dependencies live in the repo root's.
  const deps = [join(ROOT, "node_modules"), join(ROOT, "../../node_modules")].find(d => existsSync(join(d, "sharp")));
  if (!deps) throw new Error("no node_modules with this package's dependencies (run npm install)");
  symlinkSync(deps, join(pkg, "node_modules"), "dir");
  return { base, pkg };
}

const build = (pkg: string, out: string) =>
  spawnSync(process.execPath, [join(pkg, "scripts/build.ts"), out], { cwd: pkg, encoding: "utf8", timeout: 60_000 });

describe("build output folder guard", () => {
  it.each([".", ".."])("refuses %s and deletes nothing", arg => {
    const { base, pkg } = sandbox();
    try {
      const r = build(pkg, arg);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/refusing to write/);
      expect(existsSync(join(pkg, "source/mark.svg"))).toBe(true);
      expect(existsSync(join(pkg, "scripts/build.ts"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a folder outside the package and a package folder such as source/", () => {
    const { base, pkg } = sandbox();
    const outside = mkdtempSync(join(tmpdir(), "morndo-brand-outside-"));
    try {
      for (const arg of [outside, "source", join(pkg, "src")]) {
        const r = build(pkg, arg);
        expect([arg, r.status !== 0, /refusing to write/.test(r.stderr)]).toEqual([arg, true, true]);
      }
      expect(existsSync(outside)).toBe(true);
      expect(existsSync(join(pkg, "source/mark.svg"))).toBe(true);
      expect(existsSync(join(pkg, "src/tokens.ts"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts a .build-* scratch folder inside the package (negative control)", () => {
    const { base, pkg } = sandbox();
    try {
      const r = build(pkg, ".build-check");
      expect(r.status).toBe(0);
      expect(existsSync(join(pkg, ".build-check/mark/morndo-mark-black.svg"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);
});
