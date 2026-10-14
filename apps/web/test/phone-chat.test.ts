// The phone as a chat app (ADR-0011): rows, previews, status lines, bubbles, delivery words, away and the keyboard.
// Synthetic data.
import { describe, expect, it } from "vitest";
import type { Message, RosterEntry } from "@morndo/domain";
import type { ChatRowWire } from "@morndo/protocol";
import type { DecisionItem } from "../src/lib/desktop/decisions.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { chatEntry, keptChat, restoredChat, restoredScreen } from "../src/lib/phone/chat/history.ts";
import { bindWatch, pinnedToEnd } from "../src/lib/phone/chat/watch.ts";
import { chatRows, plain, preview, statusRows, when } from "../src/lib/phone/chat/rows.ts";
import { attachmentKey, bubbles, isLong, shortened } from "../src/lib/phone/chat/bubbles.ts";
import { deadReason, deliveryLabel, deliveryOf, lostReason } from "../src/lib/phone/chat/delivery.ts";
import { holdActivity, nightBetween, noteActivity, readAway, readLastActive, writeLastActive } from "../src/lib/phone/chat/away.ts";
import { keyboardInset } from "../src/lib/phone/chat/keyboard.ts";

const NOW = new Date(2026, 9, 5, 9, 30).getTime();
const MIN = 60_000;
const w = (name: string, o: Partial<RosterEntry> = {}): RosterEntry => ({ id: `%${name.length}${name[0]}` as RosterEntry["id"], name, location: "box", node: "", offline: false, state: "quiet", changedAt: NOW - 30 * MIN, title: null, lastMessageAt: null, needsYou: false, waitingOn: null, ...o });
const m = (id: string, at: number, text: string, o: Partial<Message> = {}): Message => ({ id, at, author: { kind: "agent", name: "a" }, kind: "text", text, ...o });
const row = (worker: RosterEntry, o: Partial<ChatRowWire> = {}): ChatRowWire => ({ worker: worker.id, name: worker.name, last: null, answer: null, unread: 0, lastAt: null, ...o });

describe("the chat list (H1, H2)", () => {
  it("manager first, newest activity next; a muted lane shows no count; an open ask makes a row wait", () => {
    const manager = w("manager"), builder = w("builder"), reviewer = w("reviewer"), quiet = w("quiet");
    const ask = { id: "q", status: "open", need: "decision", askedAt: NOW - 5 * MIN, title: "Keep the endpoint?", shortTitle: null, asker: { kind: "worker", name: "reviewer", workerId: reviewer.id } } as unknown as DecisionItem;
    const rows = chatRows({
      workers: [quiet, builder, reviewer, manager],
      chats: {
        [manager.id]: row(manager, { lastAt: NOW - 60 * MIN, unread: 1, last: m("a", NOW - 60 * MIN, "Here is the plan.") }),
        [builder.id]: row(builder, { lastAt: NOW - 2 * MIN, unread: 3, last: m("b", NOW - 2 * MIN, "**STATUS: DONE.** Login page built.\nMore") }),
        [reviewer.id]: row(reviewer, { lastAt: NOW - 10 * MIN, unread: 2 }),
      },
      decisions: [ask], muted: ["builder"], now: NOW,
    });
    expect(rows.map(r => r.display)).toEqual(["Manager", "builder", "reviewer", "quiet"]);
    expect(rows.map(r => r.unread)).toEqual([1, 0, 2, 0]);
    expect(rows[1]?.preview).toBe("Login page built.");
    expect(rows[2]?.needsYou).toBe(true);
    expect(rows[2]?.status.line).toBe("Waits for you: Keep the endpoint?");
  });
  it("previews his own messages, taps, questions and files plainly", () => {
    expect(preview(m("1", 1, "ship it", { author: { kind: "principal", name: "You" } }))).toBe("You: ship it");
    expect(preview(m("1", 1, "[tap ny-7] ship (Ship it)", { author: { kind: "principal", name: "You" } }))).toBe("You chose “Ship it”");
    expect(preview(m("1", 1, "Keep it?", { kind: "question" }))).toBe("Asks: Keep it?");
    expect(preview(null)).toBe("No messages yet");
    expect(plain("## Title\n\n- [link](https://x.test) and `code`")).toBe("Title");
    expect(plain("STATUS: DONE 0 errors")).toBe("0 errors");
    expect(plain("0 tests failing")).toBe("0 tests failing");
    expect(plain("42% done")).toBe("42% done");
    expect(plain("10am tomorrow works")).toBe("10am tomorrow works");
    expect(plain("user_service.py")).toBe("user_service.py");
    expect(plain("1. first")).toBe("first");
    expect(plain("retry 3 * 5 * 2 times")).toBe("retry 3 * 5 * 2 times");
    expect(plain("src/*.ts")).toBe("src/*.ts");
    expect(plain("*keep* this and `code`")).toBe("keep this and code");
    expect(plain("x".repeat(300)).length).toBe(120);
  });
  it("times read like a chat list", () => {
    expect(when(NOW - 5 * MIN, NOW)).toBe("09:25");
    expect(when(NOW - 24 * 60 * MIN, NOW)).toBe("Yesterday");
    expect(when(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("Fri");
  });
});

const ask = (o: Partial<DecisionItem> = {}): DecisionItem => ({
  id: "ny-1", asker: { kind: "manager", name: "Manager", workerId: "%7b" }, need: "decision", title: "Ship it?",
  shortTitle: null, summary: null, minutes: null, link: null, details: null, context: null, contextKind: "markdown",
  options: [], answerBy: "words", recommendation: null, ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: NOW - 60_000,
  messageId: null, tracking: "ledger", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1", ...o,
} as DecisionItem);

describe("the status view (H3)", () => {
  it("an open time task is not a call; an open decision is", () => {
    const lane = w("builder");
    const quiet = chatRows({ workers: [lane], chats: {}, decisions: [ask({ need: "time", title: "Call at 3" })], muted: [], now: NOW });
    expect(quiet[0]?.needsYou).toBe(false);
    expect(quiet[0]?.status.line).not.toContain("Waits");
    const waiting = chatRows({ workers: [lane], chats: {}, decisions: [ask()], muted: [], now: NOW });
    expect(waiting[0]?.needsYou).toBe(true);
    expect(waiting[0]?.status.line).toContain("Waits for you");
  });
  it("answered is his own latest message, not whatever the row previews", () => {
    const lane = w("builder");
    const answer = m("a", NOW - 10 * MIN, "STATUS: NEEDS DECISION\nShip it?");
    const later = m("f", NOW - MIN, "still working");
    const answered = chatRows({ workers: [lane], chats: { [lane.id]: row(lane, { last: later, answer, repliedAt: NOW - 5 * MIN }) }, decisions: [], muted: [], now: NOW });
    expect(answered[0]?.needsYou).toBe(false);
    const waiting = chatRows({ workers: [lane], chats: { [lane.id]: row(lane, { last: later, answer, repliedAt: null }) }, decisions: [], muted: [], now: NOW });
    expect(waiting[0]?.needsYou).toBe(true);
  });
  it("an offline lane stays offline in the list, and an open decision still counts", () => {
    const lane = w("builder", { offline: true, state: "active" });
    const alone = chatRows({ workers: [lane], chats: {}, decisions: [], muted: [], now: NOW });
    expect(alone[0]?.status.label).toBe("Offline");
    expect(alone[0]?.offline).toBe(true);
    expect(alone[0]?.active).toBe(false);
    expect(alone[0]?.needsYou).toBe(false);
    const waiting = chatRows({ workers: [lane], chats: {}, decisions: [ask()], muted: [], now: NOW });
    expect(waiting[0]?.offline).toBe(true);
    expect(waiting[0]?.needsYou).toBe(true);
    expect(waiting[0]?.status.line).toContain("Waits for you");
    const prompt = chatRows({ workers: [w("builder", { offline: true, needsYou: true })], chats: {}, decisions: [], muted: [], now: NOW });
    expect(prompt[0]?.status.label).toBe("Offline");
    expect(prompt[0]?.needsYou).toBe(false);
    expect(prompt[0]?.status.line).toBe("Offline");
  });
  it("one line each: waits for you (oldest first), working, blocked, then the rest; the manager first", () => {
    const rows = chatRows({
      workers: [w("idle"), w("busy", { state: "active", changedAt: NOW - 12 * MIN }), w("stuck", { needsYou: true, changedAt: NOW - 20 * MIN }), w("manager")],
      chats: {}, decisions: [], muted: [], now: NOW,
    });
    expect(statusRows(rows).map(r => [r.name, r.status.label])).toEqual([["manager", "Idle since 09:00"], ["stuck", "Waits 20 min"], ["busy", "Working 12 min"], ["idle", "Idle since 09:00"]]);
    expect(statusRows(rows)[1]?.status.line).toBe("Waits for you: a prompt on its screen");
  });
});

describe("chat history", () => {
  it("pushes one entry for a chat and restores that chat after a reload", () => {
    expect(chatEntry(null, "alpha")).toBe("push");
    expect(chatEntry("alpha", "alpha")).toBe("stay");
    expect(chatEntry("alpha", "manager")).toBe("push");
    expect(restoredChat({ chat: "alpha" })).toBe("alpha");
    expect(restoredChat(null)).toBeNull();
    expect(restoredChat({})).toBeNull();
    expect(restoredChat({ chat: "gone" }, [{ id: "alpha" }])).toBeNull();
    expect(restoredChat({ chat: "alpha", screen: true }, [{ id: "alpha" }])).toBe("alpha");
    expect(restoredScreen({ screen: true })).toBe(true);
    expect(restoredScreen({ chat: "alpha" })).toBe(false);
    expect(keptChat("gone", [{ id: "alpha" }], true)).toBeNull();
    expect(keptChat("alpha", [{ id: "alpha" }], true)).toBe("alpha");
    expect(keptChat("gone", [], false)).toBe("gone");
  });
});

describe("watching a chat", () => {
  it("a closed chat unwatches", () => {
    const seen: (string | null)[] = [];
    const stop = bindWatch({ watch: id => seen.push(id) }, "alpha");
    expect(seen).toEqual(["alpha"]);
    stop();
    expect(seen).toEqual(["alpha", null]);
  });
  it("the screen stays at the bottom while he follows, and holds when he scrolls up", () => {
    expect(pinnedToEnd(1000, 960, 40)).toBe(true);
    expect(pinnedToEnd(1000, 400, 40)).toBe(false);
  });
});

describe("attachment keys", () => {
  it("two files with one name in one message stay two rows", () => {
    expect(attachmentKey("m1", 0)).toBe("m1:0");
    expect(attachmentKey("m1", 1)).toBe("m1:1");
    expect(new Set([attachmentKey("m1", 0), attachmentKey("m1", 1)]).size).toBe(2);
  });
});

describe("bubbles", () => {
  it("day separators, mine right, one author within 3 minutes grouped, tool calls folded", () => {
    const y = NOW - 24 * 60 * MIN;
    const items = bubbles([
      m("1", y, "yesterday"), m("2", NOW - 10 * MIN, "first"), m("3", NOW - 9 * MIN, "second"),
      m("t1", NOW - 8 * MIN, "Bash", { kind: "activity", tools: ["Bash"] }), m("t2", NOW - 8 * MIN, "Read", { kind: "activity", tools: ["Read", "Read"] }),
      m("4", NOW - 2 * MIN, "go", { author: { kind: "principal", name: "You" } }), m("5", NOW - MIN, "third"),
    ], NOW);
    expect(items.map(i => (i.kind === "day" ? i.label : i.kind === "tools" ? `tools:${i.count}` : `${i.m.id}${i.mine ? "R" : "L"}${i.first ? "^" : ""}${i.last ? "$" : ""}`)))
      .toEqual(["Yesterday", "1L^$", "Today", "2L^", "3L$", "tools:3", "4R^$", "5L^$"]);
  });
  it("a long answer is shortened", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    expect(isLong(long)).toBe(true);
    expect(shortened(long).endsWith("…")).toBe(true);
    expect(isLong("short")).toBe(false);
  });
});

describe("delivery (S4–S8; the manager's queue, fleet-clients §9.1)", () => {
  const r = (o: Partial<OutboxRecord>): OutboxRecord => ({ id: "1", worker: "%1", workerName: "builder", text: "hi", uploads: [], createdAt: 1, budgetFrom: 1, state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, typedAt: null, hubAt: null, ...o });
  it("sending, queued (offline or in the manager's queue, with why it waits), delivered, not sent", () => {
    expect(deliveryOf(r({ state: "sending" }), 2)).toBe("sending");
    expect(deliveryOf(r({ state: "sent", delivery: { state: "queued", waiting: null, why: null } }), 2)).toBe("queued");
    expect(deliveryOf(r({ state: "sent" }), 2)).toBe("delivered");
    expect(deliveryOf(r({ state: "failed", error: "timeout" }), 2)).toBe("failed");
    expect(deliveryLabel(r({}), [], false, 2)).toBe("Queued · sends when you're back online");
    expect(deliveryLabel(r({ state: "sent", delivery: { state: "queued", waiting: null, why: null } }), [], true, 2)).toBe("Queued, it will be delivered");
    expect(deliveryLabel(r({ state: "sent", delivery: { state: "queued", waiting: "menu_open", why: null } }), [], true, 2))
      .toBe("Queued, it will be delivered: a menu is open in the manager's terminal; it goes in once that's answered");
    expect(deliveryLabel(r({ state: "sent" }), [], true, 2)).toBe("Delivered");
  });
});

describe("away (H4) on the device", () => {
  const store = (v: Record<string, string> = {}) => ({ getItem: (k: string) => v[k] ?? null, setItem: (k: string, x: string) => { v[k] = x; }, removeItem: (k: string) => { delete v[k]; } });
  it("keeps his last activity; reads an unknown setting as the default", () => {
    const s = store();
    expect(readLastActive(s)).toBeNull();
    writeLastActive(s, 1234);
    expect(readLastActive(s)).toBe(1234);
    expect(readAway(store({ "morndo.awayAfter": "weird" }))).toBe("4h");
    expect(readLastActive({ getItem: () => { throw new Error("blocked"); }, setItem: () => {}, removeItem: () => {} })).toBeNull();
  });
  it("moves last active at most every 30s, and not while a return is undecided", () => {
    const s = store();
    holdActivity(false);
    expect(noteActivity(s, 10_000, true)).toBe(true);
    expect(readLastActive(s)).toBe(10_000);
    expect(noteActivity(s, 20_000)).toBe(false);
    expect(readLastActive(s)).toBe(10_000);
    expect(noteActivity(s, 40_000)).toBe(true);
    expect(readLastActive(s)).toBe(40_000);
    holdActivity(true);
    expect(noteActivity(s, 80_000, true)).toBe(false);
    expect(readLastActive(s)).toBe(40_000);
    holdActivity(false);
  });
  it("a night lies between two times when 4 in the morning falls inside", () => {
    expect(nightBetween(new Date(2026, 9, 4, 23).getTime(), new Date(2026, 9, 5, 7).getTime())).toBe(true);
    expect(nightBetween(new Date(2026, 9, 5, 9).getTime(), new Date(2026, 9, 5, 17).getTime())).toBe(false);
    expect(nightBetween(new Date(2026, 9, 5, 2).getTime(), new Date(2026, 9, 5, 5).getTime())).toBe(true);
  });
});

describe("the keyboard", () => {
  it("lifts the conversation by what the keyboard covers and follows the visual viewport's top", () => {
    expect(keyboardInset(844, { height: 844, offsetTop: 0 })).toEqual({ top: 0, bottom: 0 });
    expect(keyboardInset(844, { height: 508, offsetTop: 0 })).toEqual({ top: 0, bottom: 336 });
    expect(keyboardInset(844, { height: 508, offsetTop: 120 })).toEqual({ top: 120, bottom: 216 });
    expect(keyboardInset(844, null)).toEqual({ top: 0, bottom: 0 });
  });
});

describe("review findings 1-3 (2026-10-05)", () => {
  const r = (o: Partial<OutboxRecord>): OutboxRecord => ({ id: "1", worker: "%1", workerName: "builder", text: "hi", uploads: [], createdAt: NOW, budgetFrom: NOW, state: "sent", error: null, attempts: 1, seen: "none", sentAt: NOW, typedAt: NOW, hubAt: NOW, ...o });
  it("1: Status says a lane waits for him when its last report says NEEDS DECISION, with the report's words", () => {
    const b = w("builder", { state: "quiet" });
    const rows = chatRows({ workers: [b], chats: { [b.id]: row(b, { answer: m("x", NOW - 5 * MIN, "STATUS: NEEDS DECISION. Ship Friday or Monday?") }) }, decisions: [], muted: [], now: NOW });
    expect(rows[0]?.status.kind).toBe("waits");
    expect(rows[0]?.status.line).toBe("Waits for you: Ship Friday or Monday?");
    expect(rows[0]?.needsYou).toBe(true);
  });
  it("2: Delivered warns when its echo hasn't shown in the conversation after 10 minutes", () => {
    expect(deliveryOf(r({}), NOW + 9 * MIN)).toBe("delivered");
    expect(deliveryOf(r({}), NOW + 11 * MIN)).toBe("unseen");
    expect(deliveryLabel(r({}), [], true, NOW + 11 * MIN)).toBe("Typed in, but not seen in its conversation after 10 min: check its Screen");
  });
  it("3: a message the manager's queue still holds says why it waits, however long (it waits up to a day: ruling 83)", () => {
    const q = r({ delivery: { state: "queued", waiting: "busy", why: null } });
    expect(deliveryOf(q, NOW + 59 * MIN)).toBe("queued");
    expect(deliveryOf(q, NOW + 61 * MIN)).toBe("queued");
    expect(deliveryLabel(q, [], true, NOW + 61 * MIN)).toBe("Queued, it will be delivered: something else is typing into the manager right now; it goes in right after");
  });
});

describe("review item 4 (2026-10-05)", () => {
  it("a lane whose NEEDS DECISION he answered in its chat doesn't say Waits for you", () => {
    const b = w("builder", { state: "quiet" });
    const report = m("x", NOW - 5 * MIN, "STATUS: NEEDS DECISION. Ship Friday or Monday?");
    const mine = m("y", NOW - 2 * MIN, "Monday", { author: { kind: "principal", name: "You" } });
    const rows = chatRows({ workers: [b], chats: { [b.id]: row(b, { answer: report, last: mine }) }, decisions: [], muted: [], now: NOW });
    expect(rows[0]?.status.kind).not.toBe("waits");
    expect(rows[0]?.needsYou).toBe(false);
  });
});

describe("review #2 (2026-10-05, the team's call A): the bubble tells where it stands, never a resend it didn't make", () => {
  const r = (o: Partial<OutboxRecord>): OutboxRecord => ({ id: "1", worker: "%0", workerName: "manager", text: "hi", uploads: [], createdAt: NOW, budgetFrom: NOW, state: "sent", error: null, attempts: 1, seen: "none", sentAt: NOW, typedAt: NOW, hubAt: NOW, delivery: { state: "queued", waiting: null, why: null }, ...o });
  it("however long it waits, the clock never makes it Not sent: only the queue's given-up does", () => {
    expect(deliveryOf(r({}), NOW + 3 * 60 * MIN)).toBe("queued");
  });
  it("the queue still holds it: still waiting, with its reason", () => {
    const held = r({ delivery: { state: "queued", waiting: "draft_present", why: null } });
    expect(deliveryLabel(held, [], true, NOW + 61 * MIN)).toBe("Queued, it will be delivered: the manager's input box has text that isn't from Morndo; it goes in once that's sent or cleared");
  });
  it("the queue gave it up: Not delivered, with why, and only then Send again", () => {
    const lost = r({ delivery: { state: "given_up", waiting: null, why: "cancelled" } });
    expect(deliveryOf(lost, NOW + 5 * MIN)).toBe("lost");
    expect(deliveryLabel(lost, [], true, NOW + 5 * MIN)).toBe("Not delivered");
    expect(lostReason(lost)).toBe("Not delivered: it was withdrawn before it was typed. Send again queues it once more.");
  });
});

describe("medium verify (2026-10-05), issue 1: Not delivered never promises a resend the hub can't make", () => {
  const r = (o: Partial<OutboxRecord>): OutboxRecord => ({ id: "1", worker: "%0", workerName: "manager", text: "hi", uploads: [], createdAt: NOW, budgetFrom: NOW, state: "sent", error: null, attempts: 1, seen: "none", sentAt: NOW, typedAt: NOW, hubAt: NOW, ...o });
  const givenUp = { state: "given_up" as const, waiting: null, why: "expired" };
  it("given up and not queued again by a Send again, or a second copy given up too: a final state that says what he can do", () => {
    const dead = r({ delivery: givenUp, resendFailed: true });
    expect(deliveryOf(dead, NOW + MIN)).toBe("dead");
    expect(deliveryOf(r({ delivery: givenUp, resent: true }), NOW + MIN)).toBe("dead");
    expect(deliveryLabel(dead, [], true, NOW + MIN)).toBe("Not delivered");
    expect(deadReason(dead)).toBe("Not delivered: it waited a whole day and was never typed, and it can't be queued again. Write it again as a new message, or discard it.");
    expect(deliveryOf(r({ delivery: givenUp }), NOW + MIN)).toBe("lost");   // a Send again may still work
  });
});

describe("medium verify (2026-10-05), issue 2: delivered by the queue but no echo here is final", () => {
  const r = (o: Partial<OutboxRecord>): OutboxRecord => ({ id: "1", worker: "%0", workerName: "manager", text: "hi", uploads: [], createdAt: NOW, budgetFrom: NOW, state: "sent", error: null, attempts: 1, seen: "none", sentAt: NOW, typedAt: NOW, hubAt: NOW, ...o });
  it("delivered: delivered, not shown in the chat, and it stays so; typed and never seen taken: may have been", () => {
    const got = r({ delivery: { state: "delivered", waiting: null, why: null } });
    expect(deliveryOf(got, NOW + MIN)).toBe("arrived");
    expect(deliveryOf(got, NOW + 3 * 60 * MIN)).toBe("arrived");
    expect(deliveryLabel(got, [], true, NOW + 3 * 60 * MIN)).toBe("Delivered to the manager, not shown in this chat");
    const maybe = r({ delivery: { state: "uncertain", waiting: null, why: null } });
    expect(deliveryOf(maybe, NOW + MIN)).toBe("maybe");
    expect(deliveryLabel(maybe, [], true, NOW + MIN)).toBe("May have been delivered");
  });
});
