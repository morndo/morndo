// The hub's two watchers for a board that cannot go stale silently (T-805, B19 and B20): the decision inbox sends the
// manager what waits for it, every hour until it is answered or moved, and tells the principal once when one is overdue;
// the stale sweep sends the manager the tasks nobody has touched for 48 h with nothing the board watches. Both send
// through the fleet's delivery port (the lane's name, a text, an id), never type anything themselves. Synthetic times only.
import { describe, expect, it } from "vitest";
import { DECISION_DUE_MS, createTask, type BoardActor, type Task } from "@morndo/domain";
import { BoardInbox, StaleSweep } from "../src/application/board-inbox.ts";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };

const make = (n: number, o: Partial<Task> = {}): Task => {
  const r = createTask({ title: `Task ${n}`, assignee: "builder" }, manager, n, T0 - 100 * HOUR);
  if (!r.ok) throw new Error(r.error.problem);
  return { ...r.value.task, ...o };
};
const asked = (n: number, at: number, o: Partial<Task> = {}): Task =>
  make(n, { status: "blocked", blockedReason: "STATUS: NEEDS DECISION checkpoint: plan", stateChangedAt: at, updatedAt: at, decisionDue: at + DECISION_DUE_MS, ...o });
const idle = (n: number, status: "blocked" | "review", at: number, o: Partial<Task> = {}): Task =>
  make(n, { status, blockedReason: status === "blocked" ? "waits on the Mac" : null, stateChangedAt: at, updatedAt: at, ...o });

type Sent = { id: string; lane: string; text: string };
function rig() {
  const r = { now: T0, tasks: [] as Task[], sent: [] as Sent[], pushed: [] as string[], deliverOk: true as boolean | "throw", logged: [] as string[], answered: new Set<string>(), watched: new Set<string>() };
  const deliver = async (d: Sent & { ttlMs?: number }) => {
    if (r.deliverOk === "throw") throw new Error("the fleet is down");
    if (!r.deliverOk) return false;
    r.sent.push({ id: d.id, lane: d.lane, text: d.text });
    return true;
  };
  const log = { warn: (l: string) => { r.logged.push(l); } };
  const inbox = new BoardInbox({ tasks: () => r.tasks, deliver, push: t => { r.pushed.push(t); }, lane: "manager", now: () => r.now, legacySince: T0, answered: k => r.answered.has(k), log });
  const sweep = new StaleSweep({ tasks: () => r.tasks, watched: () => r.watched, deliver, lane: "manager", now: () => r.now, log });
  return { r, inbox, sweep };
}

describe("the decision inbox", () => {
  it("sends nothing while nothing waits", async () => {
    const { r, inbox } = rig();
    r.tasks = [make(1), idle(2, "blocked", T0 - 100 * HOUR)];
    expect(await inbox.tick()).toEqual({ sent: false, items: 0 });
    expect(r.sent).toEqual([]);
  });
  it("sends ONE message to the manager's lane listing every open decision", async () => {
    const { r, inbox } = rig();
    r.tasks = [asked(1, T0 - 5 * HOUR), asked(2, T0 - 2 * HOUR), asked(3, T0 - HOUR)];
    expect(await inbox.tick()).toEqual({ sent: true, items: 3 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.lane).toBe("manager");
    expect(r.sent[0]?.id.startsWith("board-inbox:")).toBe(true);
    const lines = (r.sent[0]?.text ?? "").split("\n");
    expect(lines[0]).toBe("[board-inbox] 3 decisions wait for the manager (0 overdue)");
    expect(lines.slice(1).map(l => l.slice(0, 6))).toEqual(["- T-1 ", "- T-2 ", "- T-3 "]);
  });
  it("sends again every hour while it waits, each under its own id, and not in between", async () => {
    const { r, inbox } = rig();
    r.tasks = [asked(1, T0 - HOUR)];
    await inbox.tick();
    r.now = T0 + 59 * 60_000;
    expect(await inbox.tick()).toEqual({ sent: false, items: 1 });
    r.now = T0 + HOUR;
    expect(await inbox.tick()).toEqual({ sent: true, items: 1 });
    r.now = T0 + 2 * HOUR;
    await inbox.tick();
    expect(r.sent).toHaveLength(3);
    expect(new Set(r.sent.map(s => s.id)).size).toBe(3);
  });
  it("stops when the task is moved, and when the manager or the principal answers", async () => {
    const { r, inbox } = rig();
    r.tasks = [asked(1, T0 - HOUR), asked(2, T0 - HOUR)];
    await inbox.tick();
    r.now = T0 + HOUR;
    r.tasks = [asked(1, T0 - HOUR, { status: "doing", decisionDue: undefined as never })];   // T-1 moved on
    r.answered.add("T-2");                                                                 // T-2 answered
    expect(await inbox.tick()).toEqual({ sent: false, items: 0 });
    expect(r.sent).toHaveLength(1);
  });
  it("a message that did not go is tried again at the next pass, not an hour later", async () => {
    const { r, inbox } = rig();
    r.tasks = [asked(1, T0 - HOUR)];
    r.deliverOk = false;
    expect(await inbox.tick()).toEqual({ sent: false, items: 1 });
    r.deliverOk = "throw";
    expect(await inbox.tick()).toEqual({ sent: false, items: 1 });
    expect(r.logged.some(l => l.includes("fleet is down"))).toBe(true);
    r.deliverOk = true;
    r.now = T0 + 60_000;
    expect(await inbox.tick()).toEqual({ sent: true, items: 1 });
  });
  it("tells the principal once when a decision is overdue, with the task, and not again", async () => {
    const { r, inbox } = rig();
    r.tasks = [asked(1, T0 - 5 * HOUR), asked(2, T0 - 26 * HOUR)];
    await inbox.tick();
    expect(r.pushed).toHaveLength(1);
    expect(r.pushed[0]).toContain("T-2");
    expect(r.pushed[0]).not.toContain("T-1");
    expect(r.sent[0]?.text.split("\n")[0]).toBe("[board-inbox] 2 decisions wait for the manager (1 overdue)");
    r.now = T0 + HOUR;
    await inbox.tick();
    expect(r.pushed).toHaveLength(1);                           // T-2 is not told twice
    r.now = T0 + 20 * HOUR;                                     // T-1 is now overdue as well: told, alone
    await inbox.tick();
    expect(r.pushed).toHaveLength(2);
    expect(r.pushed[1]).toContain("T-1");
    expect(r.pushed[1]).not.toContain("T-2");
  });
  it("a blocked task from before the rule that says it needs a decision is an item from the hub's start", async () => {
    const { r, inbox } = rig();
    r.tasks = [idle(1, "blocked", T0 - 90 * HOUR, { blockedReason: "STATUS: NEEDS DECISION T-1 checkpoint: plan" })];
    expect(await inbox.tick()).toEqual({ sent: true, items: 1 });
    expect(r.sent[0]?.text).toContain("due in 24 h");
  });
  it("a push that throws does not stop the message to the manager", async () => {
    const { r } = rig();
    const inbox = new BoardInbox({ tasks: () => [asked(1, T0 - 30 * HOUR)], deliver: async d => { r.sent.push(d); return true; }, push: () => { throw new Error("no push service"); }, lane: "manager", now: () => T0, legacySince: T0, log: { warn: l => { r.logged.push(l); } } });
    expect(await inbox.tick()).toEqual({ sent: true, items: 1 });
    expect(r.sent).toHaveLength(1);
  });
});

describe("the stale sweep", () => {
  it("sends nothing while nothing is stale", async () => {
    const { r, sweep } = rig();
    r.tasks = [idle(1, "blocked", T0 - 47 * HOUR), make(2)];
    expect(await sweep.tick()).toEqual({ sent: false, items: 0 });
    expect(r.sent).toEqual([]);
  });
  it("sends ONE message listing the stale tasks to the manager's lane", async () => {
    const { r, sweep } = rig();
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR), idle(2, "review", T0 - 50 * HOUR), idle(3, "blocked", T0 - HOUR)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 2 });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.lane).toBe("manager");
    expect(r.sent[0]?.id.startsWith("board-stale:")).toBe(true);
    expect(r.sent[0]?.text.split("\n")).toEqual([
      "[board-stale] 2 tasks idle 48 h or more with no wait the board watches:",
      "- T-1 blocked 72 h (builder): Task 1",
      "- T-2 review 50 h (builder): Task 2",
    ]);
  });
  it("does not repeat an unchanged list within 12 h, repeats it after, and sends a changed list at once", async () => {
    const { r, sweep } = rig();
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR)];
    await sweep.tick();
    r.now = T0 + 11 * HOUR;
    expect(await sweep.tick()).toEqual({ sent: false, items: 1 });
    r.now = T0 + 12 * HOUR;
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
    r.now = T0 + 13 * HOUR;
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR), idle(2, "review", T0 - 60 * HOUR)];
    expect(await sweep.tick()).toEqual({ sent: true, items: 2 });
    expect(r.sent).toHaveLength(3);
    expect(new Set(r.sent.map(s => s.id)).size).toBe(3);
  });
  it("leaves out what the hub says it watches, and a task that was dealt with drops from the next list", async () => {
    const { r, sweep } = rig();
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR), idle(2, "blocked", T0 - 72 * HOUR)];
    r.watched.add("T-1");
    await sweep.tick();
    expect(r.sent[0]?.text).toContain("- T-2 ");
    expect(r.sent[0]?.text).not.toContain("- T-1 ");
    r.now = T0 + HOUR;
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR)];
    r.watched.clear();
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });      // a different list: sent at once
  });
  it("a decision is not in it: the inbox has it", async () => {
    const { r, sweep } = rig();
    r.tasks = [asked(1, T0 - 60 * HOUR)];
    expect(await sweep.tick()).toEqual({ sent: false, items: 0 });
  });
  it("a message that did not go is tried again at the next pass", async () => {
    const { r, sweep } = rig();
    r.tasks = [idle(1, "blocked", T0 - 72 * HOUR)];
    r.deliverOk = "throw";
    expect(await sweep.tick()).toEqual({ sent: false, items: 1 });
    r.deliverOk = true;
    r.now = T0 + 60_000;
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
  });
});
