// Claude Code 2.1.296, captured 2026-10-11 with `tmux capture-pane -p -e -S -30` from a throwaway session.
// The cursor sits on the last character of a typed draft and is drawn reverse-video (SGR 7). The draft is made-up text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as tmux from "../src/tmux.ts";

const SGR = /\x1b\[[0-9;]*m/g;
const lines = readFileSync(join(import.meta.dirname, "fixtures/claude-code-2.1.296/cursor-inside.ansi"), "utf8").split("\n");
while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();   // as the adapter's own capture does
const screen = lines.join("\n");

describe("a captured Claude Code 2.1.296 screen", () => {
  it("draws the cursor in reverse video on the draft's last character", () => {
    expect(screen).toContain("\x1b[7ms\x1b[0m");
    expect(tmux.draftOnScreen(screen)).toBe("hold the notes");
    expect(tmux.menuOnScreen(screen)).toBe(false);
    expect(tmux.inputBoxOnScreen(screen)).toBe(true);
  });
});
