// Validation of review finding #4 (range b9328b196..d90a1443e, PR #11): H3's "a NEEDS DECISION report he has answered
// no longer waits" (ADR-0011, review item 4) was applied to laneStatus only. digestLines (H5) still calls the lane
// "needs you" although the digest's own messages hold his answer after that report (the hub's digest keeps the
// principal's messages: newSince drops only tool calls and system events). So Status says idle and the digest, for
// the same lane at the same moment, puts it on top as "Needs you". Synthetic data.
import { describe, expect, it } from "vitest";
import { digestLines, laneStatus, type Message } from "../src/index.ts";

const agent = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "agent", name: "builder" }, kind: "text", text });
const you = (id: string, at: number, text: string): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const conv = (messages: Message[]) => [{ worker: "%1", name: "builder", messages, needsYou: false, asks: [] }];
const report = agent("a", 40, "STATUS: NEEDS DECISION. Ship Friday or Monday?");

describe("finding #4: an answered NEEDS DECISION report in the digest (H3, H5)", () => {
  it("control: not answered, both Status and the digest say it waits for him", () => {
    expect(laneStatus({ state: "quiet", changedAt: 50, needsYou: false, asks: [], answer: report }).kind).toBe("waits");
    expect(digestLines(conv([report]), "manager")[0]?.kind).toBe("needs_you");
  });
  it("control: answered, then it reports NEEDS DECISION again: it waits again", () => {
    expect(digestLines(conv([report, you("y", 45, "Friday"), agent("b", 60, "STATUS: NEEDS DECISION. Morning or evening?")]), "manager")[0]?.kind).toBe("needs_you");
  });
  it("answered by him after the report: Status no longer waits, and the digest must not say Needs you either", () => {
    const messages = [report, you("y", 45, "Friday")];
    expect(laneStatus({ state: "quiet", changedAt: 50, needsYou: false, asks: [], answer: report, repliedAt: 45 }).kind).toBe("idle");
    expect(digestLines(conv(messages), "manager")[0]?.kind).not.toBe("needs_you");
  });
});
