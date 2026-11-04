// A block may be a decision (T-805, B19): the move says so, the task keeps a deadline 24 h on while it stays blocked, and
// the board's own D2 move for a NEEDS DECISION status line says so without anyone typing it. Pure.
import { describe, expect, it } from "vitest";
import {
  DECISION_DUE_MS, applyAction, createTask, derivedMove,
  type BoardActor, type Run, type Task, type TaskActor,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const builder: BoardActor = { kind: "worker", name: "builder", token: "tok-w" };
const D2: TaskActor = { kind: "board", rule: "D2", lane: "builder" };

const doing = (): Task => {
  const r = createTask({ title: "Plan it", assignee: "builder" }, manager, 1, NOW);
  if (!r.ok) throw new Error(r.error.problem);
  return { ...r.value.task, status: "doing" };
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const problem = (r: { ok: boolean; error?: unknown }) => (r.ok ? "ok" : (r.error as { problem: string }).problem);
const move = (t: Task, to: Task["status"], by: TaskActor, extra: { decision?: boolean; reason?: string } = {}, at = NOW + 1) =>
  applyAction(t, { action: "move", to, reason: "checkpoint: plan, go on?", ...extra }, by, at, [t]);

describe("a block that is a decision (B19)", () => {
  it("carries a deadline 24 h after the move, on the task and in the event", () => {
    const { task, event } = ok(move(doing(), "blocked", builder, { decision: true }));
    expect(task.decisionDue).toBe(NOW + 1 + DECISION_DUE_MS);
    expect(event.change).toMatchObject({ kind: "moved", from: "doing", to: "blocked", decisionDue: NOW + 1 + DECISION_DUE_MS });
  });
  it("a block that is not one has none", () => {
    const { task, event } = ok(move(doing(), "blocked", builder));
    expect(task.decisionDue).toBeUndefined();
    expect("decisionDue" in event.change).toBe(false);
  });
  it("the manager's own checkpoint counts too", () => {
    const t = { ...doing(), assignee: "manager" };
    expect(ok(move(t, "blocked", manager, { decision: true })).task.decisionDue).toBe(NOW + 1 + DECISION_DUE_MS);
  });
  it("is only a block's word: a decision on any other move is refused", () => {
    expect(problem(move(doing(), "review", builder, { decision: true }))).toBe("bad_wait");
  });
  it("goes when the task leaves blocked, by whoever moves it", () => {
    const blocked = ok(move(doing(), "blocked", builder, { decision: true })).task;
    for (const to of ["doing", "todo"] as const) {
      const left = ok(applyAction(blocked, { action: "move", to }, manager, NOW + 5, [blocked])).task;
      expect(left.decisionDue, to).toBeUndefined();
      expect("decisionDue" in left, to).toBe(false);
    }
  });
  it("restating the block keeps the first deadline; the same restatement changes nothing; turning a plain block into a decision starts the clock", () => {
    const first = ok(move(doing(), "blocked", builder, { decision: true })).task;
    const again = ok(move(first, "blocked", builder, { decision: true, reason: "checkpoint: plan, a second question" }, NOW + 9 * 3_600_000));
    expect(again.task.decisionDue).toBe(first.decisionDue);
    expect(problem(move(first, "blocked", builder, { decision: true }, NOW + 5))).toBe("same");
    const plain = ok(move(doing(), "blocked", builder)).task;
    const upgraded = ok(move(plain, "blocked", builder, { decision: true }, NOW + 7));
    expect(upgraded.task.decisionDue).toBe(NOW + 7 + DECISION_DUE_MS);
  });
  it("a restated block without the flag is no longer a decision", () => {
    const first = ok(move(doing(), "blocked", builder, { decision: true })).task;
    const plain = ok(move(first, "blocked", builder, { reason: "waits on the owner, answered in chat" }, NOW + 9));
    expect(plain.task.decisionDue).toBeUndefined();
  });
});

describe("the board's own D2 move says when it is a decision", () => {
  const run = (o: Partial<Run> = {}): Run => ({ lane: "builder", node: "pc", phase: "ended", outcome: "needs_decision", line: "STATUS: NEEDS DECISION T-1 checkpoint: plan", deadline: null, overdue: false, since: NOW + 10, source: "status", ...o }) as Run;
  it("NEEDS DECISION: decision true", () => {
    expect(derivedMove(doing(), run(), [doing()])).toEqual({ to: "blocked", reason: "STATUS: NEEDS DECISION T-1 checkpoint: plan", rule: "D2", decision: true });
  });
  it("BLOCKED: no decision field at all", () => {
    expect(derivedMove(doing(), run({ outcome: "blocked", line: "STATUS: BLOCKED on the key" }), [doing()])).toEqual({ to: "blocked", reason: "STATUS: BLOCKED on the key", rule: "D2" });
  });
  it("applying it as the board gives the task its deadline", () => {
    const t = doing();
    const m = derivedMove(t, run(), [t]);
    if (m === null) throw new Error("no move");
    const r = ok(applyAction(t, { action: "move", to: m.to, ...(m.reason ? { reason: m.reason } : {}), ...(m.decision ? { decision: true } : {}) }, D2, NOW + 20, [t]));
    expect(r.task.decisionDue).toBe(NOW + 20 + DECISION_DUE_MS);
  });
});
