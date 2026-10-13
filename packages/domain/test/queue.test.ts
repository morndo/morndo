// The queue decision J5 and TX5 share (ADR-0021): one class, at most its limit running, FIFO by acceptance with a
// visible position and a reason, and a guard that delays a start and never stops a run. Pure: no clock, no rows.
import { describe, expect, it } from "vitest";
import { queueDecision, QUEUE_REASONS, type QueueItem } from "../src/queue.ts";

const AT = 1_700_000_000_000;
const item = (id: string, acceptedAt = AT): QueueItem => ({ key: id, acceptedAt });
const slot = (rows: readonly QueueItem[], running: number, limit: number, guard: "off" | "load" | "memory" | "unknown", id: string) =>
  queueDecision(rows, running, limit, guard).get(id) ?? null;

describe("queue decision", () => {
  it("starts as many as the limit leaves free, in the order accepted; the rest wait with a position", () => {
    const rows = [item("c", AT + 2), item("a"), item("b", AT + 1)];
    const decided = queueDecision(rows, 0, 2, "off");
    expect(decided.get("a")).toEqual({ start: true, position: null, reason: null });
    expect(decided.get("b")).toEqual({ start: true, position: null, reason: null });
    expect(decided.get("c")).toEqual({ start: false, position: 1, reason: "class" });
  });
  it("counts what already runs against the limit, and a limit of zero starts nothing", () => {
    expect(slot([item("a")], 1, 1, "off", "a")).toEqual({ start: false, position: 1, reason: "class" });
    expect(slot([item("a"), item("b", AT + 1)], 0, 0, "off", "b")).toEqual({ start: false, position: 2, reason: "class" });
  });
  it("numbers the waiting from 1 however many start", () => {
    const decided = queueDecision([item("a"), item("b", AT + 1), item("c", AT + 2)], 0, 1, "off");
    expect(decided.get("a")).toEqual({ start: true, position: null, reason: null });
    expect(decided.get("b")).toEqual({ start: false, position: 1, reason: "class" });
    expect(decided.get("c")).toEqual({ start: false, position: 2, reason: "class" });
  });
  it("a tie on acceptance is ordered by key", () => {
    const decided = queueDecision([item("z"), item("a"), item("m")], 0, 1, "off");
    expect(decided.get("a")).toEqual({ start: true, position: null, reason: null });
    expect(decided.get("m")).toEqual({ start: false, position: 1, reason: "class" });
    expect(decided.get("z")).toEqual({ start: false, position: 2, reason: "class" });
  });
  it("a guard over the line delays every start, with its own reason, and names none a class full", () => {
    const rows = [item("a"), item("b", AT + 1)];
    for (const guard of ["load", "memory", "unknown"] as const) {
      const decided = queueDecision(rows, 0, 2, guard);
      expect(decided.get("a")).toEqual({ start: false, position: 1, reason: guard === "unknown" ? "guard_unknown" : guard });
      expect(decided.get("b")).toEqual({ start: false, position: 2, reason: guard === "unknown" ? "guard_unknown" : guard });
    }
  });
  it("answers every queued key, and the reasons it names are the queue's own", () => {
    const rows = [item("a"), item("b", AT + 1)];
    const decided = queueDecision(rows, 2, 1, "off");
    expect([...decided.keys()].sort()).toEqual(["a", "b"]);
    for (const s of decided.values()) expect(QUEUE_REASONS).toContain(s.reason);
  });
});
