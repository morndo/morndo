// Catch-up (ADR-0009; C1–C7): which cards wait, in which order, what one Conversation brings since its Read mark, and
// "last caught up" moving only forward. Synthetic data.
import { describe, expect, it } from "vitest";
import {
  advanceCaughtUp, catchUpCards, catchUpCount, mutedWithUpdates, newSince, statusOf, waitsForCall,
  type CatchUpInput, type ConversationLook, type Message,
} from "../src/index.ts";

type D = CatchUpInput["decisions"][number];
const d = (id: string, o: Partial<D> = {}): D => ({ id, status: "open", need: "decision", blocking: false, deadline: null, askedAt: 1000, ...o } as D);
const c = (name: string, lastMessageAt: number | null, o: Partial<ConversationLook> = {}): ConversationLook => ({ worker: `%${name.length}`, name, lastMessageAt, needsYou: false, ...o });
const msg = (id: string, at: number, o: Partial<Message> = {}): Message => ({ id, at, author: { kind: "agent", name: "builder" }, kind: "text", text: `message ${id}`, ...o });

describe("which cards wait (C1, C2, C4)", () => {
  it("an open Ask for his call is a card; answered, settled, expired and time items are not", () => {
    expect(waitsForCall(d("a"))).toBe(true);
    for (const status of ["answered", "settled", "expired"] as const) expect(waitsForCall(d("a", { status }))).toBe(false);
    expect(waitsForCall(d("a", { need: "time" }))).toBe(false);
  });
  it("counts the open decisions plus the unmuted conversations read before their last message", () => {
    const input: CatchUpInput = {
      decisions: [d("ny-1"), d("ny-2", { status: "answered" }), d("ny-3", { need: "time" })],
      conversations: [c("builder", 500), c("reviewer", 300), c("manager", 900), c("idle", null)],
      reads: { builder: 400, reviewer: 300 },
      muted: ["manager"],
    };
    expect(catchUpCount(input)).toBe(2);                                   // ny-1, builder
    expect(catchUpCards(input).map(x => x.key)).toEqual(["d:ny-1", "u:builder"]);
  });
  it("a muted conversation gets no card, but an Ask from it still does, and the skip is counted", () => {
    const input: CatchUpInput = { decisions: [d("q-1")], conversations: [c("reviewer", 900)], reads: {}, muted: ["reviewer"] };
    expect(catchUpCards(input).map(x => x.key)).toEqual(["d:q-1"]);
    expect(mutedWithUpdates(input)).toEqual(["reviewer"]);
  });
  it("reading doesn't take a decision out (C1): read or muted, it stays", () => {
    const input: CatchUpInput = { decisions: [d("ny-1")], conversations: [c("manager", 900)], reads: { manager: 900 }, muted: ["manager"] };
    expect(catchUpCards(input).map(x => x.key)).toEqual(["d:ny-1"]);
  });
  it("two panes with one name are one card (they share a Read mark, O7)", () => {
    expect(catchUpCards({ decisions: [], conversations: [c("w", 500, { worker: "%1" }), c("w", 600, { worker: "%2" })], reads: {}, muted: [] })).toHaveLength(1);
  });
});

describe("the order (C3)", () => {
  it("decisions first: blocking, then the earliest due time, then the oldest", () => {
    const cards = catchUpCards({
      decisions: [d("late", { deadline: 9000, askedAt: 1 }), d("old", { askedAt: 10 }), d("block", { blocking: true, askedAt: 50 }), d("soon", { deadline: 5000, askedAt: 99 }), d("new", { askedAt: 20 })],
      conversations: [c("builder", 500)], reads: {}, muted: [],
    });
    expect(cards.map(x => x.key)).toEqual(["d:block", "d:soon", "d:late", "d:old", "d:new", "u:builder"]);
  });
  it("updates: needs you, then says done, then the most recent", () => {
    const cards = catchUpCards({
      decisions: [],
      conversations: [c("a", 100), c("b", 900), c("asks", 50, { needsYou: true }), c("done", 10), c("plain", 20), c("done-later", 30)],
      reads: {}, muted: [],
      claims: { done: "says_done", "done-later": "says_done" },
    });
    expect(cards.map(x => x.key)).toEqual(["u:asks", "u:done-later", "u:done", "u:b", "u:a", "u:plain"]);
  });
});

describe("what a conversation brings since its Read mark (C5)", () => {
  it("only messages after the mark, the newest kept, counted whole", () => {
    const all = [msg("1", 100), msg("2", 200, { kind: "activity", text: "", tools: ["Edit", "Bash", "Edit"] }), msg("3", 300, { kind: "file", attachments: [{ id: null, name: "a.png", mime: "image/png", kind: "image", size: 1, caption: null }] }),
      msg("4", 400, { author: { kind: "principal", name: "You" }, attachments: [{ id: null, name: "mine.png", mime: "image/png", kind: "image", size: 1, caption: null }] }), msg("5", 500, { kind: "activity", text: "", tools: ["Read"] })];
    const n = newSince(all, 100, 2);
    expect(n.messages.map(m => m.id)).toEqual(["3", "4"]);              // words and files; the tool calls are counted (11)
    expect(n).toMatchObject({ count: 2, firstAt: 200, lastAt: 500, tools: 4, toolNames: ["Edit", "Bash", "Read"], files: 1 });
    expect(newSince([msg("1", 100, { kind: "event", author: { kind: "system", name: "lane" } }), msg("2", 200, { kind: "event", author: { kind: "agent", name: "b" } })], null).count).toBe(1);
  });
  it("never read: everything is new; nothing new: empty", () => {
    expect(newSince([msg("1", 100)], null).count).toBe(1);
    expect(newSince([msg("1", 100)], 100)).toMatchObject({ count: 0, firstAt: null, lastAt: null, messages: [], claim: null });
  });
  it("says done only when the worker's latest answer led with STATUS: DONE", () => {
    expect(newSince([msg("1", 100, { text: "STATUS: DONE. Built." })], null).claim).toBe("says_done");
    expect(newSince([msg("1", 100, { text: "STATUS: DONE. Built." }), msg("2", 200, { text: "One more thing." })], null).claim).toBeNull();
    expect(newSince([msg("1", 100, { text: "STATUS: DONE", author: { kind: "principal", name: "You" } })], null).claim).toBeNull();
    expect(newSince([msg("1", 100, { text: "STATUS: BLOCKED on CI" })], null).claim).toBeNull();
  });
  it("statusOf reads the protocol's words, and nothing else", () => {
    expect(statusOf("**STATUS: DONE.** All green").status).toBe("done");
    expect(statusOf("STATUS: NEEDS DECISION about X").status).toBe("decision");
    expect(statusOf("I'm done").status).toBeNull();
  });
});

describe("last caught up (C7)", () => {
  const NOW = 1_000_000;
  it("moves only forward and is clamped to the hub's clock", () => {
    expect(advanceCaughtUp(null, 500, NOW)).toBe(500);
    expect(advanceCaughtUp(500, 400, NOW)).toBeNull();
    expect(advanceCaughtUp(500, 500, NOW)).toBeNull();
    expect(advanceCaughtUp(500, NOW + 9999, NOW)).toBe(NOW);
    expect(advanceCaughtUp(null, Number.NaN, NOW)).toBeNull();
    expect(advanceCaughtUp(null, -1, NOW)).toBeNull();
  });
});

// Review of PR #7, finding 4: two panes with one window name share a Read mark (O7); the card is the pane that spoke
// last, the same one the hub's catch-up describes, so a reply goes where its messages came from.
describe("two panes with one name", () => {
  it("the card is the pane with the latest message, whichever comes first in the roster", () => {
    const cards = catchUpCards({ decisions: [], conversations: [c("builder", 1200, { worker: "%1" }), c("builder", 1300, { worker: "%2" })], reads: { builder: 1000 }, muted: [] });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ worker: "%2", lastAt: 1300 });
  });
});

// Review of PR #7, finding 11: tool calls are counted on a card, not listed: its messages are words and files.
describe("what a card shows of a busy agent", () => {
  it("keeps the newest words and files, and counts the tool calls instead of listing them", () => {
    const words = [msg("t1", 101, { text: "Reading the logs." }), msg("t2", 102, { text: "Found it." }), msg("t3", 300, { text: "Fixed and tested." })];
    const tools = Array.from({ length: 40 }, (_, i) => msg(`a${i}`, 200 + i, { kind: "activity", text: "", tools: ["Read"] }));
    const n = newSince([...words, ...tools].sort((a, b) => a.at - b.at), 100, 30);
    expect(n.messages.map(m => m.id)).toEqual(["t1", "t2", "t3"]);
    expect(n).toMatchObject({ count: 3, tools: 40, toolNames: ["Read"], lastAt: 300 });
  });
});

describe("the phone's catch-up holds decisions only (ADR-0011)", () => {
  it("updates: false leaves out every update card, and the count with them", () => {
    const input: CatchUpInput = { decisions: [d("ny-1")], conversations: [c("builder", 500)], reads: {}, muted: [], updates: false };
    expect(catchUpCards(input).map(x => x.key)).toEqual(["d:ny-1"]);
    expect(catchUpCount(input)).toBe(1);
  });
});

describe("review #10 (2026-10-05, the team's call): no 'muted, skipped' on a decisions-only run", () => {
  it("with updates: false no lane's updates are shown, so no muted lane counts as skipped (C4 as amended)", () => {
    const input: CatchUpInput = { decisions: [d("ny-1")], conversations: [c("reviewer", 900)], reads: {}, muted: ["reviewer"], updates: false };
    expect(mutedWithUpdates(input)).toEqual([]);
    expect(mutedWithUpdates({ ...input, updates: true })).toEqual(["reviewer"]);
  });
});
