// How an item reads on the phone (timeline text stays short enough to read):
// a short title on one line, one plain sentence, a meta line, the rest behind "More"; and which buttons it gets.
// Synthetic items only.
import { describe, expect, it } from "vitest";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { actions, brief, clause } from "../src/lib/phone/brief.ts";

const NOW = new Date(2026, 9, 4, 9, 0).getTime();
const item = (o: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "ny-1", asker: { kind: "manager", name: "Manager", workerId: "%0" }, need: "decision", title: "Ship the demo tonight?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [], answerBy: "words", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 60_000,
  messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1", ...o,
} as DecisionItem);

describe("a title from a long text (no title given)", () => {
  it("is its first clause: up to a full stop, a colon, a semicolon or a bracket; the rest goes behind More", () => {
    expect(clause("#42 is ready. Your garden check (~5 min, after lunch): open www.example.com/garden, then water the beds.")).toEqual({
      title: "#42 is ready", rest: "Your garden check (~5 min, after lunch): open www.example.com/garden, then water the beds.",
    });
    expect(clause("garden shed rebuild: for the order we need (1) the wood sizes, (2) a delivery day")).toEqual({
      title: "garden shed rebuild", rest: "for the order we need (1) the wood sizes, (2) a delivery day",
    });
    expect(clause("recipes.index draft PR #12 (menu.css renamed, checked): you merge it. ~5 min.")).toEqual({
      title: "recipes.index draft PR #12", rest: "(menu.css renamed, checked): you merge it. ~5 min.",
    });
  });
  it("a question keeps its question mark; a short text is all title", () => {
    expect(clause("Ship the demo tonight? It is green.")).toEqual({ title: "Ship the demo tonight?", rest: "It is green." });
    expect(clause("Sign the lease")).toEqual({ title: "Sign the lease", rest: null });
  });
  it("at most 60 characters, cut at a word with an ellipsis, and then the whole text is behind More", () => {
    const long = "Water every plant on the balcony and the windowsills and write down which ones need new soil this spring";
    const c = clause(long);
    expect(c.title.length).toBeLessThanOrEqual(60);
    expect(c.title).toBe("Water every plant on the balcony and the windowsills and…");
    expect(c.rest).toBe(long);
  });
  it("one line: newlines and runs of spaces fold", () => {
    expect(clause("Sign\n\nthe   lease")).toEqual({ title: "Sign the lease", rest: null });
  });
});

describe("brief", () => {
  it("the list's own short form wins: its title, its sentence, and the long question behind More", () => {
    const b = brief(item({ need: "time", title: "#42 is ready. Your garden check: water, weed, log it.", shortTitle: "Check the garden", summary: "Water the beds, pull the weeds, then log it.", minutes: 10, details: "Use the blue can.", link: "https://example.com/garden", ifNoAnswer: "the beds wait" }), NOW);
    expect(b).toMatchObject({ title: "Check the garden", sentence: "Water the beds, pull the weeds, then log it.", meta: ["≈10 min", "only you"] });
    expect(b.more).toEqual({ text: "#42 is ready. Your garden check: water, weed, log it.\n\nUse the blue can.", link: "https://example.com/garden", ifNoAnswer: "the beds wait", recommendation: null });
  });
  it("without one: a title from the text's first clause, no sentence, and the rest behind More", () => {
    const b = brief(item({ need: "time", title: "#42 is ready. Your garden check: water, weed, log it." }), NOW);
    expect(b).toMatchObject({ title: "#42 is ready", sentence: null, meta: ["only you"] });
    expect(b.more.text).toBe("Your garden check: water, weed, log it.");
  });
  it("a decision says so, what it blocks and when it is due", () => {
    expect(brief(item({ blocking: true, project: "auth-plans", deadline: new Date(2026, 9, 4, 16, 0).getTime() }), NOW).meta).toEqual(["Decision", "blocks auth-plans", "due 16:00"]);
    expect(brief(item({ blocking: true }), NOW).meta).toEqual(["Decision", "blocks work"]);
    expect(brief(item({ need: "time", minutes: 5, deadline: new Date(2026, 9, 5, 23, 59).getTime() }), NOW).meta).toEqual(["≈5 min", "only you", "due tomorrow"]);
  });
  it("a deadline that has passed reads as overdue, in words (code review #12)", () => {
    expect(brief(item({ deadline: new Date(2026, 9, 4, 8, 0).getTime() }), NOW).meta).toEqual(["Decision", "overdue since 08:00"]);
    expect(brief(item({ need: "time", deadline: new Date(2026, 9, 3, 23, 59).getTime() }), NOW).meta).toEqual(["only you", "overdue since Sat"]);
  });
  it("nothing more to show: More stays empty; a link that isn't http(s) is never offered", () => {
    expect(brief(item(), NOW).more).toEqual({ text: null, link: null, ifNoAnswer: null, recommendation: null });
    expect(brief(item({ link: "javascript:alert(1)" }), NOW).more.link).toBeNull();
  });
  it("the long question isn't repeated behind More when it says what the title and sentence say", () => {
    expect(brief(item({ title: "Sign the lease", shortTitle: "Sign the lease" }), NOW).more.text).toBeNull();
  });
});

describe("the buttons an item gets", () => {
  const opts = [{ key: "a", label: "Ship it", detail: null }, { key: "b", label: "Hold", detail: null }, { key: "c", label: "Ask the team", detail: null }];
  it("a decision on the dashboard: Decide now, which opens its card", () => {
    expect(actions(item({ options: opts, answerBy: "tap" }), "row")).toEqual([{ kind: "decide" }]);
  });
  it("a decision's card: every option, the recommended (first) one marked, then its own-words button", () => {
    expect(actions(item({ options: opts, answerBy: "tap" }), "card")).toEqual([
      { kind: "option", key: "a", label: "Ship it", recommended: true }, { kind: "option", key: "b", label: "Hold", recommended: false },
      { kind: "option", key: "c", label: "Ask the team", recommended: false }, { kind: "words" },
    ]);
  });
  it("a decision without options: the default when there is one, and its own words", () => {
    expect(actions(item({ ifNoAnswer: "it waits" }), "card")).toEqual([{ kind: "default", text: "it waits" }, { kind: "words" }]);
    expect(actions(item(), "card")).toEqual([{ kind: "words" }]);
  });
  it("a task never gets Decide now: Done and Later, and its own words; its options when it has some", () => {
    expect(actions(item({ need: "time" }), "row")).toEqual([{ kind: "done" }, { kind: "later" }, { kind: "words" }]);
    expect(actions(item({ need: "time", options: opts.slice(0, 2), answerBy: "tap" }), "row")).toEqual([
      { kind: "option", key: "a", label: "Ship it", recommended: true }, { kind: "option", key: "b", label: "Hold", recommended: false }, { kind: "later" }, { kind: "words" },
    ]);
  });
  it("nothing to press on what isn't open, or what can only be answered on its own screen", () => {
    expect(actions(item({ status: "answered" }), "row")).toEqual([]);
    expect(actions(item({ need: "time", status: "settled" }), "row")).toEqual([]);
    expect(actions(item({ answerBy: "screen" }), "card")).toEqual([]);
    expect(actions(item({ answerBy: "screen" }), "row")).toEqual([{ kind: "decide" }]);
  });
});
