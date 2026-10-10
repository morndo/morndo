// Validator for review finding #8: Today's "what he said" (quick.ts `sent`, passed to horizon() as `said`) is looked up by
// id only. After he tapped Done on a task, the manager asked it again (E11: the earlier Decision doesn't answer the new
// question) and he answered the new ask in words from another device; the row must not quote the old "Done".
import { describe, expect, it } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { horizon } from "../src/lib/phone/horizon.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m).getTime();
const NOW = at(11, 35);
const task = (o: Partial<DecisionItem>): DecisionItem => ({
  id: "ny-5", asker: { kind: "manager", name: "Manager", workerId: "%1" }, need: "time", title: "Send the signed form", context: null, contextKind: "markdown",
  options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: at(10, 0),
  messageId: "m2", tracking: "ledger", status: "answered", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v2", ...o,
} as DecisionItem);

describe("finding #8: a later answer in words never carries an earlier answer's label", () => {
  it("Done tapped at 09:00, asked again at 10:00, answered in words from the desktop at 11:30", () => {
    const h = horizon({
      decisions: [task({ decision: { choice: { kind: "words" }, at: at(11, 30), via: "here", endpointId: null, sessionId: null } })],
      workers: [], later: new Set(), said: { "ny-5": { label: "Done", at: at(9, 0) } }, now: NOW,
    });
    expect(h.whenReady[0]?.detail).toBe("You answered in words at 11:30. The manager takes it from here.");
  });
  it("control: the same answer (settled on the phone a moment after the hub took it) still reads as he said it", () => {
    const h = horizon({
      decisions: [task({ decision: { choice: { kind: "words" }, at: at(11, 30), via: "here", endpointId: null, sessionId: null } })],
      workers: [], later: new Set(), said: { "ny-5": { label: "Done", at: at(11, 30) + 2_000 } }, now: NOW,
    });
    expect(h.whenReady[0]?.detail).toBe("You said “Done” at 11:30. The manager takes it from here.");
  });
});
