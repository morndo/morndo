// Where an answer stands, in the one sentence the phone sheet, the catch-up card and the desktop modal share.
import { describe, expect, it } from "vitest";
import { standingLine, type DecisionItem } from "../src/lib/desktop/decisions.ts";
import { clearSends, rememberSend } from "../src/lib/sent-here.ts";

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
    clearSends();
    const said = standingLine(item({
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: 1, via: "elsewhere", endpointId: null, sessionId: null },
    }), "Alpha");
    expect(said).toBe("Answered on another device: “Extend the triage script”.");
    const words = standingLine(item({
      decision: { choice: { kind: "words" }, at: 1, via: "elsewhere", endpointId: null, sessionId: null },
    }), "Alpha");
    expect(words).toBe("Answered on another device: in words.");
  });

  it("keeps this device's own send for that version, and a later version from elsewhere stays elsewhere", () => {
    clearSends();
    rememberSend("d-own", "req-1", "v1");
    const decision = { choice: { kind: "option" as const, key: "b", label: "Extend the triage script" }, at: 1, via: "elsewhere" as const, endpointId: null, sessionId: null };
    const own = item({ id: "d-own" as DecisionItem["id"], decision });
    expect(standingLine(own, "Alpha")).toBe("Sent. You chose Extend the triage script. Alpha has it.");
    const { via: _via, ...missing } = decision;
    expect(standingLine(item({ id: "d-own" as DecisionItem["id"], decision: missing as typeof decision }), "Alpha")).toBe("Sent. You chose Extend the triage script. Alpha has it.");
    expect(standingLine(item({ id: "d-own" as DecisionItem["id"], version: "v2", decision }), "Alpha")).toBe("Answered on another device: “Extend the triage script”.");
    expect(standingLine(item({ id: "d-other" as DecisionItem["id"], decision: missing as typeof decision }), "Alpha")).toBe("Answered: Extend the triage script.");
  });

  it("an empty seen or an empty version is not this device's send", () => {
    clearSends();
    const decision = { choice: { kind: "option" as const, key: "b", label: "Extend the triage script" }, at: 1, via: "elsewhere" as const, endpointId: null, sessionId: null };
    rememberSend("d-blank", "req-1", "");
    expect(standingLine(item({ id: "d-blank" as DecisionItem["id"], version: "", decision }), "Alpha")).toBe("Answered on another device: “Extend the triage script”.");
    rememberSend("d-blank", "req-2", "v1");
    expect(standingLine(item({ id: "d-blank" as DecisionItem["id"], version: "", decision }), "Alpha")).toBe("Answered on another device: “Extend the triage script”.");
    rememberSend("d-blank", "req-3", "");
    expect(standingLine(item({ id: "d-blank" as DecisionItem["id"], version: "v1", decision }), "Alpha")).toBe("Answered on another device: “Extend the triage script”.");
  });
});
