// Where an answer stands, in the one sentence the phone sheet, the catch-up card and the desktop modal share.
// The feed's via is the whole truth — the hub derives it per client — so every line here holds after a reload, with
// no local memory of what this page sent, and on a second tab the same way.
import { describe, expect, it } from "vitest";
import { standingLine, type DecisionItem } from "../src/lib/desktop/decisions.ts";

const item = (over: Partial<DecisionItem>): DecisionItem => ({
  id: "d-5" as DecisionItem["id"],
  asker: { kind: "worker", name: "alpha", workerId: "pc.3fa2c1d0.1" },
  need: "decision", title: "Approve option B", shortTitle: "Triage", summary: "Approve option B",
  minutes: 4, link: null, details: null, context: null, contextKind: "markdown", options: [],
  answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
  askedAt: 0, messageId: null, tracking: "hub", status: "answered", source: "open", decision: null,
  resolution: null, settledAt: null, askedAgain: false, answerable: null, version: "v1",
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

  // The hub says "here" for the device whose request accepted the answer, so this holds after a reload and on a
  // second tab: no local memory takes part.
  it("an answer the feed says was given here reads here, with no local memory at all", () => {
    expect(standingLine(item({
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: 1, via: "here", endpointId: null, sessionId: null },
    }), "Alpha")).toBe("Sent. You chose Extend the triage script. Alpha has it.");
  });

  it("an answer given here says where its delivery stands", () => {
    const d = { choice: { kind: "option" as const, key: "b", label: "Extend the triage script" }, at: 1, via: "here" as const, endpointId: null, sessionId: null };
    expect(standingLine(item({ decision: { ...d, delivery: { state: "queued", at: null } } }), "Alpha")).toBe("Queued.");
    expect(standingLine(item({ decision: { ...d, delivery: { state: "delivered", at: 2 } } }), "Alpha")).toBe("Delivered. You chose Extend the triage script.");
  });

  // A record that names no endpoint and wasn't seen elsewhere keeps no via on the wire: neutral, it claims neither.
  it("an answer whose via the feed leaves out stays neutral", () => {
    expect(standingLine(item({
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: 1, endpointId: null, sessionId: null },
    }), "Alpha")).toBe("Answered: Extend the triage script.");
  });
});
