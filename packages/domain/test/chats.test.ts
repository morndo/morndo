// Chats (ADR-0011; H1–H6 in docs/domain.md): what counts as unread, the chat list's order, a lane's status, when he was
// away long enough for a digest, and how the digest sorts its lines. Synthetic data.
import { describe, expect, it } from "vitest";
import {
  AWAY_CHOICES, DEFAULT_AWAY, chatOrder, digestLines, isAway, lastShown, latestAnswer, laneStatus, mattering, parseAway,
  type Message,
} from "../src/index.ts";

const H = 3_600_000;
const agent = (id: string, at: number, text = `answer ${id}`, o: Partial<Message> = {}): Message => ({ id, at, author: { kind: "agent", name: "builder" }, kind: "text", text, ...o });
const you = (id: string, at: number, text = "do it"): Message => ({ id, at, author: { kind: "principal", name: "You" }, kind: "text", text });
const peer = (id: string, at: number): Message => ({ id, at, author: { kind: "peer", name: "Manager" }, kind: "text", text: "build it" });
const tools = (id: string, at: number): Message => ({ id, at, author: { kind: "agent", name: "builder" }, kind: "activity", text: "Bash", tools: ["Bash"] });
const sys = (id: string, at: number): Message => ({ id, at, author: { kind: "system", name: "kira" }, kind: "event", text: "Lane events arrived." });

describe("what counts as unread (H1)", () => {
  it("one per answer that ends a turn; narration mid-turn, tool calls, prompts and plumbing don't count", () => {
    const m = [you("1", 1), agent("2", 2, "Looking at it."), tools("3", 3), agent("4", 4, "Done: tests pass."), peer("5", 5), agent("6", 6, "Reading."), tools("7", 7), agent("8", 8, "Still on it."), sys("9", 9)];
    expect(mattering(m, null)).toBe(2);                // "Done: tests pass." ended a turn; "Still on it." is the latest
    expect(mattering(m, 4)).toBe(1);                   // read up to the first answer: only the turn still going
    expect(mattering(m, 9)).toBe(0);
  });
  it("a question and a file sent to him always count; his own messages never do", () => {
    const q: Message = { id: "q", at: 3, author: { kind: "agent", name: "b" }, kind: "question", text: "Keep it?", questionId: "q" };
    const f: Message = { id: "f", at: 4, author: { kind: "agent", name: "b" }, kind: "file", text: "", attachments: [] };
    expect(mattering([agent("1", 1), q, f, you("y", 5)], null)).toBe(3);
  });
});

describe("the latest message shown and the latest answer (H1)", () => {
  it("skips tool calls and plumbing for the preview; the answer is the agent's latest words", () => {
    const m = [agent("1", 1, "First"), you("2", 2, "go"), tools("3", 3), sys("4", 4)];
    expect(lastShown(m)?.id).toBe("2");
    expect(latestAnswer(m)?.id).toBe("1");
    expect(lastShown([tools("x", 1)])).toBeNull();
  });
});

describe("the chat list's order (H2)", () => {
  it("the manager pinned first, then the newest activity on top, then by name", () => {
    const rows = [
      { name: "builder", lastAt: 50 }, { name: "manager", lastAt: 10 }, { name: "reviewer", lastAt: 90 }, { name: "idle", lastAt: null }, { name: "alpha", lastAt: 50 },
    ];
    expect(chatOrder(rows, "manager").map(r => r.name)).toEqual(["manager", "reviewer", "alpha", "builder", "idle"]);
  });
});

describe("a lane's status in one line (H3)", () => {
  const now = 10 * H;
  it("waits for him: an open ask from it, since the oldest ask", () => {
    const s = laneStatus({ state: "active", changedAt: now - H, needsYou: false, asks: [{ title: "Ship?", askedAt: now - 2 * H }, { title: "Keep?", askedAt: now - 3 * H }], answer: null });
    expect(s).toMatchObject({ kind: "waits", since: now - 3 * H, ask: "Keep?" });
  });
  it("waits at a prompt on its screen without an ask: since it changed", () => {
    expect(laneStatus({ state: "quiet", changedAt: now - H, needsYou: true, asks: [], answer: null })).toMatchObject({ kind: "waits", since: now - H, ask: null });
  });
  it("working while its screen moves; finished, blocked or idle by its last answer's own word once quiet", () => {
    expect(laneStatus({ state: "active", changedAt: 5, needsYou: false, asks: [], answer: agent("a", 4, "Running tests.") }).kind).toBe("working");
    expect(laneStatus({ state: "quiet", changedAt: 5, needsYou: false, asks: [], answer: agent("a", 4, "STATUS: DONE. Shipped.") }).kind).toBe("finished");
    expect(laneStatus({ state: "quiet", changedAt: 5, needsYou: false, asks: [], answer: agent("a", 4, "STATUS: BLOCKED: no token") }).kind).toBe("blocked");
    expect(laneStatus({ state: "quiet", changedAt: 5, needsYou: false, asks: [], answer: agent("a", 4, "STATUS: FAILED tests red") }).kind).toBe("blocked");
    expect(laneStatus({ state: "quiet", changedAt: 5, needsYou: false, asks: [], answer: agent("a", 4, "Here you go.") })).toMatchObject({ kind: "idle", since: 5 });
  });
});

describe("away long enough for a digest (H4)", () => {
  const now = 100 * H;
  const noNight = () => false;
  it("the gap since his last activity on any device against the setting; 4 hours by default", () => {
    expect(DEFAULT_AWAY).toBe("4h");
    expect(isAway({ here: now - 5 * H, elsewhere: null, now, setting: "4h", night: noNight })).toEqual({ away: true, since: now - 5 * H });
    expect(isAway({ here: now - 20 * 60_000, elsewhere: null, now, setting: "4h", night: noNight })).toEqual({ away: false });
  });
  it("activity on another device in between means he wasn't away", () => {
    expect(isAway({ here: now - 9 * H, elsewhere: now - 10 * 60_000, now, setting: "4h", night: noNight })).toEqual({ away: false });
    expect(isAway({ here: null, elsewhere: now - 9 * H, now, setting: "2h", night: noNight })).toEqual({ away: true, since: now - 9 * H });
  });
  it("nothing known yet (a new device, no hub word): no digest", () => {
    expect(isAway({ here: null, elsewhere: null, now, setting: "2h", night: noNight })).toEqual({ away: false });
  });
  it("overnight: across a night and at least 3 hours; never: never", () => {
    expect(isAway({ here: now - 4 * H, elsewhere: null, now, setting: "overnight", night: () => true }).away).toBe(true);
    expect(isAway({ here: now - 2 * H, elsewhere: null, now, setting: "overnight", night: () => true }).away).toBe(false);
    expect(isAway({ here: now - 9 * H, elsewhere: null, now, setting: "overnight", night: () => false }).away).toBe(false);
    expect(isAway({ here: now - 90 * H, elsewhere: null, now, setting: "never", night: () => true }).away).toBe(false);
  });
  it("a stored setting this build doesn't know reads as the default", () => {
    expect(parseAway("8h")).toBe("8h");
    expect(parseAway("soon")).toBe(DEFAULT_AWAY);
    expect(Object.keys(AWAY_CHOICES)).toEqual(["2h", "4h", "8h", "overnight", "never"]);
  });
});

describe("the digest's lines (H5)", () => {
  const conv = (name: string, messages: Message[], o: { needsYou?: boolean; asks?: string[] } = {}) => ({ worker: `%${name}`, name, messages, needsYou: o.needsYou ?? false, asks: o.asks ?? [] });
  it("one line per lane that spoke or needs him: needs you, blocked, finished, then the rest by recency; the manager first", () => {
    const lines = digestLines([
      conv("quiet", []),
      conv("writer", [agent("w", 50, "Drafted the post.")]),
      conv("builder", [agent("b", 40, "STATUS: DONE. Login page built.")]),
      conv("ops", [agent("o", 30, "STATUS: BLOCKED. Needs a token.")]),
      conv("reviewer", [agent("r", 20, "One finding.")], { asks: ["Keep the endpoint?"] }),
      conv("manager", [agent("m", 10, "Night shift summary.")]),
      conv("tester", [agent("t", 60, "Running suite 2.")]),
    ], "manager");
    expect(lines.map(l => `${l.name}:${l.kind}`)).toEqual(["manager:working", "reviewer:needs_you", "ops:blocked", "builder:finished", "tester:working", "writer:working"]);
    expect(lines.find(l => l.name === "reviewer")?.ask).toBe("Keep the endpoint?");
    expect(lines.find(l => l.name === "builder")?.answer?.id).toBe("b");
  });
  it("counts what happened: messages that matter, tool uses and files", () => {
    const [l] = digestLines([conv("b", [agent("1", 1, "a"), tools("2", 2), tools("3", 3), you("4", 4), agent("5", 5, "b")])], "manager");
    expect(l).toMatchObject({ count: 2, tools: 2, files: 0, lastAt: 5 });
  });
});

describe("review finding 1 (2026-10-05): a lane whose last report says NEEDS DECISION waits for him", () => {
  it("shows as waiting in Status (H3), as the digest already counts it (H5), since the report", () => {
    const answer = agent("a", 40, "STATUS: NEEDS DECISION. Ship Friday or Monday?");
    expect(laneStatus({ state: "quiet", changedAt: 50, needsYou: false, asks: [], answer })).toMatchObject({ kind: "waits", since: 40, ask: null });
    expect(laneStatus({ state: "active", changedAt: 50, needsYou: false, asks: [], answer }).kind).toBe("waits");
    expect(digestLines([{ worker: "%1", name: "b", messages: [answer], needsYou: false, asks: [] }], "manager")[0]?.kind).toBe("needs_you");
  });
});

describe("review item 4 (2026-10-05): once he answered a NEEDS DECISION report, the lane no longer waits", () => {
  it("his message after the report ends the wait, without waiting for the lane's next report", () => {
    const answer = agent("a", 40, "STATUS: NEEDS DECISION. Ship Friday or Monday?");
    expect(laneStatus({ state: "quiet", changedAt: 50, needsYou: false, asks: [], answer, repliedAt: 45 }).kind).toBe("idle");
    expect(laneStatus({ state: "active", changedAt: 50, needsYou: false, asks: [], answer, repliedAt: 45 }).kind).toBe("working");
    expect(laneStatus({ state: "quiet", changedAt: 50, needsYou: false, asks: [], answer, repliedAt: 30 }).kind).toBe("waits");
  });
});
