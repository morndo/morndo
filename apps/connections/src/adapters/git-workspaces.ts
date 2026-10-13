// The repository a path belongs to (design §6): its git common directory, which the main worktree, every linked worktree
// and every subdirectory of them share. A remote is never read: `git remote add` in a scratch folder would claim any
// repository.
// - `--path-format=absolute` makes `--git-common-dir` print an absolute, canonical path; without it, a subdirectory of the
//   main worktree gets one relative to itself, such as `../.git` (git-scm.com/docs/git-rev-parse, read 2026-10-12; git
//   2.43.0 on the build box documents and honours it).
// - Git runs without a shell and without this process's GIT_ variables: a GIT_DIR or GIT_COMMON_DIR there would answer
//   for every path, `-C` notwithstanding (git-scm.com/docs/git, "Environment Variables", read 2026-10-12; checked with
//   git 2.43.0).
// Any failure, a plain directory, a missing path or a repository git won't open, is null: the path belongs to no workspace.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { WorkspaceRoots } from "../application/ports.ts";

function withoutGitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!name.startsWith("GIT_")) out[name] = value;
  return out;
}

export class GitWorkspaceRoots implements WorkspaceRoots {
  commonDir(path: string): string | null {
    try {
      const out = execFileSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: withoutGitVariables(process.env),
      });
      return realpathSync(out.replace(/\n$/, ""));
    } catch { return null; }
  }
}
