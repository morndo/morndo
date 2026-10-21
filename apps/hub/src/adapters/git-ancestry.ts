// Whether one commit is in another's history, read from a local Morndo checkout the operator keeps current (B11):
// `git merge-base --is-ancestor`, which "exits with status 0 if true, or with status 1 if not. Errors are signaled by a
// non-zero status that is not 1" (https://git-scm.com/docs/git-merge-base, read 2026-10-21). Everything else — a commit
// the checkout doesn't hold (128), a path that isn't a repository, no git, a signal, a timeout — is "unknown": never a
// yes. No fetch, no network: the checkout is what the operator last made it.
import { spawnSync } from "node:child_process";
import type { AncestryAnswer } from "@morndo/domain";

const COMMIT = /^[0-9a-f]{7,40}$/;

export function gitAncestry(repo: string | null): (merge: string, build: string) => AncestryAnswer {
  if (repo === null) return () => "unknown";
  return (merge, build) => {
    // Both come from outside; each must be a commit name, so neither can start an option of its own.
    if (!COMMIT.test(merge) || !COMMIT.test(build)) return "unknown";
    const r = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", merge, build],
      { timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.status === 0) return "ancestor";
    if (r.status === 1) return "not_ancestor";
    return "unknown";
  };
}
