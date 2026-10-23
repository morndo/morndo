// The board (ADR-0015; B1–B8 in docs/domain.md): the manager files and hands out tasks, a lane moves its own along the
// work and never to Done, one task in progress per lane, every change an event with provenance and a revision.
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_REASON, DONE_SHOWN_MS, GONE_REASON, MAX_MERGES, MORNDO_REPO, PRINCIPAL_NOT_LIVE, PRINCIPAL_PROOF_ACCEPT, TITLE_MAX, applyAction, boardChanged, deriveRun, boardOrder, createTask, derivedMove, endpointId, isOrphan, keyMismatch, livenessOf, mayMove, mergeLabel, mergedView, parseTaskKey, proofOf, sessionId, taskKey, unregisteredMove, workingOn,
  type AncestryAnswer, type BoardActor, type BriefInput, type DoneGate, type Liveness, type MergeRecord, type NodeBuild, type ProofBrief, type ProofGate, type ProofMode, type RefResult, type RefState, type Run, type RunWait, type Task, type TaskAction, type TaskActor,
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
  it("DONE with background work left moves doing to review (D1)", () => {
    const waiting = run({ phase: "waiting", wait: { on: "background", tasks: [{ type: "shell", label: "npm test" }] } });
    expect(derivedMove(doing(), waiting, [doing()])).toEqual({ to: "review", reason: BACKGROUND_REASON, rule: "D1" });
    // a wait that said nothing of DONE, and a wait on something else, still move nothing
    expect(derivedMove(doing(), run({ ...waiting, outcome: undefined }), [doing()])).toBeNull();
    expect(derivedMove(doing(), run({ ...waiting, wait: { on: "declared", what: "CI" } }), [doing()])).toBeNull();
  });
  it("DONE with a wake-up scheduled or a job running moves doing to review (D1) too; BLOCKED there moves nothing", () => {
    const waits: RunWait[] = [{ on: "wakeup", next: NOW + 60_000 }, { on: "job", jobs: [{ id: "j1", name: "ci" }] }];
    for (const wait of waits) {
      const waiting = run({ phase: "waiting", wait, line: "STATUS: DONE T-1 merged afad93fc2, not live until the next release." });
      expect(derivedMove(doing(), waiting, [doing()])).toEqual({ to: "review", reason: "STATUS: DONE T-1 merged afad93fc2, not live until the next release.", rule: "D1" });
      expect(derivedMove(doing(), run({ ...waiting, outcome: undefined }), [doing()])).toBeNull();
      expect(derivedMove(doing(), run({ ...waiting, outcome: "blocked" }), [doing()])).toBeNull();
    }
  });
  it("T-398 R1: a DONE turn with a job pending moves the task though the job started before the task was taken up (derive, then D1)", () => {
    const jobStart = NOW - 60_000;                                    // the job began before the task went in progress at NOW
    const turnEnd = NOW + 5_000;
    const r = deriveRun({
      lane: "builder", node: "pc", nodeOnline: true, windowAlive: true, session: "idle", activity: null, needsInput: null,
      turn: { at: turnEnd, status: "done", line: "STATUS: DONE T-1 merged afad93fc2, not live until the next Morndo release.", tasks: [], wakes: [], waitingOn: null, until: null },
      jobs: [{ id: "j1", name: "ci", startedAt: jobStart }], waitMs: 1_800_000, tzOffsetMin: 0, changedAt: jobStart, now: turnEnd + 1_000,
    });
    expect(r).toMatchObject({ phase: "waiting", wait: { on: "job" }, outcome: "done", since: turnEnd });
    expect(derivedMove(doing(), r, [doing()])).toMatchObject({ to: "review", rule: "D1" });
  });
  it("a comment after the turn end does not stop D1", () => {
    const commented = value(apply(doing(), { action: "comment", text: "pushed, waiting on CI" }, builder, [doing()], NOW + 20)).task;
    expect(commented.updatedAt).toBe(NOW + 20);
    expect(commented.stateChangedAt).toBe(NOW);
    expect(derivedMove(commented, run({ since: NOW + 10 }), [commented])).toMatchObject({ to: "review", rule: "D1" });
  });
  it("a change of status, assignee or description after the turn end does stop it (D6)", () => {
    const retitled = value(apply(doing(), { action: "edit", title: "Renamed", priority: "high" }, manager, [doing()], NOW + 20)).task;
    expect(derivedMove(retitled, run({ since: NOW + 10 }), [retitled])?.to).toBe("review");
    const redescribed = value(apply(doing(), { action: "edit", description: "New scope" }, manager, [doing()], NOW + 20)).task;
    expect(redescribed.stateChangedAt).toBe(NOW + 20);
    expect(derivedMove(redescribed, run({ since: NOW + 10 }), [redescribed])).toBeNull();
    const reassigned = value(apply(doing(), { action: "assign", to: "builder2" }, manager, [doing()], NOW + 20)).task;
    expect(reassigned.stateChangedAt).toBe(NOW + 20);
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
    expect(derivedMove(review, working, [review])).toBeNull();                  // B12: only a keyed WAITING takes it up again (D1)
  });
  it("B12: a keyed DONE moves only the task it names", () => {
    const t1 = doing();
    const t3 = make(3, { assignee: "builder" });
    expect(derivedMove(t1, run(), [t1, t3], { key: t1.key, status: "done" })).toMatchObject({ to: "review", rule: "D1" });
    expect(derivedMove(t1, run(), [t1, t3], { key: taskKey(2), status: "done" })).toBeNull();
    expect(derivedMove(t1, run(), [t1, t3], { key: t3.key, status: "done" })).toBeNull();   // naming a task not in progress moves nothing
  });
  it("B12: a keyed line naming a task of another lane moves nothing and keyMismatch says where to note it", () => {
    const t1 = doing();
    const named = { key: taskKey(50), status: "done" as const };
    expect(derivedMove(t1, run(), [t1], named)).toBeNull();
    const note = keyMismatch(run(), named, [t1]);
    expect(note?.key).toBe("T-1");
    expect(note?.text).toContain("T-50");
    expect(Array.from(note?.text ?? "").some(c => c < " " || c === "\x7f")).toBe(false);   // one clean line
    expect(keyMismatch(run(), named, [make(3, { assignee: "builder" })])?.key).toBe("T-50");     // no task in progress: it goes on the named task, never lost
    expect(keyMismatch(run(), { key: t1.key, status: "done" }, [t1])).toBeNull();                // the lane's own task is no mismatch
    expect(keyMismatch(run({ phase: "working", outcome: undefined }), named, [t1])).toBeNull();  // a working run's line is the last turn's
  });
  it("B12: a mismatch note obeys D6 and the phase gate", () => {
    const named = { key: taskKey(50), status: "done" as const };
    const t1 = { ...doing(), stateChangedAt: NOW + 10 };
    expect(keyMismatch(run({ since: NOW + 10 }), named, [t1])).toBeNull();                       // an ended, stale run: the lane's task changed after it
    expect(keyMismatch(run({ since: NOW + 11 }), named, [t1])?.key).toBe("T-1");
    expect(keyMismatch(run({ phase: "gone", outcome: undefined }), named, [doing()])).toBeNull();
  });
  it("B12: a keyed line counts only as a turn's end or a wait, never while working or gone", () => {
    const todo = make(4, { assignee: "builder" });
    const stale = { key: taskKey(9), status: "done" as const };
    // working: the line is the last turn's, so D4 still takes up the lane's one to do task
    expect(derivedMove(todo, run({ phase: "working", outcome: undefined }), [todo], stale)).toEqual({ to: "doing", reason: null, rule: "D4" });
    // gone: D3 puts the task in progress back to to do whatever the old line named
    expect(derivedMove(doing(), run({ phase: "gone", outcome: undefined }), [doing()], stale)).toMatchObject({ to: "todo", rule: "D3" });
  });
  it("B12: a keyed line on a wait without DONE moves nothing in progress; only a keyed WAITING takes a task up", () => {
    const t1 = doing();
    const review = { ...make(3, { assignee: "builder" }), status: "review" as const };
    const job = run({ phase: "waiting", outcome: undefined, line: "STATUS: DONE T-1", wait: { on: "job", jobs: [{ id: "j1", name: "build" }] } });
    expect(derivedMove(t1, job, [t1], { key: t1.key, status: "done" })).toBeNull();                    // the wait says no outcome: no D1
    expect(derivedMove(review, job, [review], { key: review.key, status: "done" })).toBeNull();        // a keyed DONE is not a WAITING
    expect(derivedMove(review, job, [review], { key: review.key, status: "blocked" })).toBeNull();
    expect(derivedMove(review, job, [review], { key: review.key, status: "waiting" })?.rule).toBe("D1");
  });
  it("B12: a keyed BLOCKED moves only the task it names (D2)", () => {
    const t1 = doing();
    const blocked = run({ outcome: "blocked", line: "STATUS: BLOCKED T-1 needs the API key" });
    expect(derivedMove(t1, blocked, [t1], { key: t1.key, status: "blocked" })).toMatchObject({ to: "blocked", rule: "D2", reason: "STATUS: BLOCKED T-1 needs the API key" });
    expect(derivedMove(t1, blocked, [t1], { key: taskKey(2), status: "blocked" })).toBeNull();
  });
  it("B12: with no key the rule is today's", () => {
    const t1 = doing();
    expect(derivedMove(t1, run(), [t1], null)).toEqual({ to: "review", reason: "STATUS: DONE: tests pass", rule: "D1" });
    expect(derivedMove(t1, run(), [t1])).toEqual(derivedMove(t1, run(), [t1], null));
  });
  it("B12: D4 moves only to do -> doing; a task in review or blocked is left alone", () => {
    const review = { ...make(4, { assignee: "builder" }), status: "review" as const };
    const blocked = { ...make(5, { assignee: "builder" }), status: "blocked" as const, blockedReason: "waits" };
    const working = run({ phase: "working", outcome: undefined });
    expect(derivedMove(review, working, [review])).toBeNull();
    expect(derivedMove(blocked, working, [blocked])).toBeNull();
    const todo = make(6, { assignee: "builder" });
    const other = make(7, { assignee: "builder" });
    expect(derivedMove(todo, working, [todo, other])).toBeNull();                 // negative control: ambiguous, nothing moves
    expect(derivedMove(todo, working, [todo, blocked])?.to).toBe("doing");       // the one to do moves; the blocked one stays
    expect(derivedMove(blocked, working, [todo, blocked])).toBeNull();
  });
  it("B12: a keyed WAITING that names a task in review or blocked takes it into progress (D1)", () => {
    const review = { ...make(3, { assignee: "builder" }), status: "review" as const };
    const blocked = { ...make(4, { assignee: "builder" }), status: "blocked" as const, blockedReason: "waits" };
    const waitingOn = (key: string) => run({ phase: "waiting", outcome: undefined, line: `STATUS: WAITING ${key} on CI`, wait: { on: "declared", what: "CI" } });
    expect(derivedMove(review, waitingOn("T-3"), [review], { key: review.key, status: "waiting" })).toEqual({ to: "doing", reason: "STATUS: WAITING T-3 on CI", rule: "D1" });
    expect(derivedMove(blocked, waitingOn("T-4"), [blocked], { key: blocked.key, status: "waiting" })?.to).toBe("doing");
    expect(derivedMove(review, waitingOn("T-3"), [review, doing()], { key: review.key, status: "waiting" })).toBeNull();  // another task in progress (B5)
    expect(derivedMove(review, waitingOn("T-3"), [review], { key: taskKey(9), status: "waiting" })).toBeNull();           // it names another task
    expect(derivedMove(review, run(), [review], { key: review.key, status: "done" })).toBeNull();                         // a keyed DONE naming a task in review moves nothing
    expect(derivedMove(review, run({ phase: "working", outcome: undefined, line: "STATUS: WAITING T-3 on CI" }), [review], { key: review.key, status: "waiting" })).toBeNull();  // the key is not read while working
  });
  it("D6: a run whose phase began at or before the task's last change moves nothing", () => {
    const t = { ...doing(), stateChangedAt: NOW + 10 };
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

// B11: a task's PR merged is a merge record, and done waits for it to be live: on every enrolled node the merge commit is
// an ancestor of (or equal to) the build the node reports. Unknown fails closed; the manager may accept anyway, saying why.
describe("merged, not live (B11)", () => {
  const SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
  const BUILD = "abc1234deadbeef0123456789abcdef012345678";   // the first 7 the label shows: abc1234
  const OLD = "9999999999999999999999999999999999999999";
  const merge = (o: Partial<MergeRecord> = {}): MergeRecord => ({ repo: MORNDO_REPO, sha: SHA, at: NOW, by: "manager", override: null, ...o });
  const gate = (merges: readonly MergeRecord[], liveness: (sha: string) => Liveness): DoneGate => ({ merges, liveness });
  const act = (t: Task, a: TaskAction, by: TaskActor, g?: DoneGate, board: Task[] = [t]) => applyAction(t, a, by, NOW + 1, board, g);
  const inReview = () => ({ ...make(1, { assignee: "builder" }), status: "review" as const });
  const notLive = (...blockers: { node: string; on: string | null }[]): Liveness => ({ live: false, blockers });
  const boardActor = (lane: string): TaskActor => ({ kind: "board", rule: "D1", lane });

  it("done is refused while the merge is not live", () => {
    const t = inReview();
    const r = act(t, { action: "move", to: "done", reason: "npm test: 14 passed" }, manager, gate([merge()], () => notLive({ node: "pc", on: BUILD })));
    expect(r).toEqual({ ok: false, error: { problem: "not_live", detail: "merged, not live: pc on abc1234" } });
    expect(t.status).toBe("review");                                 // a refusal changes nothing
  });

  it("it becomes live when all nodes report a descendant build", () => {
    const builds: NodeBuild[] = [{ node: "pc", commit: BUILD }, { node: "srv01", commit: OLD }];
    expect(livenessOf(SHA, builds, () => "ancestor")).toEqual({ live: true });
    const behind = livenessOf(SHA, builds, (_m, b): AncestryAnswer => (b === OLD ? "not_ancestor" : "ancestor"));
    expect(behind).toEqual({ live: false, blockers: [{ node: "srv01", on: OLD }] });
    const done = act(inReview(), { action: "move", to: "done", reason: "npm test: 14 passed" }, manager, gate([merge()], () => ({ live: true })));
    expect(value(done).task).toMatchObject({ status: "done" });
  });

  it("done with a not-live reason is accepted and recorded as an override", () => {
    const g = gate([merge()], () => notLive({ node: "pc", on: BUILD }));
    const r = act(inReview(), { action: "move", to: "done", reason: "npm test: 14 passed", notLive: "pc rebuilds overnight" }, manager, g);
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).toMatchObject({ kind: "moved", to: "done", reason: "npm test: 14 passed", notLive: "pc rebuilds overnight" });
    // without a reason for the override there is still no done
    expect(problem(act(inReview(), { action: "move", to: "done", reason: "x", notLive: "  " }, manager, g))).toBe("not_live");
    expect(problem(act(inReview(), { action: "move", to: "done", reason: "x", notLive: "a\x07b" }, manager, g))).toBe("bad_text");
  });

  it("the principal's own accept is never refused: it is recorded as the override", () => {
    const g = gate([merge()], () => notLive({ node: "pc", on: BUILD }));
    const r = act(inReview(), { action: "move", to: "done" }, principal, g);
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).toMatchObject({ kind: "moved", to: "done", notLive: PRINCIPAL_NOT_LIVE });
    // a live merge records nothing
    const live = act(inReview(), { action: "move", to: "done" }, principal, gate([merge()], () => ({ live: true })));
    expect(value(live).event.change).not.toHaveProperty("notLive");
  });

  it("unknown fails closed", () => {
    expect(livenessOf(SHA, [{ node: "pc", commit: null }], () => "ancestor")).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });
    expect(mergeLabel([{ live: false, blockers: [{ node: "pc", on: null }] }])).toBe("merged, not live: pc unknown");
    expect(livenessOf(SHA, [{ node: "pc", commit: BUILD }], () => "unknown")).toEqual({ live: false, blockers: [{ node: "pc", on: null }] });
    expect(livenessOf(SHA, [], () => "ancestor")).toEqual({ live: false, blockers: [] });   // nothing says it is live
    expect(mergeLabel([{ live: false, blockers: [] }])).toBe("merged, not live: no node reports a build");
  });

  it("a merge in another repo leaves done unchanged", () => {
    const never = (): Liveness => { throw new Error("liveness asked of a merge in another repo"); };
    const r = act(inReview(), { action: "move", to: "done", reason: "npm test: 14 passed" }, manager, gate([merge({ repo: "acme/other" })], never));
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).not.toHaveProperty("notLive");
    // no gate, no merges: notLive given anyway is ignored, not recorded
    const noGate = act(inReview(), { action: "move", to: "done", reason: "x", notLive: "ignored" }, manager);
    expect(value(noGate).task.status).toBe("done");
    expect(value(noGate).event.change).not.toHaveProperty("notLive");
    const empty = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, gate([], never));
    expect(value(empty).task.status).toBe("done");
  });

  it("the merged action records a merge event that changes no state; a repeat is the same change", () => {
    const t = make(1, { assignee: "builder" });
    const r = act(t, { action: "merged", sha: SHA.toUpperCase() }, manager);
    expect(value(r).event.change).toEqual({ kind: "merged", repo: MORNDO_REPO, sha: SHA });
    expect(value(r).task).toMatchObject({ rev: 2, stateChangedAt: t.stateChangedAt, updatedAt: NOW + 1, status: "todo" });
    expect(problem(act(value(r).task, { action: "merged", sha: SHA }, manager, gate([merge()], () => notLive())))).toBe("same");
    expect(problem(act(t, { action: "merged", sha: "xyz" }, manager))).toBe("bad_sha");
    expect(problem(act(t, { action: "merged", sha: "abc123" }, manager))).toBe("bad_sha");   // 6 hex
  });

  it("a task holds at most MAX_MERGES merge records, whoever records them; clearing one frees a slot", () => {
    const t = make(1, { assignee: "builder" });
    const held = (n: number) => Array.from({ length: n }, (_, i) => merge({ sha: String(i).repeat(40) }));
    const lane: TaskActor = { kind: "worker", name: "builder", token: "tok-b" };
    expect(MAX_MERGES).toBe(5);
    expect(value(act(t, { action: "merged", sha: "a".repeat(40) }, manager, gate(held(MAX_MERGES - 1), () => notLive()))).event.change).toMatchObject({ kind: "merged" });
    expect(problem(act(t, { action: "merged", sha: "a".repeat(40) }, manager, gate(held(MAX_MERGES), () => notLive())))).toBe("too_many");
    expect(problem(act(t, { action: "merged", sha: "a".repeat(40) }, lane, gate(held(MAX_MERGES), () => notLive())))).toBe("too_many");
    expect(value(act(t, { action: "unmerged", sha: "0".repeat(40) }, manager, gate(held(MAX_MERGES), () => notLive()))).event.change).toMatchObject({ kind: "unmerged" });
  });

  it("a bad repo is refused, and only the board's hands or the task's own lane may record a merge", () => {
    const t = make(1, { assignee: "builder" });
    expect(problem(act(t, { action: "merged", sha: SHA, repo: "not a repo" }, manager))).toBe("bad_repo");
    expect(problem(act(t, { action: "merged", sha: SHA, repo: "a/b/c" }, manager))).toBe("bad_repo");
    expect(problem(act(t, { action: "merged", sha: SHA, repo: "MORNDO/MORNDO" }, manager))).toBe("ok");   // case is the name's own
    // the worker the task is assigned to may record; another lane may not; the board's own actor never does
    expect(value(act(t, { action: "merged", sha: SHA }, builder)).event.change).toMatchObject({ kind: "merged" });
    expect(problem(act(t, { action: "merged", sha: SHA }, reviewer))).toBe("not_yours");
    expect(problem(act(t, { action: "merged", sha: SHA }, boardActor("builder")))).toBe("not_allowed");
  });

  it("a manager or the principal clears a merge record; a worker, the board and a missing record are refused", () => {
    const t = inReview();
    const g = gate([merge()], () => notLive({ node: "pc", on: BUILD }));
    const r = act(t, { action: "unmerged", sha: SHA.toUpperCase() }, manager, g);
    expect(value(r).event.change).toEqual({ kind: "unmerged", repo: MORNDO_REPO, sha: SHA });
    expect(value(r).task).toMatchObject({ rev: t.rev + 1, stateChangedAt: t.stateChangedAt, updatedAt: NOW + 1, status: "review" });
    expect(value(act(t, { action: "unmerged", sha: SHA }, principal, g)).event.change).toMatchObject({ kind: "unmerged" });
    // a lane may not, not even on its own task; the board's own actor never does
    expect(problem(act(t, { action: "unmerged", sha: SHA }, builder, g))).toBe("not_allowed");
    expect(problem(act(t, { action: "unmerged", sha: SHA }, boardActor("builder"), g))).toBe("not_allowed");
    // a record the task doesn't hold, by sha or by repo (the repo matches without regard to case)
    expect(problem(act(t, { action: "unmerged", sha: "1234567890123456789012345678901234567890" }, manager, g))).toBe("no_merge");
    expect(problem(act(t, { action: "unmerged", sha: SHA, repo: "acme/other" }, manager, g))).toBe("no_merge");
    expect(value(act(t, { action: "unmerged", sha: SHA, repo: "MORNDO/MORNDO" }, manager, g)).event.change).toMatchObject({ kind: "unmerged" });
    // a wrong sha or repo name, and nothing to clear with no gate at all
    expect(problem(act(t, { action: "unmerged", sha: "xyz" }, manager, g))).toBe("bad_sha");
    expect(problem(act(t, { action: "unmerged", sha: SHA, repo: "not a repo" }, manager, g))).toBe("bad_repo");
    expect(problem(act(t, { action: "unmerged", sha: SHA }, manager))).toBe("no_merge");
  });

  it("mergeLabel and mergedView: the one-line label, and live null for merges in other repos", () => {
    expect(mergeLabel([{ live: true }])).toBe("merged, live");
    expect(mergeLabel([{ live: true }, notLive({ node: "pc", on: BUILD }, { node: "srv01", on: null })]))
      .toBe("merged, not live: pc on abc1234, srv01 unknown");
    // several merges: the union per node, the first blocker seen for a node wins
    expect(mergeLabel([notLive({ node: "pc", on: BUILD }), notLive({ node: "pc", on: null }, { node: "srv01", on: OLD })]))
      .toBe("merged, not live: pc on abc1234, srv01 on 9999999");
    const behind = notLive({ node: "pc", on: BUILD });
    const view = mergedView(taskKey(1), [merge(), merge({ repo: "acme/other", sha: "1234567" })], () => behind);
    expect(view).toEqual({ key: "T-1", merges: [merge(), merge({ repo: "acme/other", sha: "1234567" })], live: false, label: "merged, not live: pc on abc1234" });
    const never = (): Liveness => { throw new Error("liveness asked of a merge in another repo"); };
    const otherOnly = mergedView(taskKey(2), [merge({ repo: "acme/other" }), merge({ repo: "yet/another" })], never);
    expect(otherOnly.live).toBeNull();
    expect(otherOnly.label).toBe("merged in acme/other");
    // every morndo merge must be live, and the repo matches without regard to case
    const twice = mergedView(taskKey(3), [merge({ sha: "1111111111111111111111111111111111111111" }), merge({ repo: "Morndo/Morndo", sha: "2222222222222222222222222222222222222222" })],
      sha => (sha.startsWith("1") ? { live: true } : notLive({ node: "srv01", on: BUILD })));
    expect(twice.live).toBe(false);
    expect(twice.label).toBe("merged, not live: srv01 on abc1234");
    expect(mergedView(taskKey(4), [merge()], () => ({ live: true }))).toMatchObject({ live: true, label: "merged, live" });
  });
});

// B13 to B16 (ADR-0035): the brief is the assignee's word, its own action that changes no state; its references are
// judged against results the gate holds, never against the lane's say-so; the Done waits for them, mode by mode, and
// an override (the manager's reason, the principal's click) is recorded in the event with what the board saw.
describe("brief and proof (B13 to B16)", () => {
  const PR = "acme/shop#42@3e9d1a7";
  const LINE = `proof: 0 of 1 green · ✗ ${PR} lint`;              // one red ref: the gate's own line
  const brief = (o: Partial<ProofBrief> = {}): ProofBrief => ({ summary: "Totals row rounds to cents", decisions: "", leftOut: "nothing", limits: "none known", refs: [PR], attested: [], noCode: "", ...o });
  const filed: BriefInput = { summary: "Rounds the totals row to cents", leftOut: "nothing", limits: "none known" };
  const seen = (ref: string, state: RefState, detail: string | null = null): RefResult => ({ ref, state, detail, checkedAt: NOW + 5 });
  const proof = (o: Partial<ProofGate> = {}): ProofGate => ({ mode: "on", brief: brief(), results: [seen(PR, "red", "lint")], ...o });
  const gate = (p: ProofGate): DoneGate => ({ merges: [], liveness: (): Liveness => { throw new Error("no merge to judge"); }, proof: p });
  const act = (t: Task, a: TaskAction, by: TaskActor, g?: DoneGate, board: Task[] = [t]) => applyAction(t, a, by, NOW + 1, board, g);
  const inReview = () => ({ ...make(1, { assignee: "builder" }), status: "review" as const });
  const boardActor = (lane = "builder"): TaskActor => ({ kind: "board", rule: "D1", lane });

  it("a done with a red ref is refused as proof_not_green naming the ref", () => {
    expect(act(inReview(), { action: "move", to: "done", reason: "npm test: 14 passed" }, manager, gate(proof())))
      .toEqual({ ok: false, error: { problem: "proof_not_green", detail: LINE } });
  });

  it("a done with no brief is refused in on mode and accepted in warn mode with proofSeen", () => {
    const none = (mode: ProofMode): DoneGate => gate({ mode, brief: null, results: [] });
    expect(act(inReview(), { action: "move", to: "done", reason: "x" }, manager, none("on")))
      .toEqual({ ok: false, error: { problem: "proof_not_green", detail: "proof: no brief" } });
    const warned = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, none("warn"));
    expect(value(warned).task.status).toBe("done");
    expect(value(warned).event.change).toMatchObject({ kind: "moved", to: "done", proofSeen: "proof: no brief" });
  });

  it("the principal's accept is recorded as the override", () => {
    const r = act(inReview(), { action: "move", to: "done" }, principal, gate(proof()));
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).toMatchObject({ kind: "moved", to: "done", proofSeen: `${LINE}; ${PRINCIPAL_PROOF_ACCEPT}` });
  });

  it("the manager's override reason is recorded in the done event", () => {
    const r = act(inReview(), { action: "move", to: "done", reason: "x", proofOverride: "flaky lint, rerun queued" }, manager, gate(proof()));
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).toMatchObject({ kind: "moved", to: "done", proofSeen: `${LINE}; override: flaky lint, rerun queued` });
    // an override that is not one clean line is refused as such, and one that says nothing is no override
    expect(problem(act(inReview(), { action: "move", to: "done", reason: "x", proofOverride: "a\u0007b" }, manager, gate(proof())))).toBe("bad_text");
    expect(problem(act(inReview(), { action: "move", to: "done", reason: "x", proofOverride: "  " }, manager, gate(proof())))).toBe("proof_not_green");
  });

  it("the board's D1 move to review is made with no brief and the card says no brief", () => {
    const run: Run = { lane: "builder", node: "pc", phase: "ended", outcome: "done", line: "STATUS: DONE T-1", deadline: null, overdue: false, since: NOW + 10, source: "status" };
    const t = { ...make(1, { assignee: "builder" }), status: "doing" as const };
    expect(derivedMove(t, run, [t])).toMatchObject({ to: "review", rule: "D1" });   // the board's own move cannot be refused for want of a brief
    expect(act(t, { action: "move", to: "review", reason: "STATUS: DONE T-1" }, boardActor(), gate(proof({ brief: null }))).ok).toBe(true);
    expect(proofOf(null, [])).toEqual({ kind: "no_brief", green: 0, total: 0, accepts: false, line: "proof: no brief" });
  });

  it("a brief filed by the board actor is refused", () => {
    expect(act(inReview(), { action: "brief", brief: filed }, boardActor())).toEqual({ ok: false, error: { problem: "not_allowed" } });
  });

  it("the same red done is accepted when the proof gate is off or absent (negative control)", () => {
    const off = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, gate(proof({ mode: "off" })));
    expect(value(off).task.status).toBe("done");
    expect(value(off).event.change).not.toHaveProperty("proofSeen");
    const absent = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, { merges: [], liveness: (): Liveness => { throw new Error("no merge to judge"); } });
    expect(value(absent).task.status).toBe("done");
    expect(value(absent).event.change).not.toHaveProperty("proofSeen");
  });

  it("a worker files a brief on its own task in doing or review, not on another's, not on a task in todo", () => {
    const doing = { ...make(1, { assignee: "builder" }), status: "doing" as const };
    const r = act(doing, { action: "brief", brief: filed }, builder);
    expect(value(r).event.change).toEqual({ kind: "briefed", brief: { summary: "Rounds the totals row to cents", decisions: "", leftOut: "nothing", limits: "none known", refs: [], attested: [], noCode: "" } });
    const review = value(apply(doing, { action: "move", to: "review" }, builder)).task;
    expect(act(review, { action: "brief", brief: filed }, builder).ok).toBe(true);
    expect(problem(act(doing, { action: "brief", brief: filed }, reviewer))).toBe("not_yours");
    expect(act(make(2, { assignee: "builder" }), { action: "brief", brief: filed }, builder)).toEqual({ ok: false, error: { problem: "bad_transition", from: "todo" } });
    // the board's hands file too (B13)
    expect(act(doing, { action: "brief", brief: filed }, manager).ok).toBe(true);
    expect(act(doing, { action: "brief", brief: filed }, principal).ok).toBe(true);
  });

  it("a brief changes no state: stateChangedAt and status stay, rev grows by one", () => {
    const doing = { ...make(1, { assignee: "builder" }), status: "doing" as const };
    const r = act(doing, { action: "brief", brief: filed }, builder);
    expect(value(r).task).toMatchObject({ rev: doing.rev + 1, status: "doing", stateChangedAt: doing.stateChangedAt, updatedAt: NOW + 1 });
  });

  it("a verified done records proofSeen and is accepted in every mode", () => {
    for (const mode of ["warn", "on"] as const) {
      const r = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, gate(proof({ mode, results: [seen(PR, "green")] })));
      expect(value(r).task.status, mode).toBe("done");
      expect(value(r).event.change, mode).toMatchObject({ kind: "moved", to: "done", proofSeen: "proof: 1 of 1 green" });
    }
    expect(value(act(inReview(), { action: "move", to: "done", reason: "x" }, principal, gate(proof({ mode: "on", results: [seen(PR, "green")] })))).event.change)
      .toMatchObject({ proofSeen: "proof: 1 of 1 green" });
  });

  it("a done with a ref that was not checked is refused in on mode and recorded in warn mode", () => {
    const NOTE = "private repo: not checked (404 without a token)";
    const unchecked = (mode: ProofMode): DoneGate => gate(proof({ mode, results: [seen(PR, "not_checked", NOTE)] }));
    const line = `proof: 0 of 1 green · ○ ${PR} ${NOTE}`;
    expect(act(inReview(), { action: "move", to: "done", reason: "x" }, manager, unchecked("on")))
      .toEqual({ ok: false, error: { problem: "proof_not_green", detail: line } });
    expect(value(act(inReview(), { action: "move", to: "done", reason: "x" }, manager, unchecked("warn"))).event.change).toMatchObject({ proofSeen: line });
    expect(value(act(inReview(), { action: "move", to: "done", reason: "x", proofOverride: "private repo, checked by hand" }, manager, unchecked("on"))).event.change)
      .toMatchObject({ proofSeen: `${line}; override: private repo, checked by hand` });
  });

  it("with mode off the done carries no proofSeen", () => {
    const r = act(inReview(), { action: "move", to: "done", reason: "x" }, manager, gate(proof({ mode: "off" })));
    expect(value(r).task.status).toBe("done");
    expect(value(r).event.change).not.toHaveProperty("proofSeen");
  });
});
