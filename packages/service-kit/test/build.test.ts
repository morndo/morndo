import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLabel, productBuild, productVersion } from "../src/version.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const COMMIT = "3fa2c1d09b7e4a5c8d1f6e2b0a9c7d5e4f3a2b1c";

// A made-up product tree: the root package.json, and a service directory under it.
function tree(): { root: string; service: string } {
  const root = mkdtempSync(join(tmpdir(), "build-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "morndo", version: "0.0.0", workspaces: ["apps/*"] }));
  const service = join(root, "apps", "demo", "src");
  mkdirSync(service, { recursive: true });
  return { root, service };
}

describe("productBuild", () => {
  it("a stamped tree reports version+commit", () => {
    const { root, service } = tree();
    writeFileSync(join(root, "build.json"), JSON.stringify({ version: "0.4.2", commit: COMMIT }));
    expect(productBuild(service)).toEqual({ version: "0.4.2", commit: COMMIT });
    expect(productVersion(service)).toBe("0.4.2");
    expect(buildLabel(service)).toBe("0.4.2+3fa2c1d09b7e");
  });

  it("an unstamped checkout reports the git HEAD", () => {
    const { root, service } = tree();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root } }).trim();
    git("init", "-q");
    git("-c", "user.email=a@example.test", "-c", "user.name=A", "add", "package.json");
    git("-c", "user.email=a@example.test", "-c", "user.name=A", "commit", "-q", "-m", "x");
    const head = git("rev-parse", "HEAD");
    expect(productBuild(service)).toEqual({ version: "0.0.0", commit: head });
    expect(buildLabel(service)).toBe(`0.0.0+${head.slice(0, 12)}`);
  });

  it("neither stamp nor git: the version alone, no commit", () => {
    const { service } = tree();
    expect(productBuild(service)).toEqual({ version: "0.0.0", commit: null });
    expect(buildLabel(service)).toBe("0.0.0");
  });

  it("a malformed stamp is ignored, not trusted", () => {
    const { root, service } = tree();
    writeFileSync(join(root, "build.json"), JSON.stringify({ version: "0.4.2", commit: "not a commit" }));
    expect(productBuild(service)).toEqual({ version: "0.0.0", commit: null });
  });
});
