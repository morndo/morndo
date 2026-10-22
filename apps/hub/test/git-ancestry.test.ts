// git ancestry (B11): `git merge-base --is-ancestor` read from a real checkout in a temp dir, the only ground truth of
// a merge being in a build — run out of band, with a timeout, and in a clean environment so nothing of the hub's own
// git settings can pick the repository or change the answer. The checkout is only read: its HEAD never moves, nothing
// is fetched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitAncestry, gitHasCommit, type GitRun } from "../src/adapters/git-ancestry.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-ancestry-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A hermetic git: no global or system config, a made-up author.
const git = (dir: string, args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// Three commits, one after another; their shas, oldest first.
const commits = (dir: string): string[] => {
  git(dir, ["init", "--quiet"]);
  const shas: string[] = [];
  for (let n = 1; n <= 3; n++) {
    writeFileSync(join(dir, `chapter-${n}.txt`), `chapter ${n}\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", `chapter ${n}`]);
    shas.push(git(dir, ["rev-parse", "HEAD"]));
  }
  return shas;
};
const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const OTHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("git ancestry (B11)", () => {
  it("answers from a real checkout: ancestor, not ancestor, and unknown for what it cannot know", async () => {
    const dir = tempDir();
    const [first = "", second = "", head = ""] = commits(dir);
    const ancestry = gitAncestry(dir);
    expect(await ancestry(first, second)).toBe("ancestor");                // older in newer's history
    expect(await ancestry(second, first)).toBe("not_ancestor");
    expect(await ancestry(second, second)).toBe("ancestor");               // equal counts
    expect(await ancestry(first, head)).toBe("ancestor");
    expect(await ancestry(first, "f".repeat(40))).toBe("unknown");         // a sha the checkout doesn't hold
    expect(await gitAncestry(join(dir, "not-a-repo"))(first, second)).toBe("unknown");
    expect(await gitAncestry(null)(first, second)).toBe("unknown");        // no checkout configured
    expect(await ancestry("--help", second)).toBe("unknown");              // never handed to git as an argument
    expect(await ancestry(first, "ABC1234")).toBe("unknown");
    // The checkout is only read: HEAD as it was, and no fetch happened.
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
  });

  it("a git that fails, is killed or never ran answers unknown; only 0 and 1 speak", async () => {
    const results: { code: number | null; killed: boolean }[] = [
      { code: 0, killed: false },      // ancestor
      { code: 1, killed: false },      // not an ancestor
      { code: 128, killed: false },    // a commit the checkout doesn't hold
      { code: null, killed: true },    // cut by the timeout
      { code: null, killed: false },   // no git at all (a spawn error carries no exit status)
    ];
    let n = 0;
    const ancestry = gitAncestry("/srv/checkouts/morndo", { run: async () => results[n++] ?? { code: 0, killed: false } });
    expect(await ancestry(SHA, OTHER)).toBe("ancestor");
    expect(await ancestry(SHA, OTHER)).toBe("not_ancestor");
    expect(await ancestry(SHA, OTHER)).toBe("unknown");                     // any other exit status never says yes
    expect(await ancestry(SHA, OTHER)).toBe("unknown");                     // cut by the timeout
    expect(await ancestry(SHA, OTHER)).toBe("unknown");                     // no git at all
  });

  it("git runs in a clean environment: four keys, and the repo only by -C", async () => {
    const dir = tempDir();
    commits(dir);
    const seen: { args: string[]; env: Record<string, string>; timeout: number; maxBuffer: number }[] = [];
    const run: GitRun = async (args, opts) => {
      seen.push({ args: [...args], env: { ...opts.env }, timeout: opts.timeout, maxBuffer: opts.maxBuffer });
      return { code: 0, killed: false };
    };
    const was = process.env.GIT_DIR;
    process.env.GIT_DIR = "/srv/checkouts/somewhere-else";       // none of the hub's own git settings may reach it
    process.env.GIT_WORK_TREE = "/srv/other";
    try {
      await gitAncestry(dir, { run })(SHA, OTHER);
    } finally {
      if (was === undefined) { delete process.env.GIT_DIR; delete process.env.GIT_WORK_TREE; }
      else { process.env.GIT_DIR = was; delete process.env.GIT_WORK_TREE; }
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual(["-C", dir, "merge-base", "--is-ancestor", SHA, OTHER]);
    expect(Object.keys(seen[0]?.env ?? {}).sort()).toEqual(["GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
    expect(seen[0]?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(seen[0]?.env.GIT_DIR).toBeUndefined();
    expect(seen[0]?.timeout).toBe(5000);
    expect(seen[0]?.maxBuffer).toBe(64 * 1024);
  });

  it("a stray GIT_DIR in the hub's environment never picks the repository: -C does", async () => {
    const dir = tempDir();
    const [first = "", second = ""] = commits(dir);
    const other = tempDir();                                     // a repo the stray GIT_DIR points at
    commits(other);
    const was = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const ancestry = gitAncestry(dir);
      // first is not in the other repo's history: read there, the answer would be unknown (128), not ancestor.
      expect(await ancestry(first, second)).toBe("ancestor");
      expect(await ancestry(second, first)).toBe("not_ancestor");
    } finally {
      if (was === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = was;
    }
  });
  it("gitHasCommit: a commit the checkout holds is yes, one it lacks is no, anything else is unknown", async () => {
    const dir = tempDir();
    const [first = ""] = commits(dir);
    const has = gitHasCommit(dir);
    expect(await has(first)).toBe("yes");
    expect(await has(first.slice(0, 9))).toBe("yes");                  // an abbreviation names it too
    expect(await has("a".repeat(40))).toBe("no");                     // well-formed, not in this history
    expect(await has("--help")).toBe("unknown");                      // never reaches git
    expect(await gitHasCommit(join(dir, "nowhere"))(first)).toBe("unknown");   // not a repository
    expect(await gitHasCommit(null)(first)).toBe("unknown");          // no checkout configured
  });

  it("gitHasCommit runs in the same clean environment, asking git to peel the name to a commit", async () => {
    const seen: { args: readonly string[]; env: Record<string, string> }[] = [];
    const run: GitRun = async (args, opts) => { seen.push({ args, env: opts.env }); return { code: 0, killed: false }; };
    expect(await gitHasCommit("/srv/checkouts/morndo", { run })("abc1234")).toBe("yes");
    expect(seen[0]?.args).toEqual(["-C", "/srv/checkouts/morndo", "rev-parse", "--verify", "--quiet", "abc1234^{commit}"]);
    expect(Object.keys(seen[0]?.env ?? {}).sort()).toEqual(["GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
    const code = (c: number | null, killed = false): GitRun => async () => ({ code: c, killed });
    expect(await gitHasCommit("/srv/checkouts/morndo", { run: code(1) })("abc1234")).toBe("no");
    expect(await gitHasCommit("/srv/checkouts/morndo", { run: code(128) })("abc1234")).toBe("unknown");
    expect(await gitHasCommit("/srv/checkouts/morndo", { run: code(null, true) })("abc1234")).toBe("unknown");
  });
});
