// More real Claude Code 2.1.287 screens (captured 2026-10-01 from a throwaway session in a private tmux server, default
// permission mode): the folder-trust dialog, a Bash permission prompt, the box after that prompt was cancelled, and the
// shell after /exit. A dialog replaces the input box, so the hub must see it as a menu and type nothing; after /exit
// Claude Code clears its frame, so no stale box is left for the hub to type into.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draftOnScreen, inputBoxOnScreen, menuOnScreen } from "../src/tmux.ts";

const SGR = /\x1b\[[0-9;]*m/g;
const screen = (name: string) => {
  const lines = readFileSync(join(import.meta.dirname, "fixtures/claude-code-2.1.287", `${name}.ansi`), "utf8").split("\n");
  while (lines.length && !lines.at(-1)?.replace(SGR, "").trim()) lines.pop();   // as the adapter's own capture does
  return lines.join("\n");
};

describe("real Claude Code dialogs and exit", () => {
  it.each([
    // name, menu open, input box
    ["trust-dialog", true, false],
    ["permission-prompt", true, false],                             // "❯ 1. Yes" is a choice, the "❯ Use the Bash tool…" above is history
    ["permission-cancelled", false, true],
    ["exited-to-shell", false, false],                              // a send here is refused as no_input_box
  ])("%s: menu %s, input box %s", (name, menu, box) => {
    const s = screen(name);
    expect(menuOnScreen(s)).toBe(menu);
    expect(inputBoxOnScreen(s)).toBe(box);
  });

  // The draft is read only once no menu is open and a box is on screen (tmux.ts send), so only those screens matter here.
  it.each(["permission-cancelled", "exited-to-shell"])("%s: no draft", name => {
    expect(draftOnScreen(screen(name))).toBeNull();
  });
});
