// Claude Code 2.1.296 draws the cursor in reverse video (SGR 7) on the first character of the dim placeholder or
// suggestion, so that character is not dim. Seen on 2026-10-11: every send to a fresh lane was refused draft_present.
import { describe, expect, it } from "vitest";
import { draftOnScreen } from "../src/tmux.ts";

const E = "\x1b";
const box = (line: string) => `${E}[38;5;244m────${E}[39m\n${E}[39m❯ ${line}\n${E}[38;5;244m────${E}[39m`;

describe("draftOnScreen with a reverse-video cursor", () => {
  it("reads the placeholder with the cursor on its first character as empty", () => {
    expect(draftOnScreen(box(`${E}[7mT${E}[0;2mry "how does <filepath> work?"${E}[0m`))).toBeNull();
  });
  it("reads a suggestion with the cursor on its first character as empty", () => {
    expect(draftOnScreen(box(`${E}[7mO${E}[0;2mption 2, über GitHub${E}[0m`))).toBeNull();
  });
  it("still reads a typed draft, cursor at its end", () => {
    expect(draftOnScreen(box(`hallo welt${E}[7m ${E}[0m`))).toBe("hallo welt");
  });
  it("still reads a typed draft, cursor inside it", () => {
    expect(draftOnScreen(box(`hal${E}[7ml${E}[27mo`))).toBe("halo");
  });
});
