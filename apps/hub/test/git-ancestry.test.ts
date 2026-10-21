// git ancestry (B11): `git merge-base --is-ancestor` read from a real checkout in a temp dir, the only ground truth of
// a merge being in a build. The checkout is only read: its HEAD never moves, nothing is fetched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitAncestry } from "../src/adapters/git-ancestry.ts";

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

describe("git ancestry (B11)", () => {
  it("answers from a real checkout: ancestor, not ancestor, and unknown for what it cannot know", () => {
    const dir = tempDir();
    const [first = "", second = "", head = ""] = commits(dir);
    const ancestry = gitAncestry(dir);
    expect(ancestry(first, second)).toBe("ancestor");                    // older in newer's history
    expect(ancestry(second, first)).toBe("not_ancestor");
    expect(ancestry(second, second)).toBe("ancestor");                   // equal counts
    expect(ancestry(first, head)).toBe("ancestor");
    expect(ancestry(first, "f".repeat(40))).toBe("unknown");             // a sha the checkout doesn't hold
    expect(gitAncestry(join(dir, "not-a-repo"))(first, second)).toBe("unknown");
    expect(gitAncestry(null)(first, second)).toBe("unknown");            // no checkout configured
    expect(ancestry("--help", second)).toBe("unknown");                  // never handed to git as an argument
    expect(ancestry(first, "ABC1234")).toBe("unknown");
    // The checkout is only read: HEAD as it was, and no fetch happened.
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(dir, ".git", "FETCH_HEAD"))).toBe(false);
  });
});
