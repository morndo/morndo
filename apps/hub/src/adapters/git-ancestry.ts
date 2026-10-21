// Whether one commit is in another's history, read from a local Morndo checkout the operator keeps current (B11):
// `git merge-base --is-ancestor`, which "exits with status 0 if true, or with status 1 if not. Errors are signaled by a
// non-zero status that is not 1" (https://git-scm.com/docs/git-merge-base, read 2026-10-21). Everything else — a commit
// the checkout doesn't hold (128), a path that isn't a repository, no git, a signal, a timeout — is "unknown": never a
// yes. No fetch, no network: the checkout is what the operator last made it. The answer comes as a promise: a board
// action never waits for git, the liveness cache's queue worker does.
import { execFile } from "node:child_process";
import type { AncestryAnswer } from "@morndo/domain";

const COMMIT = /^[0-9a-f]{7,40}$/;

// One git run, as the adapter sees it: the exit status — null when there is none (no git, a signal, the timeout cut
// it) — and whether it was killed. The default runs git; a test may pass its own.
export type GitRun = (args: readonly string[], opts: { env: Record<string, string>; timeout: number; maxBuffer: number }) =>
  Promise<{ code: number | null; killed: boolean }>;

// Only what git needs to find itself and a home: nothing of the hub's own git settings (GIT_DIR, work trees, aliases
// through the environment) may reach it and pick the repository or change the answer. The repo is chosen by -C alone.
const env = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  LANG: process.env.LANG ?? "C",
  GIT_TERMINAL_PROMPT: "0",
});

const runGit: GitRun = (args, opts) => new Promise(resolve => {
  execFile("git", args, opts, error => {
    // error is null exactly on exit 0; error.code is the exit status on any other exit, and a spawn error (no git)
    // carries no number — killed (the timeout) among them.
    if (error === null) resolve({ code: 0, killed: false });
    else resolve({ code: typeof error.code === "number" ? error.code : null, killed: error.killed === true });
  });
});

export function gitAncestry(repo: string | null, o: { run?: GitRun; timeoutMs?: number } = {}):
  (merge: string, build: string) => Promise<AncestryAnswer> {
  if (repo === null) return () => Promise.resolve("unknown");   // no checkout configured
  const doRun = o.run ?? runGit;
  return (merge, build) => {
    // Both come from outside; each must be a commit name, so neither can start an option of its own.
    if (!COMMIT.test(merge) || !COMMIT.test(build)) return Promise.resolve("unknown");
    return doRun(["-C", repo, "merge-base", "--is-ancestor", merge, build],
      { env: env(), timeout: o.timeoutMs ?? 5000, maxBuffer: 64 * 1024 })
      .then(r => (r.code === 0 ? "ancestor" : r.code === 1 ? "not_ancestor" : "unknown"));
  };
}
