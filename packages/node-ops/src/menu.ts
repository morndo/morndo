// The question a menu on screen asks, for the lane event `needs_input` (docs/design/fleet-clients/README.md §7): kira's
// rule, ported from the chat bot's parseMenu (read 2026-10-08; kira wrote it against Claude Code 2.1.284's menus, and its
// emit at kira.ts:704 picks the question). Of the screen's last 45 lines:
// - the question lines run from below a multi-question form's tab strip ("←  ☐ Branch  ✔ Submit  →"), else from 10 lines
//   above the last numbered list ("1.": a list in the reply above the menu is not the menu), down to that option;
//   box-drawing characters are dropped, blank lines too, and the last 6 are kept;
// - the question is the last of them that ends in "?", else the last of them, at most 200 characters.
// A screen with colours or hyperlinks is read without them (kira reads a plain capture; a node may hand this either).
const SGR = /\x1b\[[0-9;]*m/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TAB_STRIP = /^\s*←.*→\s*$/;
const OPTION = /^\s*(?:[❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const BOX = /[│╭╮╰╯─━┃]/g;

export function menuQuestion(screen: string): string | null {
  // kira reads a capture without its trailing blank lines (paneText, kira.ts:346-347), then its last 45 lines.
  const lines = screen.replace(OSC, "").replace(SGR, "").replace(/\s+$/, "").split("\n").slice(-45).map(l => l.replace(/\s+$/, ""));
  let tabAt = -1;
  lines.forEach((l, i) => { if (TAB_STRIP.test(l)) tabAt = i; });
  // The last option "1." below the tab strip: the menu at the bottom, not a numbered list in the reply above it.
  let firstOptAt = lines.length;
  for (let i = lines.length - 1; i > tabAt; i--) {
    if (Number(OPTION.exec(lines[i] ?? "")?.[1]) === 1) { firstOptAt = i; break; }
  }
  const question = lines.slice(tabAt >= 0 ? tabAt + 1 : Math.max(0, firstOptAt - 10), firstOptAt)
    .map(l => l.replace(BOX, "").trim()).filter(Boolean).slice(-6);
  const q = [...question].reverse().find(l => /\?\s*$/.test(l)) ?? question.at(-1) ?? "";
  return q ? Array.from(q).slice(0, 200).join("") : null;                     // 200 characters, never half of one
}
