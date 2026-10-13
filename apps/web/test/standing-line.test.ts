// Where an answer stands, in the one sentence the phone sheet, the catch-up card and the desktop modal share.
import { describe, expect, it } from "vitest";
import { standingLine, type DecisionItem } from "../src/lib/desktop/decisions.ts";

const item = (over: Partial<DecisionItem>): DecisionItem => ({
  id: "d-5" as DecisionItem["id"],
  asker: { kind: "worker", name: "alpha", workerId: "pc.3fa2c1d0.1" },
  need: "decision", title: "Approve option B", shortTitle: "Triage", summary: "Approve option B",
  minutes: 4, link: null, details: null, context: null, contextKind: "markdown", options: [],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: 0, messageId: null, tracking: "hub", status: "answered", source: "open", decision: null,
  resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v1", inbox: null,
  brief: null, briefVersion: 0, draftedBy: null,
  ...over,
});

describe("standingLine", () => {
  it("names an answer given on another device, choice and all", () => {
    const said = standingLine(item({
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: 1, via: "elsewhere", endpointId: null, sessionId: null },
    }), "Alpha");
    expect(said).toBe("Answered on another device: “Extend the triage script”.");
    const words = standingLine(item({
      decision: { choice: { kind: "words" }, at: 1, via: "elsewhere", endpointId: null, sessionId: null },
    }), "Alpha");
    expect(words).toBe("Answered on another device: in words.");
  });
});
