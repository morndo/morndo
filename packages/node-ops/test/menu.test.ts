// The question a menu asks (src/menu.ts; docs/design/fleet-clients/README.md §7, needs_input): kira's parseMenu and its
// pick (kira.ts:636-661, 704, read 2026-10-08), ported. Real screens: the recorded 2.1.287 captures in
// fixtures/claude-code-2.1.287 (with their colours). The multi-question form is synthetic, in the layout kira's parser
// documents (kira.ts:630-638, "verified on Claude Code 2.1.284"): no lane was waiting on a form while this was written.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { menuQuestion } from "../src/menu.ts";

const screen = (name: string) => readFileSync(join(import.meta.dirname, "fixtures/claude-code-2.1.287", `${name}.ansi`), "utf8");
const FORM = [
  "  Shall I go on?",
  "",
  " ←  ☐ Branch  ☐ Tests  ✔ Submit  →",
  "",
  " Pick the branch for the fix",
  "",
  " ❯ 1. main",
  "      The default branch",
  "   2. release/1.2",
  "      The maintenance branch",
  "   3. Type something.",
  "",
  " Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

describe("menuQuestion (kira's rule)", () => {
  it("a permission prompt: the line ending in ? above the options (recorded, with colours)", () => {
    expect(menuQuestion(screen("permission-prompt"))).toBe("Do you want to proceed?");
  });
  it("a menu without a question mark: the last line above the options (recorded /model menu)", () => {
    expect(menuQuestion(screen("real-menu-model")))
      .toBe("Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.");
  });
  it("no numbered options (the trust dialog, recorded, with hyperlinks): the screen's last line, as kira emits it", () => {
    expect(menuQuestion(screen("trust-dialog"))).toBe("Enter to confirm · Esc to cancel");
  });
  it("a multi-question form: only the lines below its tab strip, never prose above it (negative control)", () => {
    expect(menuQuestion(FORM)).toBe("Pick the branch for the fix");
  });
  it("the last line ending in ? wins over the lines below it (negative control)", () => {
    expect(menuQuestion(" Shall I merge it now?\n It needs one more review.\n ❯ 1. Yes\n   2. No")).toBe("Shall I merge it now?");
  });
  it("a numbered list in the reply above a menu is not the menu's question", () => {
    const shown = ["Here is the plan:", "1. write the tests", "2. ship it", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(menuQuestion(shown)).toBe("Do you want to proceed?");
  });
  it("only the 10 lines above the first option count", () => {
    const far = [" Is this too far up?", ...Array.from({ length: 10 }, (_, i) => ` line ${i}`), " ❯ 1. Yes", "   2. No"].join("\n");
    expect(menuQuestion(far)).toBe("line 9");
  });
  it("at most 200 characters, never half of one", () => {
    const q = `${"x".repeat(199)}😀 and more?`;
    expect(menuQuestion(` ${q}\n ❯ 1. Yes`)).toBe(`${"x".repeat(199)}😀`);
  });
  it("nothing on screen: null", () => {
    expect(menuQuestion("")).toBeNull();
    expect(menuQuestion("\n\n   \n")).toBeNull();
  });
});
