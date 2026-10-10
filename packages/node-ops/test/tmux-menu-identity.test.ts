// A menu's identity (ADR-0008 phase C, S6): the same menu gives the same digest; a different menu, or the highlight
// moved to another choice, gives another; prose above the input box and colours don't count; no menu gives null.
import { describe, expect, it } from "vitest";
import { menuIdentity } from "../src/tmux.ts";

const menu = (choice: 1 | 2, title = "Do you want to proceed?") => [
  "Some agent output above", "", title,
  `${choice === 1 ? "❯" : " "} 1. Yes`, `${choice === 2 ? "❯" : " "} 2. No, and tell Claude what to do differently`,
  "", "Esc to cancel",
].join("\n");

describe("menuIdentity", () => {
  it("is null without a menu", () => {
    expect(menuIdentity("──────\n❯ ")).toBeNull();
  });
  it("is stable for the same menu, colours aside", () => {
    expect(menuIdentity(menu(1))).toMatch(/^[0-9a-f]{16}$/);
    expect(menuIdentity(menu(1).replace("Yes", "\x1b[1mYes\x1b[0m"))).toBe(menuIdentity(menu(1)));
  });
  it("changes with another menu or another highlighted choice", () => {
    expect(menuIdentity(menu(1, "Allow this edit?"))).not.toBe(menuIdentity(menu(1)));
    expect(menuIdentity(menu(2))).not.toBe(menuIdentity(menu(1)));
  });
  it("covers only the menu: output or a status line above it that keeps changing doesn't change it (review L2)", () => {
    const withAbove = (line: string) => menu(1).replace("Some agent output above", line);
    expect(menuIdentity(withAbove("✻ Thinking… (3s · 120 tokens)"))).toBe(menuIdentity(withAbove("✻ Thinking… (9s · 480 tokens)")));
  });
});
