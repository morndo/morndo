// The timeline's scroll rules (ADR-0008 phase D), pure and exhaustive (design reference: Signal-Desktop
// ts/util/timelineUtil.std.ts): where to scroll after each kind of change, where the "New messages" divider goes, and
// when the jump-to-latest button shows.
import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { dividerBefore, scrollAnchor, showJump } from "../src/lib/desktop/timeline.ts";

const msg = (id: string, at: number, kind: "principal" | "agent" = "agent"): Message =>
  ({ id, at, author: { kind, name: kind === "principal" ? "You" : "builder" }, kind: "text", text: id });

describe("scrollAnchor", () => {
  it("still loading: nothing", () => {
    expect(scrollAnchor({ kind: "loading" })).toEqual({ kind: "none" });
  });
  it("opened: to the divider if there is one, else to the bottom", () => {
    expect(scrollAnchor({ kind: "opened", divider: "m3" })).toEqual({ kind: "message", id: "m3", block: "start" });
    expect(scrollAnchor({ kind: "opened", divider: null })).toEqual({ kind: "bottom" });
  });
  it("a message asked for (Show in chat) wins", () => {
    expect(scrollAnchor({ kind: "focus", id: "m9" })).toEqual({ kind: "message", id: "m9", block: "center" });
  });
  it("older messages loaded above: the first message on screen stays where it was (review M4)", () => {
    expect(scrollAnchor({ kind: "older" })).toEqual({ kind: "keep-in-place" });
  });
  it("new messages: follow them at the bottom, else stay put", () => {
    expect(scrollAnchor({ kind: "newer", atBottom: true })).toEqual({ kind: "bottom" });
    expect(scrollAnchor({ kind: "newer", atBottom: false })).toEqual({ kind: "none" });
  });
  it("the principal's own message: to the bottom wherever he was", () => {
    expect(scrollAnchor({ kind: "own" })).toEqual({ kind: "bottom" });
  });
});

describe("dividerBefore", () => {
  const ms = [msg("m1", 100), msg("m2", 200), msg("m3", 300, "principal"), msg("m4", 400)];
  it("the first message after the read mark that isn't the principal's own", () => {
    expect(dividerBefore(ms, 150)).toBe("m2");
    expect(dividerBefore(ms, 250)).toBe("m4");                            // m3 is his own: not new to him
  });
  it("none when everything is read, or nothing was ever marked", () => {
    expect(dividerBefore(ms, 400)).toBeNull();
    expect(dividerBefore(ms, null)).toBeNull();
    expect(dividerBefore([], 0)).toBeNull();
  });
});

describe("showJump", () => {
  it("shows when more than one screen above the bottom", () => {
    expect(showJump({ scrollHeight: 5000, scrollTop: 3000, clientHeight: 900 })).toBe(true);   // 1100 from the bottom
    expect(showJump({ scrollHeight: 5000, scrollTop: 3200, clientHeight: 900 })).toBe(false);  // 900: exactly one screen
  });
});
