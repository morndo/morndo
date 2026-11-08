// A lane's name comes from tmux asked about its own pane (`-t "$TMUX_PANE"`), never from the window on screen: that is the
// manager's when it is in front. No tracked page or script may tell a lane to ask for the window name without a target (T-897).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("no page or script asks tmux for the window on screen", () => {
  it("every `tmux display-message` command line that asks for the window name has a -t target", () => {
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    expect(listed.status, "git ls-files").toBe(0);
    const files = listed.stdout.split("\0").filter(f => f !== "" && /\.(md|sh|ts|json|ya?ml|service)$/.test(f) && !/(^|\/)(test|node_modules)\//.test(f) && !f.endsWith(".test.ts") && !f.endsWith("package-lock.json"));
    const bare: string[] = [];
    for (const file of files) {
      readFileSync(join(ROOT, file), "utf8").split("\n").forEach((line, i) => {
        if (/tmux\s+display-message\b/.test(line) && /#W|#\{window_name\}/.test(line) && !/tmux\s+display-message[^|;&)]*\s-t\s/.test(line)) bare.push(`${file}:${i + 1}`);
      });
    }
    expect(files.length).toBeGreaterThan(100);
    expect(bare).toEqual([]);
  });
});
