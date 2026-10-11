// The workspace roots adapter (design §6): a path belongs to the repository whose git common directory it resolves to,
// which every worktree and subdirectory of that repository shares. A remote counts for nothing, and neither does a GIT_
// variable in the adapter's own environment.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspaceRoots } from "../src/adapters/git-workspaces.ts";

// The fixtures' git: none of this process's GIT_ variables, no global or system config, the identity on the command line.
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
  return env;
}
const git = (cwd: string, args: readonly string[]) => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid"].concat(args), { cwd, env: fixtureEnv(), stdio: "ignore" });
};

let dir = "";
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "morndo-git-workspaces-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// A repository with one commit, so a second worktree can branch from it.
function repo(name: string): string {
  const root = join(dir, name);
  mkdirSync(root);
  git(root, ["init", "-q"]);
  git(root, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "first"]);
  return root;
}

// Sets one variable for the length of `f`, then puts back what was there.
function withEnv(name: string, value: string, f: () => void): void {
  const saved = process.env[name];
  process.env[name] = value;
  try { f(); } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("GitWorkspaceRoots", () => {
  it("resolves a repository, a second worktree of it and a subdirectory of each to one common directory", () => {
    const root = repo("app");
    const second = join(dir, "app-second");
    git(root, ["worktree", "add", "-q", "-b", "second", second]);
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(second, "docs"));
    const roots = new GitWorkspaceRoots();
    const common = join(root, ".git");
    expect([root, second, join(root, "src", "deep"), join(second, "docs")].map(p => roots.commonDir(p))).toEqual([common, common, common, common]);
  });

  it("answers with the real path when it is reached through a link", () => {
    const root = repo("app");
    symlinkSync(root, join(dir, "link"));
    expect(new GitWorkspaceRoots().commonDir(join(dir, "link"))).toBe(join(root, ".git"));
  });

  it("gives null for a plain directory and for a missing path", () => {
    mkdirSync(join(dir, "plain"));
    const roots = new GitWorkspaceRoots();
    expect(roots.commonDir(join(dir, "plain"))).toBeNull();
    expect(roots.commonDir(join(dir, "missing"))).toBeNull();
  });

  it("resolves a scratch repository with another's remote to its own common directory, not the other's", () => {
    const app = repo("app");
    const url = "https://example.invalid/team/app.git";
    git(app, ["remote", "add", "origin", url]);
    const scratch = join(dir, "scratch");
    mkdirSync(scratch);
    git(scratch, ["init", "-q"]);
    git(scratch, ["remote", "add", "origin", url]);
    const roots = new GitWorkspaceRoots();
    expect(roots.commonDir(scratch)).toBe(join(scratch, ".git"));
    expect(roots.commonDir(app)).toBe(join(app, ".git"));
  });

  it("is not redirected by GIT_DIR or GIT_COMMON_DIR in its own environment", () => {
    const app = repo("app");
    const other = repo("other");
    mkdirSync(join(dir, "plain"));
    const roots = new GitWorkspaceRoots();
    withEnv("GIT_DIR", join(app, ".git"), () => {
      expect(roots.commonDir(other)).toBe(join(other, ".git"));
      expect(roots.commonDir(join(dir, "plain"))).toBeNull();
    });
    withEnv("GIT_COMMON_DIR", join(app, ".git"), () => {
      expect(roots.commonDir(other)).toBe(join(other, ".git"));
    });
  });
});
