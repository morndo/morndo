// A board that cannot go stale silently (T-805, B19 and B20): a decision a lane asks for opens an inbox item with a 24 h
// deadline, and a task in blocked or review that nobody changed for 48 h with nothing the board watches is listed for the
// manager. Both are pure: the hub reads the tasks, these say what is waiting, and the messages are plain text.
import { describe, expect, it } from "vitest";
import {
  DECISION_DUE_MS, STALE_BLOCK_MS, STALE_LIST_MAX, createTask, answeredOnce, inboxItems, inboxMessage, isAnswered, isDecisionAnswered, staleMessage, staleTasks, watchedKeys,
  type BoardActor, type EndpointId, type JudgedWait, type MergedView, type SessionId, type Task, type TaskActor, type TaskEvent, type TaskKey,
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
  const manager: TaskActor = { kind: "manager", name: "manager", token: "tok-m" };
  const principal: TaskActor = { kind: "principal", endpointId: "e1" as EndpointId, sessionId: "s1" as SessionId };
  const console_: TaskActor = { kind: "console" };
  const lane: TaskActor = { kind: "worker", name: "builder", token: "tok-w" };
  const said = (at: number, actor: TaskActor): TaskEvent => ({ key: "T-1" as TaskKey, rev: 2, at, actor, change: { kind: "commented", text: "go on" } });
  const merged = (at: number, actor: TaskActor): TaskEvent => ({ key: "T-1" as TaskKey, rev: 2, at, actor, change: { kind: "merged", repo: "a/b", sha: "abc1234" } });
  it("a comment by the manager, the principal or the console after the ask answers it", () => {
    expect(isAnswered([said(SINCE + 1, manager)], SINCE)).toBe(true);
    expect(isAnswered([said(SINCE + 1, principal)], SINCE)).toBe(true);
    expect(isAnswered([said(SINCE + 1, console_)], SINCE)).toBe(true);
  });
  it("the lane's own comment, a comment at or before the ask, and a change that is no comment do not", () => {
    expect(isAnswered([said(SINCE + 1, lane)], SINCE)).toBe(false);
    expect(isAnswered([said(SINCE, manager)], SINCE)).toBe(false);
    expect(isAnswered([said(SINCE - 1, manager)], SINCE)).toBe(false);
    expect(isAnswered([merged(SINCE + 1, manager)], SINCE)).toBe(false);
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

// T-863: what the board itself watches, one rule for the hub's sweep and the CLI's stale view.
describe("watchedKeys (T-863)", () => {
  const view = (tasks: Task[], extra: { waits?: { key: string; readings: JudgedWait[] }[]; merged?: MergedView[] } = {}) =>
    ({ tasks, merged: extra.merged ?? [], ...(extra.waits ? { waits: extra.waits } : {}) });
  it("an unanswered decision and a legacy one are watched; an answered one is not", () => {
    const tasks = [decision(1, 5), blocked(2, 5, { blockedReason: "checkpoint: go on?" }), decision(3, 5), blocked(4, 5)];
    const answered = (k: TaskKey) => k === "T-3" || k === "T-2";
    expect([...watchedKeys(view(tasks), NOW, NOW, answered)].sort()).toEqual(["T-1"]);
    expect([...watchedKeys(view(tasks), NOW, NOW)].sort()).toEqual(["T-1", "T-2", "T-3"]);
  });
  it("a wait the hub has read something of, and a review task whose merge is not live yet, are watched", () => {
    const tasks = [blocked(1, 60), blocked(2, 60), review(3, 60), review(4, 60)];
    const w = watchedKeys(view(tasks, {
      waits: [{ key: "T-1", readings: [{ state: "open", label: "x" }] }, { key: "T-2", readings: [{ state: "unknown", label: "y" }] }],
      merged: [{ key: "T-3" as TaskKey, merges: [], live: false, label: "" }, { key: "T-4" as TaskKey, merges: [], live: true, label: "" }],
    }), NOW, NOW);
    expect([...w].sort()).toEqual(["T-1", "T-3"]);
  });
});

describe("staleTasks asks `answered` only of tasks idle long enough to be stale (T-863)", () => {
  it("a decision asked minutes ago is never put to the rule", () => {
    const asked: TaskKey[] = [];
    const answered = (k: TaskKey) => { asked.push(k); return true; };
    const items = staleTasks([decision(1, 60), decision(2, 1)], NOW, { answered });
    expect(items.map(i => i.key)).toEqual(["T-1"]);
    expect(asked).toEqual(["T-1"]);
  });
});

describe("answeredOnce (T-863)", () => {
  it("asks the rule once per task and ask time, and gives the same answer every time", () => {
    const seen: string[] = [];
    const once = answeredOnce((k, since) => { seen.push(`${k}@${since}`); return k === "T-1"; });
    expect([once("T-1" as TaskKey, 5), once("T-1" as TaskKey, 5), once("T-2" as TaskKey, 5), once("T-2" as TaskKey, 5), once("T-1" as TaskKey, 6)]).toEqual([true, true, false, false, true]);
    expect(seen).toEqual(["T-1@5", "T-2@5", "T-1@6"]);
  });
});

// T-863: the cutoff for a decision from before the rule is the task's last move into blocked, read from its events; the
// hub and the CLI both ask this one function.
describe("isDecisionAnswered (T-863)", () => {
  const manager: TaskActor = { kind: "manager", name: "manager", token: "tok-m" };
  const lane: TaskActor = { kind: "worker", name: "builder", token: "tok-w" };
  const ev = (at: number, actor: TaskActor, change: TaskEvent["change"]): TaskEvent => ({ key: "T-1" as TaskKey, rev: 1, at, actor, change });
  const toBlocked = (at: number) => ev(at, lane, { kind: "moved", from: "doing", to: "blocked", reason: "checkpoint: go on?" });
  const word = (at: number) => ev(at, manager, { kind: "commented", text: "go on" });
  const legacy = blocked(1, 10, { blockedReason: "checkpoint: go on?" });
  const due = decision(2, 10);
  const BLOCK = NOW - 10 * HOUR;
  it("a legacy decision is answered only by a comment after its last move into blocked", () => {
    expect(isDecisionAnswered(legacy, [word(BLOCK - HOUR), toBlocked(BLOCK)], 0)).toBe(false);          // the comment came before the block
    expect(isDecisionAnswered(legacy, [toBlocked(BLOCK), word(BLOCK + HOUR)], 0)).toBe(true);
    const again = [toBlocked(BLOCK - 5 * HOUR), word(BLOCK - 4 * HOUR), toBlocked(BLOCK)];
    expect(isDecisionAnswered(legacy, again, 0)).toBe(false);                                           // blocked again after the old answer
  });
  it("the cutoff does not move on a reassign or a description edit after the answer", () => {
    const events = [toBlocked(BLOCK), word(BLOCK + HOUR),
      ev(BLOCK + 2 * HOUR, manager, { kind: "assigned", from: "builder", to: "reviewer" }),
      ev(BLOCK + 3 * HOUR, manager, { kind: "edited", description: "new words" })];
    expect(isDecisionAnswered(legacy, events, 0)).toBe(true);
  });
  it("a legacy decision ignores the ask time it is given (the hub's start); one with a deadline uses it", () => {
    expect(isDecisionAnswered(legacy, [toBlocked(BLOCK), word(BLOCK + HOUR)], NOW)).toBe(true);
    const dueAsk = NOW - 10 * HOUR;
    expect(isDecisionAnswered(due, [word(dueAsk + 1)], dueAsk)).toBe(true);
    expect(isDecisionAnswered(due, [word(dueAsk - 1), toBlocked(dueAsk - 2)], dueAsk)).toBe(false);
  });
  it("a legacy decision whose events hold no move into blocked falls back to the task's creation time, whatever ask time is given", () => {
    expect(isDecisionAnswered(legacy, [word(legacy.createdAt + 1)], NOW)).toBe(true);
    expect(isDecisionAnswered(legacy, [word(legacy.createdAt + 1)], 0)).toBe(true);
    expect(isDecisionAnswered(legacy, [word(legacy.createdAt)], 0)).toBe(false);
    expect(isDecisionAnswered(legacy, [word(legacy.createdAt - 1)], NOW)).toBe(false);
  });
});
