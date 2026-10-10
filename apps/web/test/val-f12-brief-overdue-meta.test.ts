// Validator for review finding #12: brief()'s meta line reads a past deadline like a future one ("due Sat", "due 08:00").
// Synthetic items only. NOW is Sunday 2026-10-04 10:00 local time.
import { describe, expect, it } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { brief } from "../src/lib/phone/brief.ts";

const NOW = new Date(2026, 9, 4, 10, 0).getTime();
const item = (o: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "t-1", asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "time", title: "Water the plants",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [], answerBy: "words", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 86_400_000,
  messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1", ...o,
} as DecisionItem);
const dueOf = (b: { meta: string[] }) => b.meta.find(m => /due|late|overdue|past/i.test(m));
const PAST = /overdue|late|was due|past/i;

describe("finding #12: a deadline that has passed", () => {
  it("control: a future deadline still reads 'due 16:00'", () => {
    expect(dueOf(brief(item({ deadline: new Date(2026, 9, 4, 16, 0).getTime() }), NOW))).toBe("due 16:00");
  });
  it("yesterday's whole-day deadline (Sat 23:59, now Sun 10:00) says it is past, not 'due Sat'", () => {
    const due = dueOf(brief(item({ deadline: new Date(2026, 9, 3, 23, 59).getTime() }), NOW));
    expect(due).toMatch(PAST);
  });
  it("08:00 today, now 10:00, says it is past, not 'due 08:00'", () => {
    const due = dueOf(brief(item({ deadline: new Date(2026, 9, 4, 8, 0).getTime() }), NOW));
    expect(due).toMatch(PAST);
  });
});
