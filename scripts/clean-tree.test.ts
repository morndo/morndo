// A test run must leave the repository as it found it (T-24, T-26): a unit test that writes into the directory the suite runs
// in, instead of its own temporary one, leaves a stray file for the next person's `git status` and can fail another test that
// meets it (an empty `m` from a tmux control did both). clean-tree.ts reads the untracked files before a run and after it.
// Here against real git repositories in temporary directories.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { leftBehind, untrackedFiles } from "./clean-tree.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-clean-tree-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@users.noreply.github.com", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(dir, "kept"), "tracked\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.log\n");
  git("add", "kept", ".gitignore");
  git("commit", "-q", "-m", "init");
  return dir;
}

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
