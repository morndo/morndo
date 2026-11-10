// Who an avatar shows (the owner, 2026-11-10: in the chat it was hard to tell his own messages from the manager's).
// The manager wears the Morndo mark wherever it appears; everyone else keeps a look of their own.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { avatarLook, MARK_PATH } from "../src/lib/avatar-look.ts";

describe("who an avatar shows", () => {
  it("the manager wears the Morndo mark, however a view names or files it", () => {
    expect(avatarLook("Manager", "peer")).toBe("manager");
    expect(avatarLook("manager", "peer")).toBe("manager");
    expect(avatarLook("manager", "agent")).toBe("manager");
  });

  it("the principal, a lane, another lane writing in and the system keep their own looks", () => {
    expect(avatarLook("You", "principal")).toBe("principal");
    expect(avatarLook("search", "agent")).toBe("agent");
    expect(avatarLook("alpha", "peer")).toBe("peer");
    expect(avatarLook("board", "system")).toBe("system");
  });

  it("the mark is the brand kit's own, not a copy that drifted", () => {
    const svg = readFileSync(new URL("../../../packages/brand/assets/mark/morndo-mark-currentcolor.svg", import.meta.url), "utf8");
    expect(svg).toContain(`d="${MARK_PATH}"`);
  });
});
