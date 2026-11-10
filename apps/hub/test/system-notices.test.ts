// The owner, 2026-11-10: notices that machines type into a lane's pane (a Mac session's heads-up, a timer's check, a
// review note) showed in the conversation as the owner's own messages. They are the system's: the conversation hides
// them by default and shows them in verbose. The owner's own words, taps and files stay the owner's. Synthetic lines.
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/adapters/claude-sessions.ts";

const T = "2026-11-10T10:00:00.000Z";
const one = (content: string) =>
  parseLine(JSON.parse(JSON.stringify({ type: "user", uuid: "u1", timestamp: T, message: { role: "user", content }, origin: { kind: "human" } })), "manager", new Set()).entries[0];
const pasted = (body: string) => `<pasted_content id="ab12">\n${body}\n</pasted_content id="ab12">`;

describe("a notice a machine typed into the pane is the system's, not the owner's", () => {
  it("a Mac session's notice, however it opens, keeps its whole text", () => {
    for (const t of [
      "[From the owner's Mac session, on the owner's instruction.] Heads-up: a new route for the demo host.",
      "[From the owner's Mac session 2026-11-10 10:00 UTC] Notice: merged.",
      "[From the owner Mac session, demo-app] Done.",
    ]) {
      expect(one(t)).toMatchObject({ kind: "event", author: { kind: "system", name: "Mac session" }, text: t });
    }
    expect(one(pasted("[From the owner's Mac session, demo-app] Done."))).toMatchObject({ kind: "event", author: { kind: "system", name: "Mac session" } });
  });

  it("a timer's or a tool's note with a hyphenated tag is named by its tag", () => {
    expect(one("[hourly-check 10:00] Anything stuck?")).toMatchObject({ kind: "event", author: { kind: "system", name: "hourly-check" }, text: "[hourly-check 10:00] Anything stuck?" });
    expect(one("[review-done demo-app#12] Review is in.")).toMatchObject({ kind: "event", author: { kind: "system", name: "review-done" } });
    expect(one("[box-health] Disk at 91 %.")).toMatchObject({ kind: "event", author: { kind: "system", name: "box-health" } });
  });

  it("the owner's own words, taps, files, checkboxes, links and plain one-word tags stay the owner's", () => {
    for (const t of [
      "ship the demo release",
      "[tap ny-12] ship (Ship it)",
      "[The owner attached a file: /tmp/demo.png]",
      "[x] done with the list",
      "[reminder] call the venue",
      "[see the plan](https://example.com/plan) first",
    ]) {
      expect(one(t)).toMatchObject({ author: { kind: "principal", name: "You" } });
    }
  });
});
