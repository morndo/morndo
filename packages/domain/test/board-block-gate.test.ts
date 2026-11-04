// A block needs a watched wait (T-805, B21, ADR-0041): a move to blocked by a person or a lane that names no wait and
// asks no decision is refused once the gate is on, accepted with a warning before that, and never gated for the board's
// own moves (D2). A time wait is at most 31 days ahead. D2 carries the wait a status line's next: names (B22). Pure.
import { describe, expect, it } from "vitest";
import {
  DECISION_DUE_MS, applyAction, createTask, derivedMove,
  type BoardActor, type DoneGate, type Run, type Task, type TaskActor,
} from "../src/index.ts";

const NOW = 1_800_000_000_000;
const FROM = Date.parse("2026-11-12T00:00:00Z");              // the instant the gate refuses, unset
const DAY = 24 * 3_600_000;
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
// The gate the hub hands the domain: a mode and the instant it refuses from (B21). Merges and liveness say nothing here.
const gate = (mode: "off" | "warn" | "on"): DoneGate => ({ merges: [], liveness: () => ({ live: true, blockers: [] }), blockGate: { mode, from: FROM } });
// One block by the task's own lane at NOW + 1, judged against `g`.
const block = (t: Task, g: DoneGate | undefined, extra: { reason?: string; waits?: string[]; decision?: boolean } = {}, at = NOW + 1) =>
  applyAction(t, { action: "move", to: "blocked", reason: extra.reason ?? "needs the API key", ...(extra.waits !== undefined ? { waits: extra.waits } : {}), ...(extra.decision !== undefined ? { decision: extra.decision } : {}) }, builder, at, [t], g);
const until = (ms: number, at = NOW + 1) => `until:${new Date(at + ms).toISOString()}`;

describe("a block without a watched wait, once the gate is on (B21)", () => {
  it("a lane's block with no waits and no decision is refused no_wait", () => {
    const r = block(doing(), gate("on"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.problem).toBe("no_wait");
  });
  it("a block naming a time wait goes through and keeps it", () => {
    const { task } = ok(block(doing(), gate("on"), { waits: [until(3_600_000)] }));
    expect(task.waits).toEqual([{ kind: "time", at: NOW + 1 + 3_600_000 }]);
  });
  it("a decision is never gated (B19)", () => {
    const { task } = ok(block(doing(), gate("on"), { decision: true }));
    expect(task.decisionDue).toBe(NOW + 1 + DECISION_DUE_MS);
  });
  it("the board's own D2 block is never gated: accepted, and the event carries no unwatched", () => {
    const t = doing();
    const { task, event } = ok(applyAction(t, { action: "move", to: "blocked", reason: "STATUS: BLOCKED needs the key" }, D2, NOW + 1, [t], gate("on")));
    expect(task.status).toBe("blocked");
    expect("unwatched" in event.change).toBe(false);
  });
  it("restating a decision with no waits goes through, and keeps the deadline it had (B19)", () => {
    const first = ok(block(doing(), gate("on"), { decision: true })).task;
    const again = ok(block(first, gate("on"), { reason: "still needs an answer", decision: true }, NOW + 2));
    expect(again.task.decisionDue).toBe(first.decisionDue);
    expect(again.task.status).toBe("blocked");
  });
  it("restating a blocked task with no waits is refused too; restating with an until goes through", () => {
    const first = ok(block(doing(), gate("on"), { waits: [until(3_600_000)] })).task;
    const again = block(first, gate("on"), { reason: "still needs the API key" }, NOW + 2);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.problem).toBe("no_wait");
    const withWait = ok(block(first, gate("on"), { reason: "still needs the API key", waits: [until(DAY, NOW + 2)] }, NOW + 2));
    expect(withWait.task.waits).toEqual([{ kind: "time", at: NOW + 2 + DAY }]);
  });
});

describe("before the gate refuses, it warns (B21)", () => {
  it("a block of words only is accepted and the moved event says unwatched", () => {
    const t = doing();
    const { task, event } = ok(block(t, gate("warn")));
    expect(task.status).toBe("blocked");
    expect(event.change).toMatchObject({ kind: "moved", from: "doing", to: "blocked", unwatched: true });
  });
  it("a block with a wait is not marked unwatched", () => {
    const { event } = ok(block(doing(), gate("warn"), { waits: [until(3_600_000)] }));
    expect("unwatched" in event.change).toBe(false);
  });
  it("mode off, and no gate at all, behave as before: accepted, no unwatched key", () => {
    const off = ok(block(doing(), gate("off")));
    expect("unwatched" in off.event.change).toBe(false);
    const none = ok(block(doing(), undefined));
    expect("unwatched" in none.event.change).toBe(false);
  });
});

describe("a time wait is at most 31 days ahead (B21)", () => {
  it("31 days is the last instant taken; a minute more, and 40 days, are refused bad_wait saying 31 days", () => {
    const exact = ok(block(doing(), gate("on"), { waits: [until(31 * DAY)] }));
    expect(exact.task.waits).toEqual([{ kind: "time", at: NOW + 1 + 31 * DAY }]);
    for (const ahead of [31 * DAY + 60_000, 40 * DAY]) {
      const r = block(doing(), gate("on"), { waits: [until(ahead)] });
      expect(r.ok, `${ahead} ms ahead`).toBe(false);
      if (!r.ok) {
        expect(r.error.problem, `${ahead} ms ahead`).toBe("bad_wait");
        expect(r.error.detail, `${ahead} ms ahead`).toContain("31 days");
      }
    }
  });
});

describe("D2 carries the wait a status line's next: names (B22)", () => {
  const run = (o: Partial<Run> = {}): Run => ({ lane: "builder", node: "pc", phase: "ended", outcome: "blocked", line: "STATUS: BLOCKED T-1 stuck", deadline: null, overdue: false, since: NOW + 10, source: "status", ...o }) as Run;
  const T = NOW + 2 * DAY;
  it("a blocked outcome whose named status holds a next blocks with an until wait for its by", () => {
    const t = doing();
    expect(derivedMove(t, run(), [t], { key: t.key, status: "blocked", next: { who: "manager", by: T } }))
      .toEqual({ to: "blocked", reason: "STATUS: BLOCKED T-1 stuck", rule: "D2", waits: [`until:${new Date(T).toISOString()}`] });
  });
  it("a needs_decision outcome keeps its decision flag with the wait", () => {
    const t = doing();
    expect(derivedMove(t, run({ outcome: "needs_decision", line: "STATUS: NEEDS DECISION T-1 which db?" }), [t], { key: t.key, status: "needs_decision", next: { who: "manager", by: T } }))
      .toEqual({ to: "blocked", reason: "STATUS: NEEDS DECISION T-1 which db?", rule: "D2", decision: true, waits: [`until:${new Date(T).toISOString()}`] });
  });
  it("no next on the named status: no waits key, as before", () => {
    const t = doing();
    expect(derivedMove(t, run(), [t], { key: t.key, status: "blocked" })).toEqual({ to: "blocked", reason: "STATUS: BLOCKED T-1 stuck", rule: "D2" });
  });
});
