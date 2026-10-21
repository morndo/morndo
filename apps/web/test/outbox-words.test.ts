// One wording for a Command in the outbox, on the desktop and on the phone's update card (review of PR #7, finding 12).
import { describe, expect, it } from "vitest";
import { SEND_REFUSALS } from "../../hub/src/application/ports.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { heldBehind, sendLabel, sendReason } from "../src/lib/outbox/words.ts";

const rec = (id: string, o: Partial<OutboxRecord> = {}): OutboxRecord => ({
  id, worker: "%1", workerName: "builder", text: "go", uploads: [], createdAt: 1000, budgetFrom: 1000, state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, typedAt: null, ...o,
});

describe("outbox words", () => {
  it("says why the hub refused, in words, never its code; where to look follows the screen it is on", () => {
    const menu = rec("a", { state: "failed", error: "menu_open" });
    expect(sendReason(menu, "builder")).toBe("builder is showing a menu. Answer it in the Terminal tab first.");
    expect(sendReason(menu, "builder", "its screen in Agents")).toBe("builder is showing a menu. Answer it in its screen in Agents first.");
    for (const code of ["no_pane", "busy", "draft_present", "no_input_box", "not_submitted", "too_long", "stale", "step_up", "timeout", "uncertain", "too_large", "node_offline"]) {
      expect(sendReason(rec("x", { state: "failed", error: code }), "builder")).not.toContain(code);
    }
    expect(sendReason(rec("x", { state: "failed", error: "too_long" }), "builder")).toContain("100,000 characters at most");
    expect(sendReason(rec("x", { state: "failed", error: "unknown_op" }), "builder")).toContain("at most 8,000 characters");
  });
  it("a send the node or the fleet refused saying nothing ran (the hub's SEND_REFUSALS) says why in words, and that nothing was typed", () => {
    for (const code of SEND_REFUSALS) {
      const why = sendReason(rec("x", { state: "failed", error: code }), "builder");
      expect(why, code).toMatch(/^builder .*nothing was typed/);
      expect(why, code).not.toContain(code);
    }
    expect(sendReason(rec("x", { state: "failed", error: "bad_args" }), "builder")).toBe("builder couldn't be reached: the fleet refused the message as malformed, so nothing was typed. If its window name has a tab or another control character in it, rename the window, then try again.");
    const refused = sendReason(rec("x", { state: "failed", error: "not_allowed" }), "builder");
    expect(refused).toMatch(/isn't an allowed attachment/);
    expect(refused).not.toMatch(/no longer running/);
  });
  it("an Uncertain send says it may have gone, and what Check again does (fleet core §7)", () => {
    const r = rec("u", { state: "uncertain", error: "uncertain" });
    expect(sendLabel(r, [r], 2000)).toBe("May have been sent");
    expect(sendReason(r, "builder")).toBe("May have been sent. Check again asks whether it was typed; if that can't be known, it stays here, so look at the worker's screen before sending it again.");
    expect(sendReason(r, "builder")).not.toMatch(/sends it|lost touch/);   // no promise Check again can't keep (the residual round)
  });
  it("a message held behind a Not sent one says so, not Queued", () => {
    const failed = rec("a", { state: "failed", error: "menu_open", createdAt: 1000 });
    const held = rec("b", { createdAt: 2000 });
    expect(heldBehind(held, [failed, held])).toBe(true);
    expect(sendLabel(held, [failed, held], 3000)).toBe("Waiting for the message above");
    expect(sendLabel(held, [held], 3000)).toBe("Queued");
  });
});
