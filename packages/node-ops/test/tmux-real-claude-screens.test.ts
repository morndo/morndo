// Real Claude Code 2.1.287 screens, captured on 2026-10-01 with `tmux capture-pane -p -e -S -30` from lanes on this box
// (focus-events off, as the hub sees them). They hold the input-box, draft and menu checks to the real rendering rather
// than a stand-in: the empty box's dim placeholder, the dim suggestion after a turn, typed drafts, a past prompt in the
// history above the box, and a real menu, which replaces the box.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as tmux from "../src/tmux.ts";

const SGR = /\x1b\[[0-9;]*m/g;
const screen = (name: string) => {
  const lines = readFileSync(join(import.meta.dirname, "fixtures/claude-code-2.1.287", `${name}.ansi`), "utf8").split("\n");
  while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();   // as the adapter's own capture does
  return lines.join("\n");
};
const inputBoxOnScreen = (tmux as unknown as Record<string, unknown>).inputBoxOnScreen as ((s: string) => boolean) | undefined;

describe("real Claude Code screens", () => {
  it.each([
    ["fresh-placeholder", null],
    ["cleared", null],
    ["after-turn-ghost-suggestion", null],
    ["after-menu-escape", null],                                   // the past "/model" prompt above the box is history
    ["typed-draft", "please check the build"],
    ["typed-try-draft", 'Try "the build" first'],                  // typed, not dim: a draft, though it starts like the placeholder
  ])("%s: the draft is %j", (name, want) => {
    expect(tmux.draftOnScreen(screen(name))).toBe(want);
  });

  it.each([
    ["fresh-placeholder", false],
    ["after-turn-ghost-suggestion", false],
    ["after-menu-escape", false],
    ["typed-draft", false],
    ["real-menu-model", true],
  ])("%s: a menu is open: %s", (name, want) => {
    expect(tmux.menuOnScreen(screen(name))).toBe(want);
  });

  it.each([
    ["fresh-placeholder", true],
    ["cleared", true],
    ["after-turn-ghost-suggestion", true],
    ["after-menu-escape", true],
    ["typed-draft", true],
    ["typed-try-draft", true],
    ["real-menu-model", false],                                    // a menu replaces the input box
  ])("%s: an input box is on screen: %s", (name, want) => {
    expect(inputBoxOnScreen, "tmux.ts exports inputBoxOnScreen(screen: string): boolean").toBeTypeOf("function");
    expect(inputBoxOnScreen!(screen(name))).toBe(want);
  });
});
