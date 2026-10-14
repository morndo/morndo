// Which window a hook came from (fleet core §5.5; fleet clients spec §6): TMUX_PANE first, then the session registry,
// and only when neither finds one the body's own `window` (the owner's Stop script and `lanes notify` send it), a
// window name or nothing.
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@morndo/node-ops";
import { windowResolver } from "../src/relay/window-of.ts";

const resolve = windowResolver({ windowOfPane: p => (p === "%3" ? "api lane" : null), sessions: () => new Map<string, SessionInfo>() });

describe("the window of a hook", () => {
  it("takes the body's window when neither the pane nor the session finds one", () => {
    expect(resolve({ window: "web", text: "a note from outside a pane" })).toBe("web");            // negative control: null
    expect(resolve({ window: "fix: a/b ü.2", session_id: "not-in-the-registry" })).toBe("fix: a/b ü.2");
  });

  it("prefers the pane it finds over the body's window", () => {
    expect(resolve({ TMUX_PANE: "%3", window: "web" })).toBe("api lane");
  });

  it("takes no body window that isn't a window name, and none when there is none", () => {
    for (const window of ["", "a\tb", "x".repeat(201), 7, null]) expect(resolve({ window }), JSON.stringify(window)).toBeNull();
    expect(resolve({ text: "x" })).toBeNull();
    expect(resolve("plain words")).toBeNull();
  });
});
