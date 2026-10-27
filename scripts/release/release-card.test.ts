// scripts/release/release-card.sh prints the release card: what changed, between two commits, in the paths that reach
// the signing keys or what a machine installs (.github/workflows/, .github/CODEOWNERS, scripts/release/, trust/,
// install.sh, apps/updater/). The owner reads it before the tap that lets a release run use a key (release plan,
// decision 9). These tests build a small git repository per case and read what the card says about it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./release-card.sh", import.meta.url));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-card-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commit(dir: string, subject: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git(dir, "rm", "-q", path);
    else { put(dir, path, text); git(dir, "add", path); }
  }
  git(dir, "commit", "-q", "--allow-empty", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

function card(dir: string, ...args: string[]) {
  const r = spawnSync("sh", [SCRIPT, ...args], { cwd: dir, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const short = (sha: string) => sha.slice(0, 8);

describe("release-card.sh", () => {
  it("says nothing changed when only other paths changed, and lists none of them", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "install.sh": "echo a\n" });
    const head = commit(dir, "docs: readme", { "README.md": "b\n", "apps/hub/src/main.ts": "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(`release card: ${short(base)}..${short(head)}`);
    expect(r.out).toContain(`release card: no change in the release-critical paths since ${short(base)}\n`);
    expect(r.out).not.toContain("README.md");
    expect(r.out).not.toContain("apps/hub");
    expect(r.out).not.toContain("files:");
  });

  it("lists added, modified and deleted files sorted by path, and the commits that touched them", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "trust/keys.json": "{}\n", "install.sh": "echo a\n", "README.md": "a\n" });
    const c1 = commit(dir, "feat(release): a new workflow", { ".github/workflows/feed.yml": "on: push\n" });
    commit(dir, "docs: readme only", { "README.md": "b\n" });
    const c3 = commit(dir, "fix(install): verify first", { "install.sh": "echo b\n", "trust/keys.json": null });
    const r = card(dir, base, c3);
    expect(r.code).toBe(0);
    expect(r.out).toContain([
      "files:",
      "  A .github/workflows/feed.yml",
      "  M install.sh",
      "  D trust/keys.json",
      "",
    ].join("\n"));
    expect(r.out).toContain([
      "commits:",
      `  ${short(c3)} fix(install): verify first`,
      `  ${short(c1)} feat(release): a new workflow`,
      "",
    ].join("\n"));
    expect(r.out).not.toContain("readme only");
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(`release card: 3 file(s) changed in the release-critical paths since ${short(base)}`);
  });

  it.each([
    ".github/workflows/release.yml",
    ".github/CODEOWNERS",
    "scripts/release/feed.ts",
    "trust/feed_allowed_signers",
    "install.sh",
    "apps/updater/src/cli.ts",
  ])("watches %s", path => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { [path]: "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  A ${path}\n`);
  });

  it("does not take a path that only begins like a watched one", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: lookalikes", {
      "install.sh.bak": "x\n",
      "scripts/release-notes.md": "x\n",
      "apps/updater-old/a.ts": "x\n",
      "trust.md": "x\n",
      ".github/workflows-old/a.yml": "x\n",
    });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`release card: no change in the release-critical paths since ${short(base)}\n`);
  });

  it("shows a rename as the old path deleted and the new one added", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "scripts/release/old.sh": "echo same\n" });
    git(dir, "mv", "scripts/release/old.sh", "scripts/release/new.sh");
    const head = commit(dir, "refactor: rename", {});
    const r = card(dir, base, head);
    expect(r.out).toContain("  A scripts/release/new.sh\n  D scripts/release/old.sh\n");
  });

  it("removes control characters from a commit subject", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "fix: \u001b[31mred\u001b[0m bell\u0007", { "install.sh": "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  ${short(head)} fix: [31mred[0m bell\n`);
    const control: number[] = [];
    for (let i = 0; i < r.out.length; i++) {
      const c = r.out.charCodeAt(i);
      if (c !== 0x0a && (c < 0x20 || c === 0x7f)) control.push(c);
    }
    expect(control).toEqual([]);
  });

  it("lists the commits a merge brought in, not the merge itself", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const work = commit(dir, "feat(release): a new step", { "scripts/release/step.sh": "x\n" });
    git(dir, "checkout", "-q", "main");
    commit(dir, "docs: readme on main", { "README.md": "b\n" });
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge pull request #1 from feature", "feature");
    const head = git(dir, "rev-parse", "HEAD");
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`commits:\n  ${short(work)} feat(release): a new step\nrelease card: 1 file(s)`);
    expect(r.out).not.toContain("Merge pull request");
  });

  it("lists a merge that itself changes a watched path", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "install.sh": "a\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "docs: readme", { "README.md": "b\n" });
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "--no-commit", "feature");
    put(dir, "install.sh", "edited in the merge\n");
    git(dir, "add", "install.sh");
    git(dir, "commit", "-q", "-m", "Merge pull request #2 from feature");
    const head = git(dir, "rev-parse", "HEAD");
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`commits:\n  ${short(head)} Merge pull request #2 from feature\n`);
    expect(r.out).toContain("  M install.sh\n");
  });

  it("reads the paths from the top of the repository when run from a subdirectory", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "scripts/notes.md": "a\n" });
    const head = commit(dir, "fix(install): verify first", { "install.sh": "x\n" });
    const r = spawnSync("sh", [SCRIPT, base, head], { cwd: join(dir, "scripts"), env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  A install.sh\n");
  });

  it("refuses a base that is not an ancestor of the head", () => {
    const dir = repo();
    const root = commit(dir, "chore: root", { "README.md": "a\n" });
    const a = commit(dir, "chore: a", { "install.sh": "a\n" });
    git(dir, "checkout", "-q", "-b", "side", root);
    const b = commit(dir, "chore: b", { "install.sh": "b\n" });
    const r = card(dir, a, b);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`release-card: ${short(a)} is not an ancestor of ${short(b)}`);
    expect(r.out).toBe("");
  });

  it("refuses a commit that does not resolve", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const r = card(dir, base, "no-such-ref");
    expect(r.code).toBe(1);
    expect(r.err).toContain("release-card: no-such-ref does not resolve to a commit");
  });

  it("is a usage error without exactly two commits", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    for (const args of [[], [base], [base, base, base], ["", base]]) {
      const r = card(dir, ...args);
      expect(r.code).toBe(64);
      expect(r.err).toContain("release-card: usage: release-card.sh <base> <head>");
    }
  });

  it("refuses to run outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-card-nogit-"));
    roots.push(dir);
    const r = card(dir, "a", "b");
    expect(r.code).toBe(1);
    expect(r.err).toContain("release-card: not inside a git repository");
  });
});
