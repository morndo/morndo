// Validator for review finding #7: askVersion (E12) and the short form's link and minutes (ADR-0009 readability pass:
// "When the short form is given, askVersion covers it too"; the short form is shortTitle, summary, minutes, link, details).
import { describe, expect, it } from "vitest";
import { askVersion } from "../src/escalation.ts";

const base = {
  askedAt: 1000, messageId: "m1", title: "Follow the runbook", context: null,
  options: [], recommendation: null, ifNoAnswer: null, deadline: null,
  shortTitle: "Follow the runbook", summary: "Run the steps, then say Done.", details: "Step 1, step 2.",
  minutes: 10, link: "https://example.test/runbook-a",
};

describe("askVersion and the short form (finding #7)", () => {
  it("changes when only the link was restated", () => {
    const restated = { ...base, link: "https://example.test/runbook-b" };
    expect(askVersion(restated)).not.toBe(askVersion(base));
  });
  it("changes when only the minutes were restated", () => {
    const restated = { ...base, minutes: 90 };
    expect(askVersion(restated)).not.toBe(askVersion(base));
  });
});
