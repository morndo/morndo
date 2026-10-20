// The board's record and frame in the app (ADR-0015, ADR-0032): the record's line for each actor (a lane, you, the
// console, the board itself by D1 to D4), and the Runs of a `board` frame, decoded one by one and keyed by lane.
import { describe, expect, it } from "vitest";
import { GONE_REASON, type TaskActor, type TaskChange, type TaskEvent, type TaskStatus } from "@morndo/domain";
import { avatarOf, decodeRuns, eventLine, whoOf } from "../src/lib/desktop/board.ts";

const ev = (actor: TaskActor, change: TaskChange): TaskEvent => ({ key: "T-1" as TaskEvent["key"], rev: 2, at: 1, actor, change });
const moved = (from: TaskStatus, to: TaskStatus, reason: string | null = null): TaskChange => ({ kind: "moved", from, to, reason });
const line = (e: TaskEvent) => { const l = eventLine(e); return `${l.who} ${l.text}`; };
const board = (rule: "D1" | "D2" | "D3" | "D4"): TaskActor => ({ kind: "board", rule, lane: "builder" });

describe("the record's words", () => {
  it("a lane's own move reads as it always did", () => {
    expect(line(ev({ kind: "worker", name: "builder", token: "t" }, moved("todo", "doing")))).toBe("builder moved it from To do to In progress");
    expect(line(ev({ kind: "principal", endpointId: "e" as never, sessionId: "s" as never }, moved("review", "done")))).toBe("You moved it from In review to Done");
  });
  it("the console is \"console\" (lanes start --task)", () => {
    expect(line(ev({ kind: "console" }, { kind: "assigned", from: null, to: "builder" }))).toBe("console assigned it to builder");
    expect(line(ev({ kind: "console" }, moved("backlog", "todo")))).toBe("console moved it from Backlog to To do");
    expect(whoOf({ kind: "console" })).toBe("console");
  });
  it("the board's own moves say what the lane's Run did, by rule, and keep what the lane said", () => {
    expect(line(ev(board("D1"), moved("doing", "review", "STATUS: DONE. Fix pushed, 54 pass")))).toBe("board moved it to In review when builder said DONE: Fix pushed, 54 pass");
    expect(line(ev(board("D1"), moved("doing", "review", null)))).toBe("board moved it to In review when builder said DONE");
    expect(line(ev(board("D2"), moved("doing", "blocked", "STATUS: BLOCKED needs the token")))).toBe("board moved it to Blocked when builder said it is blocked or needs a decision: needs the token");
    // D2 with no status line carries the outcome's name as its reason: not repeated in the words
    expect(line(ev(board("D2"), moved("doing", "blocked", "needs_decision")))).toBe("board moved it to Blocked when builder said it is blocked or needs a decision");
    expect(line(ev(board("D3"), moved("doing", "todo", GONE_REASON)))).toBe("board moved it to To do when builder stopped");
    expect(line(ev(board("D4"), moved("blocked", "doing")))).toBe("board moved it to In progress when builder started on it");
  });
  it("the console and the board get the system's avatar, a lane an agent's, the manager its own, you yours", () => {
    expect([avatarOf({ kind: "console" }), avatarOf(board("D1")), avatarOf({ kind: "worker", name: "b", token: "t" }), avatarOf({ kind: "manager", name: "manager", token: "t" }), avatarOf({ kind: "principal", endpointId: "e" as never, sessionId: "s" as never })])
      .toEqual(["system", "system", "agent", "peer", "principal"]);
  });
});

describe("the Runs of a board frame (BoardFrameSchema.runs)", () => {
  const good = (o: Record<string, unknown> = {}) => ({ lane: "builder", node: "pc", phase: "working", deadline: null, overdue: false, since: 10, source: "session", ...o });
  it("decodes each on its own and drops one it can't read, keyed by lane", () => {
    const { runs, dropped } = decodeRuns([
      good(),
      good({ lane: "reviewer", phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "npm test" }] }, source: "hook" }),
      good({ lane: "broken", phase: "sleeping" }),                     // a phase this build doesn't know
      { lane: "no-node", phase: "working" },                            // fields missing
      "not a run",
    ]);
    expect(dropped).toBe(3);                                            // negative control: decode the list whole and none of it survives
    expect([...(runs?.keys() ?? [])]).toEqual(["builder", "reviewer"]);
    expect(runs?.get("reviewer")?.wait).toEqual({ on: "background", tasks: [{ type: "shell", label: "npm test" }] });
  });
  it("is null from a hub that sends none, so the board shows no run counts; empty is empty", () => {
    expect(decodeRuns(undefined)).toEqual({ runs: null, dropped: 0 });
    expect(decodeRuns([]).runs?.size).toBe(0);
  });
  it("of two Runs of one lane name, keeps the one whose lane is there, else the later", () => {
    const there = decodeRuns([good({ node: "mac", phase: "working", since: 5 }), good({ node: "pc", phase: "gone", since: 50 })]).runs?.get("builder");
    expect(there?.node).toBe("mac");
    const later = decodeRuns([good({ node: "mac", phase: "ended", outcome: "done", since: 5 }), good({ node: "pc", phase: "working", since: 50 })]).runs?.get("builder");
    expect(later?.node).toBe("pc");
  });
});
