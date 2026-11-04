// A status line may end with next: <who> by <when> (T-805, B22): who owes the next move on the task, and by when. Read
// on any status; a WAITING line keeps its own lease, and what does not parse leaves the line as it was. Pure.
import { describe, expect, it } from "vitest";
import { statusLineOf } from "../src/lane-status.ts";

describe("a trailing next: on a status line (B22)", () => {
  it("reads who (owner, manager, a lane, a task key) and when: a date, an instant with Z or an offset, or in <N> min|h", () => {
    expect(statusLineOf("STATUS: BLOCKED T-12 needs a token, next: owner by 2026-11-05"))
      .toEqual({ status: "blocked", taskKey: "T-12", next: { who: "owner", by: { at: Date.parse("2026-11-05T23:59:00Z") } } });
    expect(statusLineOf("STATUS: NEEDS DECISION T-12 which db? next: manager by 2026-11-05T09:00+01:00"))
      .toEqual({ status: "needs_decision", taskKey: "T-12", next: { who: "manager", by: { at: Date.parse("2026-11-05T08:00:00Z") } } });
    expect(statusLineOf("STATUS: BLOCKED next: md-board by in 2 h"))
      .toEqual({ status: "blocked", next: { who: "md-board", by: { inMs: 7_200_000 } } });
    expect(statusLineOf("STATUS: BLOCKED next: md-board by in 90 min"))
      .toEqual({ status: "blocked", next: { who: "md-board", by: { inMs: 5_400_000 } } });
    expect(statusLineOf("STATUS: BLOCKED next: T-805 by 2026-11-05T09:00Z"))
      .toEqual({ status: "blocked", next: { who: "T-805", by: { at: Date.parse("2026-11-05T09:00:00Z") } } });
    expect(statusLineOf("STATUS: BLOCKED stuck, NEXT: owner by 2026-11-05"))          // the word is case-insensitive
      .toEqual({ status: "blocked", next: { who: "owner", by: { at: Date.parse("2026-11-05T23:59:00Z") } } });
  });

  it("the clause survives what a lane puts around the end of a line: a full stop, bold or italic markers, quotes, brackets", () => {
    const owner = { who: "owner", by: { at: Date.parse("2026-11-05T23:59:00Z") } };
    for (const l of [
      "STATUS: BLOCKED stuck, next: owner by 2026-11-05.",
      "**STATUS: BLOCKED stuck, next: owner by 2026-11-05**",
      "STATUS: BLOCKED stuck (next: owner by 2026-11-05)",
      "STATUS: BLOCKED stuck, `next: owner by 2026-11-05`",
      "STATUS: BLOCKED stuck, next: owner by 2026-11-05 .",
      "_STATUS: BLOCKED stuck, next: owner by 2026-11-05_",
    ]) expect(statusLineOf(l), l).toEqual({ status: "blocked", next: owner });
    expect(statusLineOf("STATUS: WAITING main CI for 12 min (next: manager by in 3 h)"))
      .toEqual({ status: "waiting", waitingOn: "main CI", forMs: 720_000, next: { who: "manager", by: { inMs: 10_800_000 } } });
  });

  it("a WAITING line keeps its own lease: the duration inside next: is not the wait's", () => {
    expect(statusLineOf("STATUS: WAITING main CI for 12 min, next: manager by in 3 h"))
      .toEqual({ status: "waiting", waitingOn: "main CI", forMs: 720_000, next: { who: "manager", by: { inMs: 10_800_000 } } });
  });

  it("the word next in prose is not a next clause: the line reads as before", () => {
    expect(statusLineOf("STATUS: WAITING for the next release")).toEqual({ status: "waiting", waitingOn: "for the next release" });
  });

  it("what does not parse leaves next absent and the rest of the line as it was", () => {
    for (const l of [
      "STATUS: BLOCKED stuck, next: by 2026-11-05",          // no who
      "STATUS: BLOCKED stuck, next: owner",                  // no by
      "STATUS: BLOCKED stuck, next: owner by tomorrow",      // no form of when
      "STATUS: BLOCKED stuck, next: Owner Name by 2026-11-05",  // not owner, a lane or a key
      "STATUS: BLOCKED stuck, next: owner by 2026-13-45",    // no such date
      "STATUS: BLOCKED stuck, next: owner by in 0 min",      // a duration of nothing
    ]) expect(statusLineOf(l), l).toEqual({ status: "blocked" });
  });

  it("a line without next parses exactly as before", () => {
    expect(statusLineOf("STATUS: DONE T-12")).toEqual({ status: "done", taskKey: "T-12" });
    expect(statusLineOf("STATUS: BLOCKED")).toEqual({ status: "blocked" });
  });
});
