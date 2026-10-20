// What a test run leaves in the repository (T-24, T-26). A test that writes into the directory the suite runs in, rather than its
// own temporary one, leaves an untracked file behind: for `git status` of the next person, and for another test that meets it
// (an empty `m` from a tmux negative control did both). test/clean-tree.ts reads the untracked files before a run and after it and
// fails the run on any new one. Only untracked files count: a file edited during a run is somebody's work, not a test's leak.
// Scope, so the guard is not trusted for more than it does: Vitest calls a globalSetup before the workers are created, and only if a
// test of that project is queued, and its teardown after all test files have finished (https://vitest.dev/config/globalsetup.html,
// v5.0.5, read 2026-10-20). The window is therefore the whole run, every project's tests, not the one project's. A run that queues no
// unit or browser test (`--project fleet`) is not checked. An untracked file somebody else creates in the repository during the run is
// blamed on it. Files that were untracked before the run, and empty directories, are not seen.
// `git status --porcelain -z --untracked-files=all` lists each untracked file by path, NUL-separated, "?? " first
// (https://git-scm.com/docs/git-status, read 2026-10-20). `--no-optional-locks` keeps it a pure read: plain `git status` refreshes the
// index and takes index.lock to write it, which can make a commit someone is running at the same moment fail
// (https://git-scm.com/docs/git, "--no-optional-locks"; read 2026-10-20).
import { execFileSync } from "node:child_process";

// The untracked files under `root`, relative paths; null when `root` is not in a git repository or git cannot be run.
export function untrackedFiles(root: string): string[] | null {
  try {
    const status = execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return status.split("\0").filter(entry => entry.startsWith("?? ")).map(entry => entry.slice(3));
  } catch { return null; }
}

// What is in `after` and was not in `before`; nothing when either reading is missing.
export function leftBehind(before: readonly string[] | null, after: readonly string[] | null): string[] {
  if (before === null || after === null) return [];
  const known = new Set(before);
  return after.filter(file => !known.has(file));
}

// The guard for one run: reads the untracked files under `root` now and returns the check to make after the tests, which throws,
// naming the files, if there are new ones. Where git cannot be read (no repository, git missing, a refusal over the directory's
// ownership) it says so once through `warn` and the check does nothing: a guard that is off should not look as if it passed.
export function watchTree(root: string, warn: (message: string) => void = message => { process.stderr.write(`${message}\n`); }): () => void {
  const before = untrackedFiles(root);
  if (before === null) {
    warn(`clean-tree: git could not be read in ${root} (no repository, no git, or a refusal over the directory's ownership), so this run is not checked for files the tests leave behind`);
    return () => {};
  }
  return () => {
    const left = leftBehind(before, untrackedFiles(root));
    if (left.length > 0) throw new Error(`the tests left files in the repository, in the directory they run in; they belong in a temporary one:\n  ${left.join("\n  ")}`);
  };
}
