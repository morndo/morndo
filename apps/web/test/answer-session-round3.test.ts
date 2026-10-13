// Review round 3: stale and seen compare the two versions. They must not read the rest of the session
// (a keystroke in the words field would otherwise re-run every button that checks stale).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";

function item(version: string, over: Partial<DecisionItem> = {}): DecisionItem {
  return {
    id: "d-1" as DecisionItem["id"],
    asker: { kind: "manager", name: "Manager", workerId: "w" },
    need: "decision", title: "Ship the weekly notes", shortTitle: "Weekly notes", summary: null, minutes: null, link: null,
    details: null, context: null, contextKind: "markdown",
    options: [{ key: "b", label: "Extend the triage script", detail: null }],
    answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null,
    askedAt: 0, messageId: null, tracking: "hub", status: "open", source: "open", decision: null, resolution: null,
    settledAt: null, askedAgain: false, answerable: null, version, brief: null, briefVersion: 1, draftedBy: null,
    ...over,
  };
}

beforeEach(() => {
  const state = <T>(v: T) => v;
  vi.stubGlobal("$state", Object.assign(state, { raw: <T>(v: T) => v }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("stale and seen", () => {
  it("compare versions without reading the rest of the session", async () => {
    const { AnswerSession } = await import("../src/lib/desktop/answer-session.svelte.ts");
    const s = new AnswerSession(item("v1"));
    let words = 0;
    Object.defineProperty(s, "words", { get() { words += 1; return ""; }, set() {} });
    expect(s.stale).toBe(false);
    expect(s.seen).toBe("v1");
    expect(words).toBe(0);
    s.bind(item("v2"), true);
    expect(s.stale).toBe(true);
    expect(s.seen).toBe("v1");
    expect(words).toBe(0);
  });

  it("a new item with the same version still replaces live when another field changed", async () => {
    const { AnswerSession } = await import("../src/lib/desktop/answer-session.svelte.ts");
    const first = item("v1");
    const s = new AnswerSession(first);
    const next = item("v1", { waiting: "offline", askedAgain: true });
    s.bind(next, false);
    expect(s.live).toBe(next);
    expect(s.shown).toBe(next);
    expect(s.live.askedAgain).toBe(true);
  });
});
