// What a worker waits for, as an identity (ADR-0008 phase C, S6): a Command carries the one it was written for, and
// the hub refuses it as stale when it changed. Questions win over a menu (a question shows as a menu on the screen).
import { describe, expect, it } from "vitest";
import { Roster, waitingOn, workerId } from "../src/index.ts";

describe("waitingOn", () => {
  it("is null when nothing waits, the open questions' ids, or the menu's identity", () => {
    expect(waitingOn({ openQuestionIds: [], menu: null })).toBeNull();
    expect(waitingOn({ openQuestionIds: ["toolu_1"], menu: null })).toBe("q:toolu_1");
    expect(waitingOn({ openQuestionIds: ["toolu_2", "toolu_1"], menu: null })).toBe("q:toolu_1,toolu_2");   // order-free
    expect(waitingOn({ openQuestionIds: [], menu: "ab12cd" })).toBe("menu:ab12cd");
    expect(waitingOn({ openQuestionIds: ["toolu_1"], menu: "ab12cd" })).toBe("q:toolu_1");
  });
});

describe("the roster tells when what a worker waits for changes", () => {
  const roster = () => {
    const r = new Roster(1000);
    r.observeListing([{ id: workerId("%1"), name: "builder", location: "/w", node: "local", offline: false }], 0);
    return r;
  };
  it("from nothing to a question, then a different question with needsYou still true", () => {
    const r = roster();
    expect(r.observeDetails(workerId("%1"), { needsYou: true, waitingOn: "q:a" })).toEqual([{ type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: true, waitingOn: "q:a" }]);
    expect(r.observeDetails(workerId("%1"), { needsYou: true, waitingOn: "q:b" })).toEqual([{ type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: true, waitingOn: "q:b" }]);
    expect(r.observeDetails(workerId("%1"), { needsYou: true, waitingOn: "q:b" })).toEqual([]);
    expect(r.entries()[0]?.waitingOn).toBe("q:b");
  });
  it("back to nothing", () => {
    const r = roster();
    r.observeDetails(workerId("%1"), { needsYou: true, waitingOn: "menu:x" });
    expect(r.observeDetails(workerId("%1"), { needsYou: false, waitingOn: null })).toEqual([{ type: "WorkerNeedsYouChanged", workerId: "%1", needsYou: false, waitingOn: null }]);
  });
  it("a new worker starts waiting on nothing", () => {
    expect(roster().entries()[0]?.waitingOn).toBeNull();
  });
});
