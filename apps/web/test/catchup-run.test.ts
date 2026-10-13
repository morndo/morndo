// One catch-up run (ADR-0009): the order holds, a decision is never marked read, Undo inside the 5-second window sends
// nothing, "later" and "keep unread" stay on the device, fresh cards join without moving the one on top, and the counts
// the end screen shows are what he did.
import { describe, expect, it } from "vitest";
import type { Card } from "@morndo/domain";
import {
  LATE_ANSWER_MS, UNDO_MS, answerFailed, answerNow, answered, bringToTop, counts, moveOn, current, dueAnswer, dueMarks, end, ended, inWindow, markAllRead, markRead, newRun, parseRun,
  refresh, segments, setAside, startAnswer, undo, undoable,
} from "../src/lib/catchup/run.ts";

const dec = (id: string, o: Partial<Extract<Card, { kind: "decision" }>> = {}): Card => ({ kind: "decision", key: `d:${id}`, id, blocking: false, due: null, askedAt: 1, ...o });
const upd = (name: string, lastAt = 100, o: Partial<Extract<Card, { kind: "update" }>> = {}): Card => ({ kind: "update", key: `u:${name}`, worker: `%${name}`, conversation: name, needsYou: false, claim: null, lastAt, ...o });
const T = 1_000_000;

describe("a run", () => {
  it("shows the cards in order and ends after the last", () => {
    let r = newRun([dec("a"), upd("builder")], T);
    expect(current(r)?.key).toBe("d:a");
    r = setAside(r, "d:a");
    expect(current(r)?.key).toBe("u:builder");
    r = markRead(r, { key: "u:builder", conversation: "builder", at: 100 }, T);
    expect(current(r)).toBeNull();
    expect(ended(r)).toBe(true);
    expect(end(r, T + 60_000).endedAt).toBe(T + 60_000);
  });
  it("a decision can't be marked read (C1): nothing changes", () => {
    const r = newRun([dec("a")], T);
    expect(markRead(r, { key: "d:a", conversation: "manager", at: 1 }, T)).toBe(r);
    expect(markAllRead(r, [{ key: "d:a", conversation: "manager", at: 1 }], T)).toBe(r);
  });
  it("a read mark goes only when its window closes; Undo inside it brings the card back and sends nothing", () => {
    let r = newRun([upd("builder"), upd("reviewer")], T);
    r = markRead(r, { key: "u:builder", conversation: "builder", at: 100 }, T);
    expect(current(r)?.key).toBe("u:reviewer");
    expect(dueMarks(r, T + UNDO_MS - 1).send).toEqual([]);
    expect(undoable(r, T + 4000)).toBe(true);
    r = undo(r, T + 4000);
    expect(current(r)?.key).toBe("u:builder");
    expect(dueMarks(r, T + 60_000).send).toEqual([]);
  });
  it("after the window the mark goes once, and Undo can't take it back", () => {
    let r = markRead(newRun([upd("builder")], T), { key: "u:builder", conversation: "builder", at: 100 }, T);
    const due = dueMarks(r, T + UNDO_MS);
    expect(due.send).toEqual([{ key: "u:builder", conversation: "builder", at: 100 }]);
    r = due.run;
    expect(dueMarks(r, T + UNDO_MS + 1).send).toEqual([]);
    expect(undoable(r, T + UNDO_MS)).toBe(false);
    expect(undo(r, T + UNDO_MS)).toBe(r);
  });
  it("leaving sends every mark still in its window", () => {
    const r = markRead(newRun([upd("builder")], T), { key: "u:builder", conversation: "builder", at: 100 }, T);
    expect(dueMarks(r, T, true).send).toHaveLength(1);
  });
  it("an answer waits out its window; Undo inside it cancels it, and the card shows its options again", () => {
    let r = newRun([dec("ny-7"), upd("builder")], T);
    r = startAnswer(r, "d:ny-7", "ny-7", { key: "ship" }, "Ship it", T);
    expect(current(r)?.key).toBe("d:ny-7");
    expect(dueAnswer(r, T + 4999).send).toBeNull();
    r = undo(r, T + 3000);
    expect(r.answering).toBeNull();
    expect(dueAnswer(r, T + 10_000).send).toBeNull();
    expect(current(r)?.key).toBe("d:ny-7");
  });
  it("an answer is handed out once when due; taken, the next card comes; refused, the card stays", () => {
    let r = startAnswer(newRun([dec("ny-7"), upd("builder")], T), "d:ny-7", "ny-7", { key: "ship" }, "Ship it", T);
    const d = dueAnswer(r, T + UNDO_MS);
    expect(d.send).toMatchObject({ id: "ny-7", body: { key: "ship" }, label: "Ship it" });
    r = d.run;
    expect(dueAnswer(r, T + UNDO_MS + 1).send).toBeNull();            // sending already
    expect(undoable(r, T + UNDO_MS)).toBe(false);
    expect(current(answered(r, "d:ny-7"))?.key).toBe("u:builder");
    const refused = answerFailed(r);
    expect(current(refused)?.key).toBe("d:ny-7");
    expect(refused.answering).toBeNull();
    expect(undoable(answered(r, "d:ny-7"), T + UNDO_MS)).toBe(false);   // a sent answer can't come back
  });
  it("later and keep unread can be undone; they stay in this run's memory only", () => {
    let r = newRun([dec("a"), upd("b")], T);
    r = setAside(r, "d:a");
    r = setAside(r, "u:b");
    expect(r.done).toEqual({ "d:a": "later", "u:b": "kept" });
    r = undo(r, T + 99_999);
    expect(current(r)?.key).toBe("u:b");
    r = undo(r, T + 99_999);
    expect(current(r)?.key).toBe("d:a");
  });
  it("mark all read takes every update left, the one on top too, and leaves the decisions", () => {
    let r = newRun([dec("a"), upd("b"), upd("c")], T);
    r = markAllRead(r, [{ key: "u:b", conversation: "b", at: 1 }, { key: "u:c", conversation: "c", at: 2 }, { key: "d:a", conversation: "x", at: 3 }], T);
    expect(r.done).toEqual({ "u:b": "read", "u:c": "read" });
    expect(current(r)?.key).toBe("d:a");
    expect(undo(r, T + 100).done).toEqual({});
    expect(dueMarks(r, T + UNDO_MS).send.map(m => m.conversation)).toEqual(["b", "c"]);
  });
  it("fresh cards join what is to come by the order's rule; the card on top and what he passed don't move", () => {
    let r = newRun([dec("a"), upd("b", 100)], T);
    r = setAside(r, "d:a");                                           // passed; b on top
    r = refresh(r, [dec("a"), upd("b", 100), upd("c", 300), dec("z", { blocking: true }), upd("d", 900)]);
    expect(r.order).toEqual(["d:a", "u:b", "d:z", "u:d", "u:c"]);
    expect(current(r)?.key).toBe("u:b");
    r = refresh(r, [dec("a"), upd("d", 900)]);                        // b read elsewhere (on top: stays), z settled, c read
    expect(r.order).toEqual(["d:a", "u:b", "u:d"]);
  });
  it("counts what is left and what he did; segments outline decisions until done", () => {
    let r = newRun([dec("a"), dec("b"), upd("c"), upd("d"), upd("e")], T);
    r = answered(startAnswer(r, "d:a", "a", { key: "x" }, "X", T), "d:a");
    r = setAside(r, "d:b");
    r = markRead(r, { key: "u:c", conversation: "c", at: 1 }, T);
    r = setAside(r, "u:d");
    expect(counts(r)).toEqual({ left: 1, decisionsLeft: 0, updatesLeft: 1, decisionsInRun: 2, decided: 1, read: 1, kept: 1, later: 1 });
    expect(segments(r).map(s => `${s.decision ? "D" : "u"}:${s.state}`)).toEqual(["D:done", "D:done", "u:done", "u:done", "u:now"]);
  });
  it("is read back from the device as written, without a half-sent answer; anything else is no run", () => {
    const r = startAnswer(newRun([dec("a")], T), "d:a", "a", { key: "x" }, "X", T);
    const back = parseRun(JSON.parse(JSON.stringify(r)));
    expect(back?.order).toEqual(["d:a"]);
    expect(back?.answering).toBeNull();
    expect(parseRun({ startedAt: "x" })).toBeNull();
    expect(parseRun(null)).toBeNull();
  });
  it("decide now brings a decision on top, back from later or new to the run; moving past a closed card counts nowhere", () => {
    let r = newRun([dec("a"), upd("b"), upd("c")], T);
    r = setAside(r, "d:a");
    r = setAside(r, "u:b");
    r = bringToTop(r, dec("a"));
    expect(current(r)?.key).toBe("d:a");
    expect(r.order).toEqual(["u:b", "d:a", "u:c"]);
    r = bringToTop(r, dec("new"));
    expect(current(r)?.key).toBe("d:new");
    r = moveOn(r, "d:new");
    expect(current(r)?.key).toBe("d:a");
    expect(counts(r)).toMatchObject({ decided: 0, later: 0, kept: 1 });
  });
  it("leaving sends an answer in its window now; an answer found long past its window (the phone slept) is dropped, not sent", () => {
    const r = startAnswer(newRun([dec("a")], T), "d:a", "a", { key: "x" }, "X", T);
    expect(inWindow(r.answering, T + 1000)).toBe(true);
    expect(inWindow({ sending: true, commitAt: T }, T + UNDO_MS)).toBe(true);
    expect(inWindow(null, T)).toBe(false);
    expect(inWindow(r.answering, T + UNDO_MS)).toBe(false);
    expect(dueAnswer(answerNow(r, T + 1000), T + 1000).send?.id).toBe("a");
    expect(answerNow(r, T + 6000)).toBe(r);                                     // already due: unchanged
    const late = dueAnswer(r, T + UNDO_MS + LATE_ANSWER_MS + 1);
    expect(late.send).toBeNull();
    expect(late.late?.id).toBe("a");
    expect(late.run.answering).toBeNull();
    expect(current(late.run)?.key).toBe("d:a");                                // the card stays, open
  });
  it("a card whose answer is in its window can't be set aside (review): Undo first, or let it go", () => {
    const r = startAnswer(newRun([dec("a"), dec("b")], T), "d:a", "a", { key: "x" }, "X", T);
    expect(setAside(r, "d:a")).toBe(r);
    expect(current(setAside(r, "d:a"))?.key).toBe("d:a");
  });
  // Review of PR #7, finding 2: a card passed in this run comes back when it qualifies again with something new.
  it("an update read in this run comes back when its agent speaks again; read again without news, it doesn't", () => {
    let r = newRun([upd("b", 100), upd("c", 100)], T);
    r = markRead(r, { key: "u:b", conversation: "b", at: 100 }, T);
    r = refresh(r, [upd("b", 100), upd("c", 100)]);                     // read elsewhere not yet: nothing new
    expect(r.order).toEqual(["u:b", "u:c"]);
    r = refresh(r, [upd("b", 250), upd("c", 100)]);                     // b spoke again
    expect(r.order).toHaveLength(3);
    const again = r.order[2] ?? "";
    expect(again).not.toBe("u:b");
    expect(r.cards[again]).toMatchObject({ kind: "update", conversation: "b", lastAt: 250 });
    r = setAside(r, "u:c");
    expect(current(r)?.key).toBe(again);
    expect(counts(r)).toMatchObject({ read: 1, kept: 1, left: 1 });
  });
  it("a decision passed in this run comes back when it is asked again, or reopened after it closed; kept for later, it stays out", () => {
    let r = newRun([dec("menu-3", { askedAt: 10 }), dec("ny-1", { askedAt: 5 }), upd("x")], T);
    r = moveOn(r, "d:menu-3");                                           // settled at the desk, he moved on
    r = setAside(r, "d:ny-1");                                           // later
    r = refresh(r, [dec("menu-3", { askedAt: 10 }), dec("ny-1", { askedAt: 5 }), upd("x")]);
    expect(r.order).toEqual(["d:menu-3", "d:ny-1", "u:x"]);              // same asks still showing: nothing returns
    r = refresh(r, [dec("ny-1", { askedAt: 5 }), upd("x")]);             // menu-3 gone from the board
    r = refresh(r, [dec("menu-3", { askedAt: 10 }), dec("ny-1", { askedAt: 5 }), upd("x")]);   // and open again
    expect(r.order.filter(k => k.startsWith("d:menu-3"))).toHaveLength(2);
    expect(current(r)?.key).toBe("u:x");                                // the card on top doesn't move under his thumb
    expect(r.order.at(-1)).toBe("d:menu-3~2");                           // the reopened ask comes next
    r = refresh(r, [dec("menu-3", { askedAt: 10 }), dec("ny-1", { askedAt: 99 }), upd("x")]);  // ny-1 asked again
    expect(r.order.filter(k => k.startsWith("d:ny-1"))).toHaveLength(2);
  });
});
