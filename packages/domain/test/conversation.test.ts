import { describe, expect, it } from "vitest";
import { Conversation, Roster, needsYou, workerId, type Message } from "../src/index.ts";

const msg = (id: string, at: number, over: Partial<Message> = {}): Message =>
  ({ id, at, author: { kind: "agent", name: "builder" }, kind: "text", text: id, ...over });

describe("O5: each message once, in time order, capped", () => {
  it("ignores a message it already has and returns only new ones", () => {
    const c = new Conversation(10);
    expect(c.add([msg("a", 1), msg("b", 2)]).map(m => m.id)).toEqual(["a", "b"]);
    expect(c.add([msg("b", 2), msg("c", 3)]).map(m => m.id)).toEqual(["c"]);
    expect(c.latest().map(m => m.id)).toEqual(["a", "b", "c"]);
  });
  it("keeps time order when an entry arrives late", () => {
    const c = new Conversation(10);
    c.add([msg("a", 1), msg("c", 3), msg("b", 2)]);
    expect(c.latest().map(m => m.id)).toEqual(["a", "b", "c"]);
  });
  it("keeps only the latest messages, and forgets dropped IDs (negative control: cap works)", () => {
    const c = new Conversation(2);
    c.add([msg("a", 1), msg("b", 2), msg("c", 3)]);
    expect(c.latest().map(m => m.id)).toEqual(["b", "c"]);
    expect(c.lastAt).toBe(3);
  });
});

describe("O6: needs you while a question is open or a menu shows", () => {
  it("opens on a question and closes on its answer, even if the answer is seen first", () => {
    const c = new Conversation();
    c.add([msg("q1", 1, { kind: "question", questionId: "t1" })]);
    expect(c.openQuestions).toBe(1);
    expect(needsYou({ openQuestions: c.openQuestions, menuOnScreen: false })).toBe(true);
    c.add([{ kind: "answer", id: "r1", at: 2, questionId: "t1" }]);
    expect(c.openQuestions).toBe(0);
    const d = new Conversation();
    d.add([{ kind: "answer", id: "r2", at: 1, questionId: "t2" }, msg("q2", 0, { kind: "question", questionId: "t2" })]);
    expect(d.openQuestions).toBe(0);
  });
  it("a menu on screen alone is enough; nothing open means no", () => {
    expect(needsYou({ openQuestions: 0, menuOnScreen: true })).toBe(true);
    expect(needsYou({ openQuestions: 0, menuOnScreen: false })).toBe(false);
  });
  it("the roster reports title, newest message and needs-you only when they change", () => {
    const r = new Roster(1000);
    r.observeListing([{ id: workerId("%1"), name: "builder", location: "x", node: "local", offline: false }], 0);
    expect(r.observeDetails(workerId("%1"), { title: "Build the login page", lastMessageAt: 5, needsYou: true }).map(e => e.type))
      .toEqual(["WorkerTitled", "WorkerSpoke", "WorkerNeedsYouChanged"]);
    expect(r.observeDetails(workerId("%1"), { title: "Build the login page", lastMessageAt: 4, needsYou: true })).toEqual([]);
    expect(r.observeDetails(workerId("%1"), { needsYou: false }).map(e => e.type)).toEqual(["WorkerNeedsYouChanged"]);
  });
});
