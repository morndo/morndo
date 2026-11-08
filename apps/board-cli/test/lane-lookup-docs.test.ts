// A lane's name comes from tmux asked about its own pane (`-t "$TMUX_PANE"`) and accepted only when tmux answers with that pane's id:
// a target tmux cannot find is answered with the window on screen, which is the manager's when it is in front. No tracked page,
// script or source may ask for the window name without both (T-897).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ASKS_NAME = /#W|#\{window_name\}|"window_name"/;

function tracked(): string[] {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  expect(listed.status, "git ls-files").toBe(0);
  return listed.stdout.split("\0").filter(f => f !== "" && /\.(md|sh|ts|json|ya?ml|service)$/.test(f) && !/(^|\/)(test|node_modules)\//.test(f) && !f.endsWith(".test.ts") && !f.endsWith("package-lock.json"));
}

// The command lines, and (in .ts) the array-form calls, that ask tmux for a window's name.
function lookups(file: string, text: string): { at: string; line: string; array: boolean }[] {
  const found: { at: string; line: string; array: boolean }[] = [];
  text.split("\n").forEach((line, i) => {
    if (/tmux\s+display-message\b/.test(line) && ASKS_NAME.test(line)) found.push({ at: `${file}:${i + 1}`, line, array: false });
    if (file.endsWith(".ts") && /"display-message"/.test(line) && ASKS_NAME.test(line)) found.push({ at: `${file}:${i + 1}`, line, array: true });
  });
  return found;
}

describe("no page, script or source asks tmux for a window name it cannot vouch for", () => {
  it("every lookup of the window name has a -t target and checks the pane id it gets back", () => {
    const files = tracked();
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const { at, line, array } of lookups(file, readFileSync(join(ROOT, file), "utf8"))) {
        seen += 1;
        const target = array ? /"-t"/.test(line) : /tmux\s+display-message[^|;&)]*\s-t\s/.test(line);
        if (!target || !/pane_id/.test(line)) bad.push(at);
      }
    }
    expect(seen, "the lookups this test is about (usage.md and agent-settings.ts at least)").toBeGreaterThanOrEqual(2);
    expect(bad).toEqual([]);
  });

  it("the scan sees a bare lookup in either form", () => {
    expect(lookups("a.md", "x=$(tmux display-message -p '#W')")).toHaveLength(1);
    expect(lookups("a.ts", 'tmux(["display-message", "-p", "-t", pane, "#{window_name}"])')).toEqual([expect.objectContaining({ array: true })]);
    expect(lookups("a.ts", 'tmux(["display-message", "-p", "-t", pane, "#{pane_current_command}"])')).toEqual([]);
  });
});
