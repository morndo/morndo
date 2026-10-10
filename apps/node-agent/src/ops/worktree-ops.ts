// worktree.list and worktree.add (spec §5.3): git worktrees of repositories under the policy's repoRoots, and new ones
// beside the repository at <repo>-worktrees/<name>, also under a root (git-worktree(1): `worktree list --porcelain -z`,
// `worktree add -b <branch> <path> <commit-ish>`; https://git-scm.com/docs/git-worktree, read 2026-10-06). A branch
// name may hold "/" (fix/login, a worktree at <repo>-worktrees/fix/login). OP_ARGS already refused what can't be one;
// git itself has the last word (`git check-ref-format --branch`, https://git-scm.com/docs/git-check-ref-format, read
// 2026-10-06), behind OP_ARGS' rules, which already refuse every name git refuses that was tried.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { deniedBy, denyConfigFromEnv, denyRoots, resolvedRoots } from "@morndo/node-ops";
import { effect, fail, ok, read, type OpTable } from "./executor.ts";

const run = promisify(execFile);
const git = (repo: string, args: string[]) =>
  run("git", ["-C", repo, ...args], { timeout: 30_000, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Whether git takes `name` as a branch name: the node's own last word on it.
export async function branchNameOk(name: string): Promise<boolean> {
  try { await run("git", ["check-ref-format", "--branch", name], { timeout: 10_000 }); return true; }
  catch { return false; }
}

export function worktreePath(repo: string, name: string): string {
  return join(dirname(repo), `${basename(repo)}-worktrees`, name);
}

// `git worktree list --porcelain -z`: NUL-terminated lines, an empty line between worktrees.
export function parsePorcelain(out: string): { path: string; branch: string | null }[] {
  const trees: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\0")) {
    if (line === "") { if (cur) trees.push(cur); cur = null; continue; }
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: null };
    else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
  }
  if (cur) trees.push(cur);
  return trees;
}

export function worktreeOps(d: { repoRoots: string[]; home: string; stateDir: string }): Pick<OpTable, "worktree.list" | "worktree.add"> {
  const roots = () => d.repoRoots.flatMap(r => { try { return [realpathSync(r)]; } catch { return []; } });
  // The deny roots lane.start and file.* apply, resolved at each call (a HOME behind a symbolic link is still caught).
  const deny = () => resolvedRoots(denyRoots(d.home, d.stateDir, denyConfigFromEnv(process.env)));
  const confinedRepo = (repo: string): string | null => {
    try {
      const real = realpathSync(repo);
      return statSync(real).isDirectory() && roots().some(r => under(real, r)) && !deniedBy(real, deny()) ? real : null;
    } catch {
      return null;
    }
  };
  return {
    "worktree.list": read(async a => {
      const repo = confinedRepo(a.repo);
      if (!repo) return fail("denied", "that repository is not under this node's repoRoots");
      try { return ok<"worktree.list">({ worktrees: parsePorcelain((await git(repo, ["worktree", "list", "--porcelain", "-z"])).stdout) }); }
      catch { return fail("bad_args", "that directory is not a git repository"); }
    }),
    "worktree.add": effect(a => `repo:${a.repo}`, async (a, ctx) => {
      const repo = confinedRepo(a.repo);
      if (!repo) return fail("denied", "that repository is not under this node's repoRoots");
      const path = worktreePath(repo, a.name);
      if (!roots().some(r => under(path, r)) || deniedBy(path, deny())) return fail("denied", "the new worktree would not be under this node's repoRoots");
      if (!(await branchNameOk(a.name))) return fail("bad_args", "git does not take that as a branch name");
      if (existsSync(path)) return fail("name_taken", "a worktree of that name exists");
      try { await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${a.name}`]); return fail("name_taken", "a branch of that name exists"); }
      catch { /* no such branch: good */ }
      try { await git(repo, ["rev-parse", "--verify", "--quiet", `${a.base}^{commit}`]); }
      catch { return fail("bad_args", "no commit of that name in the repository"); }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      mkdirSync(dirname(path), { recursive: true });
      await git(repo, ["worktree", "add", "-b", a.name, path, a.base]);
      return ok<"worktree.add">({ path });
    }),
  };
}
