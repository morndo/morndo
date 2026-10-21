// A lane's Run on the board (ADR-0032, design §7): the ring, the dot and the live line for every phase, wait and overdue;
// the header's counts; the one card a lane's Run shows on; and the lanes working without an open task. Pure: no page.
import { describe, expect, it } from "vitest";
import type { Run, RunWait, Task, TaskStatus } from "@morndo/domain";
import { hhmm, lanesWithoutTask, runCards, runCounts, runLook, saidOf, span } from "../src/lib/desktop/run-words.ts";

const MIN = 60_000;
const NOW = new Date(2026, 9, 20, 14, 30).getTime();            // local time: the wake-up words are this device's clock
const run = (o: Partial<Run> = {}): Run => ({ lane: "builder", node: "pc", phase: "working", deadline: null, overdue: false, since: NOW - 3 * MIN, source: "session", ...o });
const task = (n: number, status: TaskStatus, assignee: string | null, updatedAt = 1): Task => ({
  key: `T-${n}` as Task["key"], n, title: `task ${n}`, description: "", status, assignee, priority: "normal", blockedReason: null,
  createdAt: 1, updatedAt, stateChangedAt: updatedAt, createdBy: { kind: "manager", name: "manager", token: "m" }, rev: 1, doneAt: null, comments: 0,
});

describe("runLook: every phase", () => {
  it("working: a solid working ring that pulses, a filled dot, and how long", () => {
    expect(runLook(run(), NOW)).toEqual({ ring: "ring-solid ring-working ring-pulse", dot: "dot-fill dot-working", words: "Working · 3m" });
  });
  it("needs you: the warning ring, with its question or without", () => {
    expect(runLook(run({ phase: "needs_you", question: "Ship Friday or Monday?" }), NOW)).toEqual({ ring: "ring-solid ring-warn", dot: "dot-fill dot-warn", words: "Needs you: Ship Friday or Monday?" });
    expect(runLook(run({ phase: "needs_you" }), NOW)?.words).toBe("Needs you");
    expect(runLook(run({ phase: "needs_you", question: "  " }), NOW)?.words).toBe("Needs you");
  });
  it("ended: no ring; what the lane said after the status word, by its outcome; no status line is idle", () => {
    expect(runLook(run({ phase: "ended", outcome: "done", line: "STATUS: DONE. Fix pushed, 54 pass" }), NOW)).toEqual({ ring: null, dot: "dot-fill dot-ink", words: "Said DONE: Fix pushed, 54 pass" });
    expect(runLook(run({ phase: "ended", outcome: "blocked", line: "**STATUS: BLOCKED** needs the token" }), NOW)).toEqual({ ring: null, dot: "dot-fill dot-bad", words: "Said BLOCKED: needs the token" });
    expect(runLook(run({ phase: "ended", outcome: "needs_decision", line: "STATUS: NEEDS DECISION — ship Friday?" }), NOW)).toEqual({ ring: null, dot: "dot-fill dot-warn", words: "Said NEEDS DECISION: ship Friday?" });
    expect(runLook(run({ phase: "ended", outcome: "done", line: "STATUS: DONE" }), NOW)?.words).toBe("Said DONE");
    expect(runLook(run({ phase: "ended", outcome: "no_status", line: "Looked at the logs." }), NOW)).toEqual({ ring: null, dot: "dot-fill dot-idle", words: "Idle" });
    expect(runLook(run({ phase: "ended" }), NOW)?.words).toBe("Idle");
  });
  it("unknown: no ring, the machine is offline", () => {
    expect(runLook(run({ phase: "unknown" }), NOW)).toEqual({ ring: null, dot: "dot-hollow dot-idle", words: "Its machine is offline" });
  });
  it("gone, or no Run: nothing on the card (its \"not running\" chip says gone)", () => {
    expect(runLook(run({ phase: "gone" }), NOW)).toBeNull();     // negative control: drop the gone guard and this is a look
    expect(runLook(null, NOW)).toBeNull();
    expect(runLook(undefined, NOW)).toBeNull();
  });
});

describe("runLook: every wait", () => {
  const waiting = (wait: RunWait, o: Partial<Run> = {}) => run({ phase: "waiting", wait, since: NOW - 6 * MIN, ...o });
  it("background: a dashed working ring, a hollow dot, the first task's label and the rest counted", () => {
    expect(runLook(waiting({ on: "background", tasks: [{ type: "shell", label: "npm test" }] }), NOW)).toEqual({ ring: "ring-dashed ring-working", dot: "dot-hollow dot-working", words: "In the background: npm test · 6m" });
    expect(runLook(waiting({ on: "background", tasks: [{ type: "shell", label: "npm test" }, { type: "agent", label: "review" }, { type: "shell", label: "lint" }] }), NOW)?.words).toBe("In the background: npm test (+2 more) · 6m");
    expect(runLook(waiting({ on: "background", tasks: [] }), NOW)?.words).toBe("In the background · 6m");
  });
  it("job: a dashed working ring, the job by its name", () => {
    expect(runLook(waiting({ on: "job", jobs: [{ id: "j1", name: "e2e" }] }), NOW)).toEqual({ ring: "ring-dashed ring-working", dot: "dot-hollow dot-working", words: "Job e2e running" });
    expect(runLook(waiting({ on: "job", jobs: [{ id: "j1", name: "e2e" }, { id: "j2", name: "lint" }] }), NOW)?.words).toBe("Job e2e running (+1 more)");
  });
  it("wake-up: a dotted muted ring, its fire time on this device's clock, or that one is scheduled", () => {
    const at = new Date(2026, 9, 20, 14, 42).getTime();
    expect(runLook(waiting({ on: "wakeup", next: at }), NOW)).toEqual({ ring: "ring-dotted ring-muted", dot: "dot-hollow dot-muted", words: "Wakes at 14:42" });
    expect(runLook(waiting({ on: "wakeup", next: null }), NOW)?.words).toBe("A wake-up is scheduled");
  });
  it("declared: the warning ring, dashed, and that nothing will wake it (R4)", () => {
    expect(runLook(waiting({ on: "declared", what: "the deploy" }), NOW)).toEqual({ ring: "ring-dashed ring-warn", dot: "dot-hollow dot-warn", words: "Says waiting on the deploy · nothing will wake it" });
    expect(runLook(waiting({ on: "declared", what: null }), NOW)?.words).toBe("Says waiting · nothing will wake it");
  });
  it("overdue (R3): each wait keeps its shape, turns to the warning tone, and says so", () => {
    const late = { overdue: true, since: NOW - 46 * MIN };
    expect(runLook(waiting({ on: "background", tasks: [{ type: "shell", label: "npm test" }] }, late), NOW)).toEqual({ ring: "ring-dashed ring-warn", dot: "dot-hollow dot-warn", words: "In the background: npm test · 46m · overdue" });
    expect(runLook(waiting({ on: "job", jobs: [{ id: "j1", name: "e2e" }] }, late), NOW)).toEqual({ ring: "ring-dashed ring-warn", dot: "dot-hollow dot-warn", words: "Job e2e running · overdue" });
    expect(runLook(waiting({ on: "wakeup", next: NOW - 20 * MIN }, late), NOW)).toEqual({ ring: "ring-dotted ring-warn", dot: "dot-hollow dot-warn", words: `Wakes at ${hhmm(NOW - 20 * MIN)} · overdue` });
    expect(runLook(waiting({ on: "declared", what: "CI" }, late), NOW)?.words).toBe("Says waiting on CI · nothing will wake it · overdue");
    // negative control: the same waits on time have no warning tone and no suffix
    expect(runLook(waiting({ on: "background", tasks: [{ type: "shell", label: "npm test" }] }), NOW)?.ring).toBe("ring-dashed ring-working");
  });
});

describe("the words' pieces", () => {
  it("span: short, never negative (a node's clock a little ahead)", () => {
    expect([span(-5_000), span(30_000), span(3 * MIN), span(65 * MIN), span(120 * MIN), span(50 * 60 * MIN)]).toEqual(["<1m", "<1m", "3m", "1h 5m", "2h", "2d"]);
  });
  it("saidOf: the status word and the rest, as lane events read the line; a line with none is all rest", () => {
    expect(saidOf("STATUS: DONE. Fix pushed")).toEqual({ word: "DONE", rest: "Fix pushed" });
    expect(saidOf("- Status — needs decision: Friday?")).toEqual({ word: "NEEDS DECISION", rest: "Friday?" });
    expect(saidOf("**STATUS: BLOCKED**")).toEqual({ word: "BLOCKED", rest: "" });
    expect(saidOf("All tests pass.")).toEqual({ word: null, rest: "All tests pass." });
  });
});

describe("the header's counts", () => {
  it("counts working lanes, and lanes waiting on their own work (background, a job, a wake-up), not a declared wait", () => {
    const runs = [
      run({ lane: "a" }), run({ lane: "b" }),
      run({ lane: "c", phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "x" }] } }),
      run({ lane: "d", phase: "waiting", wait: { on: "job", jobs: [{ id: "j", name: "e2e" }] }, overdue: true }),
      run({ lane: "e", phase: "waiting", wait: { on: "wakeup", next: null } }),
      run({ lane: "f", phase: "waiting", wait: { on: "declared", what: null } }),     // negative control: not own work
      run({ lane: "g", phase: "needs_you" }), run({ lane: "h", phase: "ended", outcome: "done" }), run({ lane: "i", phase: "gone" }),
    ];
    expect(runCounts(runs)).toEqual({ working: 2, ownWork: 3 });
  });
});

describe("the card a lane's Run shows on", () => {
  const runs = new Map([["builder", run()], ["reviewer", run({ lane: "reviewer" })]]);
  it("its task in progress, never its backlog or done ones", () => {
    const tasks = [task(1, "done", "builder", 50), task(2, "doing", "builder", 10), task(3, "todo", "builder", 40), task(4, "backlog", "builder", 60)];
    expect([...runCards(tasks, runs).keys()]).toEqual(["T-2"]);
  });
  it("else its open task changed last: after D1, the one in review", () => {
    const tasks = [task(3, "todo", "builder", 10), task(5, "review", "builder", 30), task(6, "done", "builder", 90)];
    expect([...runCards(tasks, runs).keys()]).toEqual(["T-5"]);
  });
  it("one card per lane, none for a lane without a Run, none when it has no open task", () => {
    const tasks = [task(1, "doing", "builder"), task(2, "doing", "reviewer"), task(3, "todo", "docs"), task(4, "done", "reviewer", 99), task(5, "todo", null)];
    const on = runCards(tasks, runs);
    expect([...on.keys()].sort()).toEqual(["T-1", "T-2"]);
    expect(on.get("T-2" as Task["key"])?.lane).toBe("reviewer");
    expect(runCards([task(7, "done", "builder")], runs).size).toBe(0);
  });
});

describe("lanes without a task (design §7)", () => {
  it("names the lanes working or waiting with no task in to do, in progress, blocked or review, by name", () => {
    const runs = [
      run({ lane: "zeta" }),
      run({ lane: "alpha", phase: "waiting", wait: { on: "background", tasks: [] } }),
      run({ lane: "builder" }),                                               // has a task in progress
      run({ lane: "docs" }),                                                  // only a done and a backlog task
      run({ lane: "idle", phase: "ended", outcome: "done" }),                 // not at work
      run({ lane: "asks", phase: "needs_you" }),
      run({ lane: "away", phase: "gone" }),
    ];
    const tasks = [task(1, "doing", "builder"), task(2, "done", "docs"), task(3, "backlog", "docs")];
    expect(lanesWithoutTask(runs, tasks).map(r => r.lane)).toEqual(["alpha", "docs", "zeta"]);
    // negative control: a blocked or review task counts as open, so the lane is not listed
    expect(lanesWithoutTask([run({ lane: "docs" })], [task(4, "review", "docs")])).toEqual([]);
    expect(lanesWithoutTask([run({ lane: "docs" })], [task(5, "blocked", "docs")])).toEqual([]);
  });
});
