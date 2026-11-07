// A board that cannot go stale silently (T-805, B19 and B20): a decision a lane asks for opens an inbox item with a 24 h
// deadline, and a task in blocked or review that nobody changed for 48 h with nothing the board watches is listed for the
// manager. Both are pure: the hub reads the tasks, these say what is waiting, and the messages are plain text.
import { describe, expect, it } from "vitest";
import {
  DECISION_DUE_MS, STALE_BLOCK_MS, STALE_LIST_MAX, createTask, inboxItems, inboxMessage, isAnswered, staleMessage, staleTasks,
  type BoardActor, type Task, type TaskEvent, type TaskKey,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };

const task = (n: number, o: Partial<Task> = {}): Task => {
  const r = createTask({ title: `Task ${n}`, assignee: "builder" }, manager, n, NOW - 100 * HOUR);
  if (!r.ok) throw new Error(r.error.problem);
  return { ...r.value.task, ...o };
};
const blocked = (n: number, idleHours: number, o: Partial<Task> = {}): Task =>
  task(n, { status: "blocked", blockedReason: "waits on something", stateChangedAt: NOW - idleHours * HOUR, updatedAt: NOW - idleHours * HOUR, ...o });
const review = (n: number, idleHours: number, o: Partial<Task> = {}): Task =>
  task(n, { status: "review", stateChangedAt: NOW - idleHours * HOUR, updatedAt: NOW - idleHours * HOUR, ...o });
const decision = (n: number, askedHoursAgo: number, o: Partial<Task> = {}): Task => {
  const openedAt = NOW - askedHoursAgo * HOUR;
  return blocked(n, askedHoursAgo, { blockedReason: "STATUS: NEEDS DECISION checkpoint: plan", decisionDue: openedAt + DECISION_DUE_MS, ...o });
};
const o = { legacySince: NOW };

describe("the decision inbox (B19)", () => {
  it("a decision is due 24 h after it was asked", () => {
    expect(DECISION_DUE_MS).toBe(24 * HOUR);
    const [item] = inboxItems([decision(1, 5)], NOW, o);
    expect(item).toMatchObject({ key: "T-1", title: "Task 1", assignee: "builder", line: "STATUS: NEEDS DECISION checkpoint: plan", openedAt: NOW - 5 * HOUR, dueAt: NOW + 19 * HOUR, overdue: false, legacy: false });
  });
  it("past its deadline it is overdue; the most overdue comes first", () => {
    const items = inboxItems([decision(1, 5), decision(2, 26), decision(3, 30)], NOW, o);
    expect(items.map(i => [i.key, i.overdue])).toEqual([["T-3", true], ["T-2", true], ["T-1", false]]);
  });
  it("only a blocked task carries one: a task that left blocked has none, even with a stale decisionDue", () => {
    expect(inboxItems([decision(1, 5, { status: "doing" }), decision(2, 5, { status: "review" })], NOW, o)).toEqual([]);
  });
  it("an answer after it was asked closes it, an answer before does not", () => {
    const t = decision(1, 5);
    const seen: [TaskKey, number][] = [];
    expect(inboxItems([t], NOW, { ...o, answered: (k, since) => { seen.push([k, since]); return true; } })).toEqual([]);
    expect(seen).toEqual([["T-1", NOW - 5 * HOUR]]);                      // asked with the moment the item opened
    expect(inboxItems([t], NOW, { ...o, answered: () => false })).toHaveLength(1);
  });
  it("a blocked task from before the rule, whose reason says it needs a decision or is a checkpoint, is an item due 24 h after `legacySince`", () => {
    const a = blocked(1, 100, { blockedReason: "STATUS: NEEDS DECISION T-1 checkpoint: plan" });
    const b = blocked(2, 100, { blockedReason: "checkpoint: step 1 done, go on?" });
    const c = blocked(3, 100, { blockedReason: "waits on the Mac" });
    const items = inboxItems([a, b, c], NOW, { legacySince: NOW - 2 * HOUR });
    expect(items.map(i => i.key)).toEqual(["T-1", "T-2"]);
    expect(items[0]).toMatchObject({ legacy: true, openedAt: NOW - 2 * HOUR, dueAt: NOW + 22 * HOUR, overdue: false });
  });
  it("the message says how many wait, who and what, and how late", () => {
    const text = inboxMessage(inboxItems([decision(1, 5), decision(2, 26)], NOW, o), NOW);
    const lines = text.split("\n");
    expect(lines[0]).toBe("[board-inbox] 2 decisions wait for the manager (1 overdue)");
    expect(lines.slice(1)).toEqual([
      "- T-2 (builder) asked 26 h ago, OVERDUE 2 h: STATUS: NEEDS DECISION checkpoint: plan",
      "- T-1 (builder) asked 5 h ago, due in 19 h: STATUS: NEEDS DECISION checkpoint: plan",
    ]);
  });
  it("one decision reads in the singular; an unassigned task names nobody; a long line is cut", () => {
    const long = "x".repeat(400);
    const text = inboxMessage(inboxItems([decision(1, 1, { assignee: null, blockedReason: long })], NOW, o), NOW);
    const lines = text.split("\n");
    expect(lines[0]).toBe("[board-inbox] 1 decision waits for the manager (0 overdue)");
    expect(lines[1]?.startsWith("- T-1 asked 1 h ago, due in 23 h: ")).toBe(true);
    expect((lines[1] ?? "").length).toBeLessThan(220);
  });
});

describe("the stale sweep (B20)", () => {
  it("is 48 h, the same line as the flag on a block of words only", () => {
    expect(STALE_BLOCK_MS).toBe(48 * HOUR);
  });
  it("lists a blocked or review task nobody changed for 48 h, the longest idle first", () => {
    const items = staleTasks([blocked(1, 50), review(2, 72), blocked(3, 49), review(4, 48)], NOW);
    expect(items.map(i => [i.key, i.status, i.idleMs / HOUR])).toEqual([["T-2", "review", 72], ["T-1", "blocked", 50], ["T-3", "blocked", 49], ["T-4", "review", 48]]);
    expect(items[0]).toMatchObject({ title: "Task 2", assignee: "builder" });
  });
  it("leaves out a task changed within 48 h, whatever it is, and every other status", () => {
    const rest = [blocked(1, 47), review(2, 47), task(3, { status: "todo", updatedAt: NOW - 100 * HOUR }), task(4, { status: "doing", updatedAt: NOW - 100 * HOUR }), task(5, { status: "backlog", updatedAt: NOW - 100 * HOUR }), task(6, { status: "done", updatedAt: NOW - 100 * HOUR, doneAt: NOW - 100 * HOUR })];
    expect(staleTasks(rest, NOW)).toEqual([]);
  });
  it("a comment, a brief or a merge record is a change: the idle time counts from the task's last event, not its last move", () => {
    expect(staleTasks([blocked(1, 100, { updatedAt: NOW - HOUR })], NOW)).toEqual([]);
  });
  it("a task the board watches is not stale: the hub names those (an open wait, a merge not live yet)", () => {
    const tasks = [blocked(1, 60), blocked(2, 60), review(3, 60)];
    expect(staleTasks(tasks, NOW, { watched: new Set(["T-1", "T-3"]) }).map(i => i.key)).toEqual(["T-2"]);
  });
  it("a decision is the inbox's, not the sweep's", () => {
    expect(staleTasks([decision(1, 60), blocked(2, 60)], NOW).map(i => i.key)).toEqual(["T-2"]);
  });
  it("the message lists each task with its status, idle hours, lane and title; a long list is cut and says how many are left", () => {
    const text = staleMessage(staleTasks([blocked(1, 72), review(2, 50, { assignee: null })], NOW));
    expect(text.split("\n")).toEqual([
      "[board-stale] 2 tasks idle 48 h or more with no wait the board watches:",
      "- T-1 blocked 72 h (builder): Task 1",
      "- T-2 review 50 h: Task 2",
    ]);
    expect(staleMessage(staleTasks([blocked(1, 72)], NOW)).split("\n")[0]).toBe("[board-stale] 1 task idle 48 h or more with no wait the board watches:");
    const many = Array.from({ length: STALE_LIST_MAX + 5 }, (_, i) => blocked(i + 1, 60 + i));
    const lines = staleMessage(staleTasks(many, NOW)).split("\n");
    expect(lines).toHaveLength(1 + STALE_LIST_MAX + 1);
    expect(lines.at(-1)).toBe("… and 5 more");
  });
  it("nothing stale says nothing", () => {
    expect(staleMessage([])).toBe("");
    expect(inboxMessage([], NOW)).toBe("");
  });
});

// T-863: one rule for "answered", read by the hub's sweep and by the CLI's inbox and stale views.
describe("isAnswered (T-863)", () => {
  const SINCE = NOW - 10 * HOUR;
  const said = (at: number, actor: TaskEvent["actor"], kind: "commented" | "briefed" = "commented"): TaskEvent =>
    ({ key: "T-1" as TaskKey, rev: 2, at, actor, change: kind === "commented" ? { kind: "commented", text: "go on" } : ({ kind: "unmerged", repo: "a/b", sha: "abc1234" } as never) });
  const lane: TaskEvent["actor"] = { kind: "worker", name: "builder" } as never;
  it("a comment by the manager, the principal or the console after the ask answers it", () => {
    expect(isAnswered([said(SINCE + 1, { kind: "manager", name: "manager" } as never)], SINCE)).toBe(true);
    expect(isAnswered([said(SINCE + 1, { kind: "principal" } as never)], SINCE)).toBe(true);
    expect(isAnswered([said(SINCE + 1, { kind: "console" } as never)], SINCE)).toBe(true);
  });
  it("the lane's own comment, a comment at or before the ask, and a change that is no comment do not", () => {
    expect(isAnswered([said(SINCE + 1, lane)], SINCE)).toBe(false);
    expect(isAnswered([said(SINCE, { kind: "manager", name: "manager" } as never)], SINCE)).toBe(false);
    expect(isAnswered([said(SINCE - 1, { kind: "manager", name: "manager" } as never)], SINCE)).toBe(false);
    expect(isAnswered([said(SINCE + 1, { kind: "manager", name: "manager" } as never, "briefed")], SINCE)).toBe(false);
    expect(isAnswered([], SINCE)).toBe(false);
  });
  it("staleTasks sweeps an answered decision like any block that sits, and keeps an unanswered one out", () => {
    const asked = decision(1, 60);
    const open = decision(2, 60);
    const answered = (k: TaskKey, since: number) => k === "T-1" && since === NOW - 60 * HOUR;
    expect(staleTasks([asked, open], NOW, { answered }).map(i => i.key)).toEqual(["T-1"]);
    expect(staleTasks([asked, open], NOW)).toEqual([]);
    expect(staleTasks([asked], NOW, { answered: () => true, watched: new Set(["T-1"]) })).toEqual([]);
  });
});
