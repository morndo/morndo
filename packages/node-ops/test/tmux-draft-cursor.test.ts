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
    expect(draftOnScreen(box(`hal${E}[7ml${E}[27mo`))).toBe("hallo");
  });
  it("reads a one-character draft when the cursor sits on it", () => {
    expect(draftOnScreen(box(`${E}[7my${E}[0m`))).toBe("y");
  });
  it("keeps a reverse-video chip instead of dropping it", () => {
    expect(draftOnScreen(box(`${E}[7m[Pasted text #1]${E}[0m`))).toBe("[Pasted text #1]");
  });
  it("keeps a reverse-video selection inside a draft", () => {
    expect(draftOnScreen(box(`ab${E}[7mcd${E}[27mef`))).toBe("abcdef");
  });
});

// Colour numbers inside 38/48/58 are palette or RGB components (xterm ctlseqs, ISO-8613-6; underline colour 58
// follows the same shape). They must not be read as SGR 2/22 or 7/27.
describe("SGR colour arguments never toggle dim or reverse", () => {
  it.each([
    ["foreground 256-colour 7", `${E}[38;5;7mT${E}[0;2mry "note"`, "T"],
    ["background 256-colour 7", `${E}[48;5;7mT${E}[0;2mry "note"`, "T"],
    ["underline 256-colour 7", `${E}[58;5;7mT${E}[0;2mry "note"`, "T"],
    ["foreground 256-colour 2", `${E}[38;5;2mhallo`, "hallo"],
    ["background 256-colour 2", `${E}[48;5;2mhallo`, "hallo"],
    ["underline 256-colour 2", `${E}[58;5;2mhallo`, "hallo"],
    ["truecolor selector 2", `${E}[38;2;200;200;200mhallo`, "hallo"],
    ["truecolor red component 7", `${E}[38;2;7;8;9mT${E}[0;2mry "note"`, "T"],
    ["truecolor red component 2", `${E}[38;2;2;3;4mhallo`, "hallo"],
    ["background truecolor", `${E}[48;2;7;8;9mhallo`, "hallo"],
    ["underline truecolor", `${E}[58;2;7;8;9mhallo`, "hallo"],
    ["256-colour 22 does not clear dim", `${E}[2;38;5;22mhidden words`, null],
    ["256-colour 27 does not clear reverse", `${E}[7;38;5;27mT${E}[0;2mry "note"`, null],
    ["background 27 does not clear reverse", `${E}[7;48;5;27mT${E}[0;2mry "note"`, null],
    ["underline 22 does not clear dim", `${E}[2;58;5;22mhidden words`, null],
    ["truecolor 22 does not clear dim", `${E}[2;38;2;22;22;22mhidden words`, null],
    ["dim still applies after a colour", `${E}[38;5;244;2mhidden words`, null],
    ["22 after a colour still clears dim", `${E}[2;38;5;244;22mhallo`, "hallo"],
  ])("%s", (_name, line, want) => {
    expect(draftOnScreen(box(line))).toBe(want);
  });
});
