// The board (ADR-0015; B1–B8 in docs/domain.md): the manager files and hands out tasks, a lane moves its own along the
// work and never to Done, one task in progress per lane, every change an event with provenance and a revision.
import { describe, expect, it } from "vitest";
import {
  DONE_SHOWN_MS, GONE_REASON, TITLE_MAX, applyAction, boardChanged, boardOrder, createTask, derivedMove, endpointId, isOrphan, mayMove, parseTaskKey, sessionId, taskKey, unregisteredMove, workingOn,
  type BoardActor, type Run, type Task, type TaskAction, type TaskActor,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const principal: BoardActor = { kind: "principal", endpointId: endpointId("ep-1"), sessionId: sessionId("s-1") };
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const builder: BoardActor = { kind: "worker", name: "builder", token: "tok-w" };
const reviewer: BoardActor = { kind: "worker", name: "reviewer", token: "tok-w" };

const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
const problem = (r: { ok: boolean; error?: unknown }) => (r.ok ? "ok" : (r.error as { problem: string }).problem);
const make = (n: number, o: Partial<Parameters<typeof createTask>[0]> = {}, by: BoardActor = manager) =>
  value(createTask({ title: `Task ${n}`, ...o }, by, n, NOW)).task;
const apply = (t: Task, a: TaskAction, by: TaskActor, board: Task[] = [t], at = NOW + 1) => applyAction(t, a, by, at, board);

describe("keys (B7)", () => {
  it("T-<n>, never reused: the number is the caller's counter", () => {
    expect(taskKey(12)).toBe("T-12");
    expect(parseTaskKey("T-12")).toBe("T-12");
    for (const bad of ["T-0", "T-012", "t-12", "12", "T-", "T-1234567890"]) expect(parseTaskKey(bad), bad).toBeNull();
  });
});

describe("creating a task", () => {
  it("the manager files a task for a lane: it is to do, with its event and revision 1", () => {
    const { task, event } = value(createTask({ title: "  Build the login  page ", description: "Form plus tests\n", assignee: "builder" }, manager, 1, NOW));
    expect(task).toMatchObject({ key: "T-1", title: "Build the login page", description: "Form plus tests", status: "todo", assignee: "builder", priority: "normal", rev: 1, comments: 0 });
    expect(event).toEqual({ key: "T-1", rev: 1, at: NOW, actor: manager, change: { kind: "created", status: "todo", assignee: "builder" } });
  });
  it("unassigned, it lands in the backlog; the principal may file one straight into progress for a lane", () => {
    expect(make(1).status).toBe("backlog");
    expect(make(2, { assignee: "builder", status: "doing" }, principal).status).toBe("doing");
    expect(problem(createTask({ title: "x", status: "doing" }, manager, 3, NOW))).toBe("needs_assignee");
    expect(problem(createTask({ title: "x", status: "blocked" }, manager, 3, NOW))).toBe("bad_transition");
  });
  it("a worker's task is a proposal (B2): backlog, nobody's, whatever it asked for", () => {
    const t = make(4, { assignee: "builder", status: "doing" }, builder);
    expect(t).toMatchObject({ status: "backlog", assignee: null, createdBy: builder });
  });
  it("one task in progress per lane holds on filing too (B5)", () => {
    const busy = { ...make(1, { assignee: "builder" }), status: "doing" as const };
    expect(createTask({ title: "x", assignee: "builder", status: "doing" }, manager, 2, NOW, [busy])).toEqual({ ok: false, error: { problem: "one_doing", other: "T-1" } });
    expect(value(createTask({ title: "x", assignee: "reviewer", status: "doing" }, manager, 2, NOW, [busy])).task.status).toBe("doing");
  });
  it("a line break of any kind in a title collapses to a space, Windows endings included", () => {
    expect(make(1, { title: "Fix the\r\nlogin\nform" }).title).toBe("Fix the login form");
  });
  it("refuses an empty, too long or control-laden title, and a lane name that isn't one", () => {
    expect(problem(createTask({ title: "   " }, manager, 1, NOW))).toBe("empty");
    expect(problem(createTask({ title: "x".repeat(TITLE_MAX + 1) }, manager, 1, NOW))).toBe("too_long");
    expect(problem(createTask({ title: "a\x1b[31mb" }, manager, 1, NOW))).toBe("bad_text");
    expect(problem(createTask({ title: "x", assignee: "../etc" }, manager, 1, NOW))).toBe("bad_name");
    expect(problem(createTask({ title: "x", assignee: "api lane" }, manager, 1, NOW))).toBe("bad_name");
  });
});

describe("moving a task (B3, B4)", () => {
  it("the assignee takes it up, blocks it with a reason, resumes, offers it for review, and may take it up again", () => {
    let t = make(1, { assignee: "builder" });
    t = value(apply(t, { action: "move", to: "doing" }, builder)).task;
    expect(t.status).toBe("doing");
    expect(problem(apply(t, { action: "move", to: "blocked" }, builder))).toBe("reason_needed");
    t = value(apply(t, { action: "move", to: "blocked", reason: "needs the API key" }, builder)).task;
    expect(t).toMatchObject({ status: "blocked", blockedReason: "needs the API key", rev: 3 });
    t = value(apply(t, { action: "move", to: "doing" }, builder)).task;
    expect(t.blockedReason).toBeNull();
    const r = value(apply(t, { action: "move", to: "review" }, builder));
    expect(r.task.status).toBe("review");
    expect(r.event.change).toEqual({ kind: "moved", from: "doing", to: "review", reason: null });
    expect(value(apply(r.task, { action: "move", to: "doing" }, builder)).task.status).toBe("doing");
  });
  it("a worker never marks Done, and never moves a task that isn't its own", () => {
    const t = value(apply(make(1, { assignee: "builder" }), { action: "move", to: "doing" }, builder)).task;
    const offered = value(apply(t, { action: "move", to: "review" }, builder)).task;
    expect(apply(offered, { action: "move", to: "done" }, builder)).toEqual({ ok: false, error: { problem: "bad_transition", from: "review" } });
    expect(problem(apply(offered, { action: "move", to: "done" }, reviewer))).toBe("not_yours");
    expect(problem(apply(t, { action: "move", to: "review" }, reviewer))).toBe("not_yours");
    expect(mayMove(builder, "review", "done")).toBe(false);
    expect(mayMove(builder, "todo", "review")).toBe(false);
  });
  it("the manager and the principal accept (Done), reopen, or move anything, but nobody moves a task to where it is", () => {
    const offered = { ...make(1, { assignee: "builder" }), status: "review" as const };
    const accepted = value(apply(offered, { action: "move", to: "done", reason: "npm test at 4f2c1e0: 14 passed" }, manager));
    const done = accepted.task;
    expect(done.doneAt).toBe(NOW + 1);
    expect(done.blockedReason).toBeNull();
    expect(accepted.event.change).toEqual({ kind: "moved", from: "review", to: "done", reason: "npm test at 4f2c1e0: 14 passed" });
    const back = value(apply(done, { action: "move", to: "todo" }, principal)).task;
    expect(back.doneAt).toBeNull();
    expect(problem(apply(back, { action: "move", to: "todo" }, manager))).toBe("same");
    expect(mayMove(principal, "backlog", "done")).toBe(true);
  });
  it("the manager's Done names its evidence; the principal's may (B9)", () => {
    const offered = { ...make(1, { assignee: "builder" }), status: "review" as const };
    expect(problem(apply(offered, { action: "move", to: "done" }, manager))).toBe("reason_needed");
    expect(problem(apply(offered, { action: "move", to: "done", reason: "  " }, manager))).toBe("reason_needed");
    const byPrincipal = value(apply(offered, { action: "move", to: "done" }, principal));
    expect(byPrincipal.event.change).toEqual({ kind: "moved", from: "review", to: "done", reason: null });
    expect(value(apply(offered, { action: "move", to: "done", reason: "looked at it" }, principal)).event.change).toMatchObject({ reason: "looked at it" });
    // Other moves keep no reason, as before.
    expect(value(apply(offered, { action: "move", to: "doing", reason: "again" }, manager)).event.change).toMatchObject({ reason: null });
  });
  it("nobody works on an unassigned task", () => {
    expect(problem(apply(make(1), { action: "move", to: "doing" }, manager))).toBe("needs_assignee");
  });
  it("one task in progress per lane (B5): the second is refused, naming the first", () => {
    const first = value(apply(make(1, { assignee: "builder" }), { action: "move", to: "doing" }, builder)).task;
    const second = make(2, { assignee: "builder" });
    const r = apply(second, { action: "move", to: "doing" }, builder, [first, second]);
    expect(r).toEqual({ ok: false, error: { problem: "one_doing", other: "T-1" } });
    expect(problem(apply(second, { action: "move", to: "doing" }, manager, [first, second]))).toBe("one_doing");
    expect(workingOn([first, second], "builder")?.key).toBe("T-1");
    expect(workingOn([first, second], "reviewer")).toBeNull();
    // Another lane's task in progress doesn't count, and a task moving itself doesn't block itself.
    const other = value(apply(make(3, { assignee: "reviewer" }), { action: "move", to: "doing" }, reviewer, [first, second])).task;
    expect(other.status).toBe("doing");
    expect(value(apply({ ...first, status: "blocked", blockedReason: "x" }, { action: "move", to: "doing" }, builder, [{ ...first, status: "blocked" }, second])).task.status).toBe("doing");
  });
});

describe("assigning (B2)", () => {
  it("the manager hands a backlog task to a lane: it becomes theirs to do; a worker may not assign", () => {
    const t = make(1);
    const r = value(apply(t, { action: "assign", to: "builder" }, manager));
    expect(r.task).toMatchObject({ assignee: "builder", status: "todo" });
    expect(r.event.change).toEqual({ kind: "assigned", from: null, to: "builder" });
    expect(problem(apply(t, { action: "assign", to: "builder" }, builder))).toBe("not_allowed");
    expect(problem(apply(r.task, { action: "assign", to: "builder" }, manager))).toBe("same");
    expect(problem(apply(r.task, { action: "assign", to: "bad name" }, manager))).toBe("bad_name");
  });
  it("a task in progress can be handed over, but not to a lane that has one in progress, and never to nobody", () => {
    const doing = { ...make(1, { assignee: "builder" }), status: "doing" as const };
    const busy = { ...make(2, { assignee: "reviewer" }), status: "doing" as const };
    expect(problem(apply(doing, { action: "assign", to: null }, manager))).toBe("needs_assignee");
    expect(apply(doing, { action: "assign", to: "reviewer" }, manager, [doing, busy])).toEqual({ ok: false, error: { problem: "one_doing", other: "T-2" } });
    expect(value(apply(doing, { action: "assign", to: "tester" }, principal, [doing, busy])).task.assignee).toBe("tester");
    expect(value(apply({ ...doing, status: "todo" }, { action: "assign", to: null }, manager)).task.assignee).toBeNull();
  });
});

describe("editing and commenting (B6)", () => {
  it("the manager edits title, description and priority; a change with nothing in it is refused; a worker may not edit", () => {
    const t = make(1);
    const r = value(apply(t, { action: "edit", title: "Better title", priority: "high" }, manager));
    expect(r.task).toMatchObject({ title: "Better title", priority: "high", rev: 2 });
    expect(r.event.change).toEqual({ kind: "edited", title: "Better title", priority: "high" });
    expect(problem(apply(t, { action: "edit", title: t.title }, manager))).toBe("same");
    expect(problem(apply(t, { action: "edit", title: "" }, manager))).toBe("empty");
    expect(problem(apply(t, { action: "edit", description: "x" }, builder))).toBe("not_allowed");
  });
  it("anyone comments; the comment keeps its lines, is counted on the task and is the event's text", () => {
    const t = make(1, { assignee: "builder" });
    const r = value(apply(t, { action: "comment", text: "Ran the tests:\n  14 passed\r\n" }, builder));
    expect(r.task.comments).toBe(1);
    expect(r.event.change).toEqual({ kind: "commented", text: "Ran the tests:\n  14 passed" });
    expect(problem(apply(t, { action: "comment", text: " " }, reviewer))).toBe("empty");
    expect(problem(apply(t, { action: "comment", text: "a\x07b" }, reviewer))).toBe("bad_text");
  });
  it("a change that names the revision it saw is refused once the task moved on (optimistic concurrency)", () => {
    const t = make(1, { assignee: "builder" });
    const moved = value(apply(t, { action: "move", to: "doing", ifRev: 1 }, builder)).task;
    expect(moved.rev).toBe(2);
    expect(problem(apply(moved, { action: "move", to: "review", ifRev: 1 }, builder))).toBe("changed");
    expect(problem(apply(moved, { action: "assign", to: "x", ifRev: 1 }, manager))).toBe("changed");
    expect(value(apply(moved, { action: "move", to: "review", ifRev: 2 }, builder)).task.rev).toBe(3);
  });
  it("the record keeps who changed what, never a comment's words (B6)", () => {
    const t = make(1, { assignee: "builder" });
    const e = value(apply(t, { action: "comment", text: "secret words" }, builder)).event;
    expect(boardChanged(e)).toEqual({ type: "BoardChanged", key: "T-1", change: "commented", at: NOW + 1, actor: { kind: "worker", name: "builder", endpointId: null, token: "tok-w" } });
    const p = value(apply(t, { action: "move", to: "doing" }, principal)).event;
    expect(boardChanged(p).actor).toEqual({ kind: "principal", name: null, endpointId: "ep-1", token: null });
    expect(JSON.stringify(boardChanged(e))).not.toContain("secret");
  });
});

describe("the board's order", () => {
  it("columns in work order; urgent first; waiting work oldest first; work in motion newest first; Done for a week", () => {
    const a = { ...make(1, { assignee: "b" }), createdAt: NOW - 3 };
    const b = { ...make(2, { assignee: "b", priority: "high" }), createdAt: NOW - 1 };
    const c = { ...make(3, { assignee: "b" }), status: "doing" as const, updatedAt: NOW - 5 };
    const d = { ...make(4, { assignee: "c" }), status: "doing" as const, updatedAt: NOW - 2 };
    const old = { ...make(5), status: "done" as const, doneAt: NOW - DONE_SHOWN_MS - 1 };
    const recent = { ...make(6), status: "done" as const, doneAt: NOW - 1000 };
    const newer = { ...make(7), status: "done" as const, doneAt: NOW - 10 };
    expect(boardOrder([newer, old, recent, d, c, a, b], NOW).map(t => t.key)).toEqual(["T-2", "T-1", "T-4", "T-3", "T-7", "T-6"]);
  });
  it("a done task without a time is not shown (negative control: it can't be judged against the week)", () => {
    expect(boardOrder([{ ...make(1), status: "done", doneAt: null }], NOW)).toEqual([]);
  });
});

// B10, D1 to D6 (ADR-0032): the board moves a task by itself, following its assignee's Run, along fixed edges.
describe("the board's own moves (B10, D1 to D6)", () => {
  // A field given as undefined is left out, as a Run without it would be.
  const run = (o: { [K in keyof Run]?: Run[K] | undefined } = {}): Run =>
    JSON.parse(JSON.stringify({ lane: "builder", node: "pc", phase: "ended", outcome: "done", line: "STATUS: DONE: tests pass", deadline: null, overdue: false, since: NOW + 10, source: "status", ...o })) as Run;
  const doing = () => ({ ...make(1, { assignee: "builder" }), status: "doing" as const });
  const boardActor = (lane = "builder", rule: "D1" | "D2" | "D3" | "D4" = "D1"): TaskActor => ({ kind: "board", rule, lane });

  it("D1: in progress to in review when the assignee's run ended DONE, with its status line", () => {
    expect(derivedMove(doing(), run(), [doing()])).toEqual({ to: "review", reason: "STATUS: DONE: tests pass", rule: "D1" });
  });
  it("D2: in progress to blocked on BLOCKED or NEEDS DECISION, with a reason", () => {
    expect(derivedMove(doing(), run({ outcome: "blocked", line: "STATUS: BLOCKED on the API key" }), [doing()])).toMatchObject({ to: "blocked", rule: "D2", reason: "STATUS: BLOCKED on the API key" });
    expect(derivedMove(doing(), run({ outcome: "needs_decision", line: "" }), [doing()])).toMatchObject({ to: "blocked", rule: "D2", reason: "needs_decision" });
  });
  it("D1's reason is one clean line: a control character in the status line is a space, never a refused move", () => {
    const moved = derivedMove(doing(), run({ line: "STATUS: DONE\u001b[0m pushed\ttwice" }), [doing()]);
    expect(moved?.reason).toBe("STATUS: DONE [0m pushed twice");
    expect(apply(doing(), { action: "move", to: "review", reason: moved?.reason ?? "" }, boardActor()).ok).toBe(true);  // negative control: the raw line is refused (bad_text)
  });
  it("D3: in progress to to do when the assignee's lane is gone", () => {
    expect(derivedMove(doing(), run({ phase: "gone", outcome: undefined }), [doing()])).toEqual({ to: "todo", reason: GONE_REASON, rule: "D3" });
  });
  it("D3: in progress to to do when the assignee is not a registered lane, with GONE_REASON; a registered lane, or any other status, moves nothing", () => {
    expect(unregisteredMove(doing(), new Set())).toEqual({ to: "todo", reason: GONE_REASON, rule: "D3" });
    expect(unregisteredMove(doing(), new Set(["builder"]))).toBeNull();
    expect(unregisteredMove({ ...make(2, { assignee: "builder" }), status: "todo" as const }, new Set())).toBeNull();
    expect(unregisteredMove({ ...make(3, { assignee: "builder" }), status: "review" as const }, new Set())).toBeNull();
    expect(unregisteredMove({ ...doing(), assignee: null }, new Set())).toBeNull();
    // The domain takes the move it returns, as the board's own actor (B10: only its assignee's task).
    expect(apply(doing(), { action: "move", to: "todo", reason: GONE_REASON }, boardActor("builder", "D3")).ok).toBe(true);
  });
  it("isOrphan: a to do task whose assignee is not registered; not one in another status, unassigned, or on a registered lane", () => {
    const todo = make(4, { assignee: "builder" });
    expect(isOrphan(todo, new Set())).toBe(true);
    expect(isOrphan(todo, new Set(["builder"]))).toBe(false);
    expect(isOrphan(doing(), new Set())).toBe(false);
    expect(isOrphan({ ...make(5, { assignee: "builder" }), status: "review" as const }, new Set())).toBe(false);
    expect(isOrphan(make(6), new Set())).toBe(false);
  });
  it("D4: the lane's one to do task goes into progress when its run works or waits", () => {
    const todo = make(2, { assignee: "builder" });
    expect(derivedMove(todo, run({ phase: "working", outcome: undefined }), [todo])).toEqual({ to: "doing", reason: null, rule: "D4" });
    expect(derivedMove(todo, run({ phase: "waiting", outcome: undefined, wait: { on: "background", tasks: [] } }), [todo])?.to).toBe("doing");
  });
  it("D4: with a task in review and a new to do, the new one is taken up; two to dos, or one in progress, move nothing", () => {
    const review = { ...make(3, { assignee: "builder" }), status: "review" as const };
    const todo = make(4, { assignee: "builder" });
    const working = run({ phase: "working", outcome: undefined });
    expect(derivedMove(todo, working, [review, todo])?.to).toBe("doing");
    expect(derivedMove(review, working, [review, todo])).toBeNull();
    const other = make(5, { assignee: "builder" });
    expect(derivedMove(todo, working, [todo, other])).toBeNull();               // negative control: ambiguous, nothing moves
    expect(derivedMove(todo, working, [todo, doing()])).toBeNull();             // B5
    expect(derivedMove(review, working, [review])?.to).toBe("doing");           // taken up again
  });
  it("D6: a run whose phase began at or before the task's last change moves nothing", () => {
    const t = { ...doing(), updatedAt: NOW + 10 };
    expect(derivedMove(t, run({ since: NOW + 10 }), [t])).toBeNull();          // negative control: without D6 a person's move is undone
    expect(derivedMove(t, run({ since: NOW + 11 }), [t])?.to).toBe("review");
  });
  it("only the assignee's run counts; an unassigned task never moves", () => {
    expect(derivedMove(doing(), run({ lane: "reviewer" }), [doing()])).toBeNull();
    const nobody = make(6);
    expect(derivedMove(nobody, run({ phase: "working", outcome: undefined }), [nobody])).toBeNull();
  });
  it("D5: the board never moves to done, never assigns or edits, and moves only its assignee's task along its edges", () => {
    const t = doing();
    expect(problem(apply(t, { action: "move", to: "done", reason: "x" }, boardActor()))).toBe("bad_transition");
    expect(problem(apply(t, { action: "assign", to: "reviewer" }, boardActor()))).toBe("not_allowed");
    expect(problem(apply(t, { action: "edit", title: "Renamed" }, boardActor()))).toBe("not_allowed");
    expect(problem(apply(t, { action: "move", to: "review" }, boardActor("reviewer")))).toBe("not_yours");
    expect(problem(apply(make(7), { action: "move", to: "doing" }, boardActor()))).toBe("not_yours");
    expect(mayMove(boardActor(), "backlog", "doing")).toBe(false);
    for (const [from, to] of [["doing", "review"], ["doing", "blocked"], ["doing", "todo"], ["todo", "doing"], ["blocked", "doing"], ["review", "doing"]] as const) {
      expect(mayMove(boardActor(), from, to), `${from}->${to}`).toBe(true);
    }
    const moved = value(apply(t, { action: "move", to: "review", reason: "STATUS: DONE" }, boardActor()));
    expect(moved.event.actor).toEqual({ kind: "board", rule: "D1", lane: "builder" });
    expect(moved.event.change).toMatchObject({ reason: "STATUS: DONE" });           // B10: the record keeps what it read
    expect(boardChanged(moved.event).actor).toEqual({ kind: "board", name: "builder", endpointId: null, token: null, rule: "D1" });
  });
  it("the console runs the board for the principal: it assigns, and its record names it", () => {
    const console: TaskActor = { kind: "console" };
    const t = make(8);
    const assigned = value(apply(t, { action: "assign", to: "builder" }, console));
    expect(assigned.task).toMatchObject({ assignee: "builder", status: "todo" });
    expect(boardChanged(assigned.event).actor).toEqual({ kind: "console", name: null, endpointId: null, token: null });
  });
});
