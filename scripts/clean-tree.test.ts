// A test run must leave the repository as it found it (T-24, T-26): a unit test that writes into the directory the suite runs
// in, instead of its own temporary one, leaves a stray file for the next person's `git status` and can fail another test that
// meets it (an empty `m` from a tmux control did both). clean-tree.ts reads the untracked files before a run and after it.
// Here against real git repositories in temporary directories.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leftBehind, untrackedFiles, watchTree } from "./clean-tree.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-clean-tree-"));
  dirs.push(dir);
  // Nothing of the surrounding environment: no GIT_DIR, GIT_INDEX_FILE … from a hook or a shell, no global or system configuration.
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@users.noreply.github.com", ...args], { cwd: dir, env, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "kept"), "tracked\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git("add", "kept", ".gitignore");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("the fixture's git", () => {
  it("is the repository in its own directory, whatever GIT_* variables the run inherits", () => {
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
    const elsewhere = mkdtempSync(join(tmpdir(), "morndo-clean-tree-elsewhere-"));
    dirs.push(elsewhere);
    process.env.GIT_DIR = join(elsewhere, "not-this-one");
    process.env.GIT_WORK_TREE = elsewhere;
    try {
      const dir = repo();
      expect(existsSync(join(dir, ".git"))).toBe(true);
      expect(existsSync(join(elsewhere, "not-this-one"))).toBe(false);
    } finally {
      for (const [name, value] of [["GIT_DIR", saved.dir], ["GIT_WORK_TREE", saved.tree]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
});

describe("untrackedFiles", () => {
  it("lists every untracked file, one by one, and none that is tracked, ignored or merely changed", () => {
    const dir = repo();
    writeFileSync(join(dir, "kept"), "changed\n");
    writeFileSync(join(dir, "ignored.log"), "x");
    mkdirSync(join(dir, "deep/er"), { recursive: true });
    writeFileSync(join(dir, "deep/er/stray"), "x");
    writeFileSync(join(dir, "m"), "");
    expect(untrackedFiles(dir)?.sort()).toEqual(["deep/er/stray", "m"]);
  });
  it("only reads: it leaves the index alone, so it never takes the index lock while someone else commits", () => {
    const dir = repo();
    // Same content, new mtime: plain `git status` refreshes the stat data and rewrites the index (through index.lock) when it can.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, "kept"), later, later);
    const index = join(dir, ".git/index");
    const before = statSync(index);
    untrackedFiles(dir);
    const after = statSync(index);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });
  it("is null where there is no git repository, so a run outside one is not judged", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-clean-tree-"));
    dirs.push(dir);
    expect(untrackedFiles(dir)).toBeNull();
  });
});

describe("leftBehind", () => {
  it("names what appeared during the run, not what was already there", () => {
    expect(leftBehind(["old", "also-old"], ["old", "also-old", "m", "x/y"])).toEqual(["m", "x/y"]);
    expect(leftBehind(["old"], ["old"])).toEqual([]);
    expect(leftBehind(["old"], [])).toEqual([]);                       // a file removed meanwhile is not a leak
  });
  it("judges nothing when either reading is missing", () => {
    expect(leftBehind(null, ["m"])).toEqual([]);
    expect(leftBehind(["m"], null)).toEqual([]);
  });
  it("finds the file a leaking test leaves, in a real repository", () => {
    const dir = repo();
    const before = untrackedFiles(dir);
    writeFileSync(join(dir, "m"), "");                                 // what the unescaped tmux control did to the working directory
    expect(leftBehind(before, untrackedFiles(dir))).toEqual(["m"]);
  });
});

describe("watchTree", () => {
  it("fails the check, naming the file, when the tests leave one", () => {
    const dir = repo();
    const check = watchTree(dir, () => {});
    writeFileSync(join(dir, "m"), "");
    expect(check).toThrow(/left files[^]*\n {2}m$/);
  });
  it("passes when they leave nothing", () => {
    const dir = repo();
    expect(watchTree(dir, () => {})).not.toThrow();
  });
  it("says once that the guard is off where git cannot be read (no repository, no git, an ownership refusal), and checks nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-clean-tree-"));
    dirs.push(dir);
    const said: string[] = [];
    const check = watchTree(dir, message => said.push(message));
    writeFileSync(join(dir, "m"), "");
    expect(check).not.toThrow();
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/not checked/);
  });
});
