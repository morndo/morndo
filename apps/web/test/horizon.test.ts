// Horizon (ADR-0009, done criteria 22 to 24): the headline is the earliest open item that needs him, or how many wait
// now; every time comes from a record and anything without one sits under "when ready"; every row needs him or not.
import { describe, expect, it } from "vitest";
import type { RosterEntry, WorkerId } from "@morndo/domain";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import { byLabel, heroTime, horizon, keptForLater, timeLabel, untilLabel } from "../src/lib/phone/horizon.ts";

const NOW = new Date(2026, 9, 3, 9, 44).getTime();
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 3 + dayOffset, h, m).getTime();
const item = (id: string, o: Partial<DecisionItem> = {}): DecisionItem => ({
  id, asker: { kind: "manager", name: "Manager", workerId: "%1" }, need: "decision", title: `Question ${id}`, context: null, contextKind: "markdown",
  options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 60_000,
  messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, ...o,
} as DecisionItem);
const worker = (name: string, o: Partial<RosterEntry> = {}): RosterEntry => ({ id: `%${name}` as WorkerId, name, location: "/work", node: "local", offline: false, title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0, ...o });

describe("Horizon", () => {
  it("with nothing waiting, the headline is the earliest open item that needs him (22)", () => {
    const h = horizon({
      decisions: [item("slot", { need: "time", title: "Call the accountant", deadline: at(16) }), item("old", { deadline: at(9, 0, 2) }), item("late", { need: "time", deadline: at(20) })],
      workers: [], later: new Set(["old"]), now: NOW,
    });
    expect(h.waitingNow).toBe(0);
    expect(h.next?.title).toBe("Call the accountant");
    expect(h.next?.at).toBe(at(16));
  });
  it("with something waiting, it counts what waits now: open decisions not kept for later, and anything overdue (22)", () => {
    const h = horizon({
      decisions: [item("a"), item("b", { deadline: at(18) }), item("kept"), item("over", { need: "time", deadline: at(8) }), item("done", { status: "answered" })],
      workers: [], later: new Set(["kept"]), now: NOW,
    });
    expect(h.waitingNow).toBe(3);                                      // a, b, over
    expect(h.past.map(r => r.key)).toEqual(["d:over"]);
  });
  it("every time comes from a record; without one, an item sits under when ready (23)", () => {
    const h = horizon({
      decisions: [item("a"), item("b", { deadline: at(18) }), item("ans", { status: "answered", deadline: at(19), decision: { choice: { kind: "option", key: "ship", label: "Ship it" }, at: at(9, 41), via: "here", endpointId: null, sessionId: null } })],
      workers: [worker("builder", { state: "active", title: "Build the login page" }), worker("idle")], later: new Set(), now: NOW,
    });
    const all = [...h.past, ...h.whenReady, ...h.coming];
    for (const r of all) expect(r.at === null ? h.whenReady.includes(r) : true).toBe(true);
    expect(h.coming.map(r => [r.key, r.at])).toEqual([["d:b", at(18)], ["d:ans", at(19)]]);
    expect(h.whenReady.map(r => r.key)).toEqual(["d:a", "w:%builder"]);        // needs you first; the idle worker isn't there
    expect(h.coming[1]?.detail).toContain("You said “Ship it” at 09:41");
  });
  it("every row is marked: needs you, or happens without you (24); decide now only where a decision card exists (25)", () => {
    const h = horizon({
      decisions: [item("a"), item("t", { need: "time" }), item("ans", { status: "answered" }), item("gone", { status: "settled" })],
      workers: [worker("builder", { state: "active" })], later: new Set(), now: NOW,
    });
    const all = [...h.past, ...h.whenReady, ...h.coming];
    expect(all.map(r => [r.key, r.needsYou, r.decisionId])).toEqual([
      ["d:a", true, "a"], ["d:t", true, null], ["w:%builder", false, null], ["d:ans", false, null],
    ]);
  });
  it("nothing open and nobody working: no headline time, nothing waits", () => {
    const h = horizon({ decisions: [], workers: [], later: new Set(), now: NOW });
    expect([h.waitingNow, h.next]).toEqual([0, null]);
  });
  it("labels: a time today, another day with its weekday, a whole-day deadline as the day", () => {
    expect(timeLabel(at(16), NOW)).toEqual({ big: "16:00", small: null });
    expect(timeLabel(at(9, 0, 2), NOW)).toEqual({ big: "Mon", small: "09:00" });
    expect(timeLabel(new Date(2026, 9, 4, 23, 59, 59).getTime(), NOW)).toEqual({ big: "Sun", small: "end of day" });
    expect(heroTime(new Date(2026, 9, 4, 23, 59, 59).getTime(), NOW)).toBe("Tomorrow");
    expect(byLabel(new Date(2026, 9, 3, 23, 59, 59).getTime(), NOW)).toBe("by the end of today");
    expect(byLabel(at(18), NOW)).toBe("by 18:00");
    expect(untilLabel(at(16), NOW)).toBe("in 6 h 16 min");
    expect(untilLabel(NOW + 4 * 60_000, NOW)).toBe("in 4 min");
  });
});

// Review of PR #7, finding 7: "kept for later" belongs to the ask he set aside, not to its id for ever.
describe("kept for later", () => {
  it("counts only for the same, still open ask: a reopened prompt under the same id, or a closed one, isn't kept", () => {
    const later = { "menu-4": "v1", "ny-1": "v7", "ny-2": "v3" };
    const set = keptForLater(later, [item("menu-4", { version: "v2" }), item("ny-1", { version: "v7" }), item("ny-2", { version: "v3", status: "settled" })]);
    expect([...set]).toEqual(["ny-1"]);
  });
});

// The product lane's cycle, 2026-10-04: a blocking decision kept for later still waits now: Horizon never says nothing
// needs him while it blocks an agent.
describe("a blocking decision kept for later", () => {
  it("still counts as waiting now, with or without a deadline, and its row says it blocks", () => {
    const h = horizon({ decisions: [item("b", { blocking: true })], workers: [], later: new Set(["b"]), now: NOW });
    expect(h.waitingNow).toBe(1);
    expect(h.whenReady.find(r => r.key === "d:b")?.detail).toMatch(/blocks/i);
    const timed = horizon({ decisions: [item("t", { blocking: true, deadline: at(18) })], workers: [], later: new Set(["t"]), now: NOW });
    expect(timed.waitingNow).toBe(1);
    // Not blocking, kept for later: it waits for its time, as before.
    expect(horizon({ decisions: [item("n")], workers: [], later: new Set(["n"]), now: NOW }).waitingNow).toBe(0);
  });
});

// The owner's feedback, 2026-10-04: a row reads as a short title (the list's, or its text's first clause), and a task
// he kept for later (its row's Later) is off today: in its own place at the end, not waiting, not the headline.
describe("Horizon, readable", () => {
  it("a row's title is the short one, and the row carries its item for the rest", () => {
    const h = horizon({ decisions: [item("a", { title: "#123 is LIVE. Your test purchase: sign in, buy, cancel." }), item("b", { shortTitle: "Ship the demo" })], workers: [], later: new Set(), now: NOW });
    expect(h.whenReady.map(r => [r.key, r.title, r.item?.id])).toEqual([["d:a", "#123 is LIVE", "a"], ["d:b", "Ship the demo", "b"]]);
  });
  it("a task kept for later: under its own heading, not waiting now even when overdue, never the headline", () => {
    const h = horizon({
      decisions: [item("t1", { need: "time", deadline: at(8) }), item("t2", { need: "time", deadline: at(16) }), item("t3", { need: "time" })],
      workers: [], later: new Set(), kept: new Set(["t1", "t2", "t3"]), now: NOW,
    });
    expect([h.waitingNow, h.next, h.past.length, h.whenReady.length, h.coming.length]).toEqual([0, null, 0, 0, 0]);
    expect(h.kept.map(r => r.key)).toEqual(["d:t1", "d:t2", "d:t3"]);
  });
  it("what he said from a task's row reads as he said it", () => {
    const h = horizon({
      decisions: [item("t", { need: "time", status: "answered", decision: { choice: { kind: "words" }, at: at(9, 40), via: "here", endpointId: null, sessionId: null } })],
      workers: [], later: new Set(), said: { t: { label: "Done", at: at(9, 40) } }, now: NOW,
    });
    expect(h.whenReady[0]?.detail).toBe("You said “Done” at 09:40. The manager takes it from here.");
  });
});

describe("Horizon, the headline's words", () => {
  it("says what waits: decisions, and tasks past their time, apart", () => {
    const h = horizon({
      decisions: [item("a"), item("b", { deadline: at(18) }), item("over", { need: "time", deadline: at(8) }), item("t", { need: "time" })],
      workers: [], later: new Set(), now: NOW,
    });
    expect([h.waitingNow, h.waitingDecisions, h.waitingTasks]).toEqual([3, 2, 1]);
  });
  it("his own words from a task's row read as his own words, not as a quote", () => {
    const h = horizon({
      decisions: [item("t", { need: "time", status: "answered", decision: { choice: { kind: "words" }, at: at(9, 40), via: "here", endpointId: null, sessionId: null } })],
      workers: [], later: new Set(), said: { t: { label: "your own words", at: at(9, 40) } }, now: NOW,
    });
    expect(h.whenReady[0]?.detail).toBe("You answered in your own words at 09:40. The manager takes it from here.");
  });
});

describe("what he said, only for the same answer (code review #8)", () => {
  it("an answer in words after an earlier Done on the same id reads as words, not as the old Done", () => {
    const h = horizon({
      decisions: [item("t", { need: "time", status: "answered", askedAt: at(9, 30), decision: { choice: { kind: "words" }, at: at(9, 40), via: "here", endpointId: null, sessionId: null } })],
      workers: [], later: new Set(), said: { t: { label: "Done", at: at(8, 0) } }, now: NOW,
    });
    expect(h.whenReady[0]?.detail).toBe("You answered in words at 09:40. The manager takes it from here.");
  });
});

describe("tasks he can do anytime (code review #9)", () => {
  it("counts open tasks without a time; a decision kept for later is no task", () => {
    expect(horizon({ decisions: [item("pick")], workers: [], later: new Set(["pick"]), now: NOW }).anytimeTasks).toBe(0);
    expect(horizon({ decisions: [item("call", { need: "time" })], workers: [], later: new Set(), now: NOW }).anytimeTasks).toBe(1);
  });
});
