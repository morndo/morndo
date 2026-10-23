// The wire protocol (ADR-0008, A2): what each end accepts. Synthetic frames only.
import { describe, expect, it } from "vitest";
import {
  AnswerBody, ClientFeedFrames, ClientTerminalFrames, LinkDecisionBody, PairCheckBody, PairOptionsBody, SendBody, ServerFeedFrames, ServerTerminalFrames,
  decode, decodeEvent, parseBody,
} from "../src/index.ts";

const UUID = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
const roster = { id: "%1", name: "builder", location: "/work/builder", title: null, lastMessageAt: 5, needsYou: false, state: "quiet", changedAt: 4 };
const message = { id: "m1", at: 1, author: { kind: "agent", name: "builder" }, kind: "text", text: "Starting." };
const item = {
  id: "ny-7", asker: { kind: "manager", name: "manager", workerId: "%0" }, need: "decision", title: "Ship it?", context: null,
  contextKind: "markdown", options: [{ key: "ship", label: "Ship it", detail: null }], answerBy: "tap", recommendation: null,
  ifNoAnswer: null, deadline: null, blocking: false, project: null, askedAt: 1, messageId: "md1", tracking: "age",
  status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null,
};
const kind = (d: { kind: string }) => d.kind;

describe("frames from the app to the hub (feed)", () => {
  it("accepts every frame the app sends", () => {
    for (const f of [{ t: "hello" }, { t: "hello", epoch: "e1", cursor: 3 }, { t: "watch", worker: "%12" }, { t: "watch", worker: null }, { t: "details", worker: "%1" }]) {
      expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), JSON.stringify(f)).toBe("ok");
    }
  });
  it("calls a frame malformed when it isn't a JSON object with a string t, or one of ours doesn't fit", () => {
    for (const raw of ["not json", "null", "3", "[]", '"hello"', "{}", '{"t":5}',
      '{"t":"hello","cursor":"3"}', '{"t":"hello","cursor":-1}', '{"t":"hello","cursor":1.5}',
      '{"t":"watch","worker":"../etc"}', '{"t":"watch"}', '{"t":"details","worker":7}']) {
      expect(kind(decode(ClientFeedFrames, raw)), raw).toBe("malformed");
    }
  });
  it("calls a type it doesn't know unknown, so a newer app's frames are ignored", () => {
    expect(decode(ClientFeedFrames, '{"t":"from-the-future","x":1}')).toEqual({ kind: "unknown", t: "from-the-future" });
    expect(kind(decode(ClientFeedFrames, '{"t":"toString"}'))).toBe("unknown");          // inherited names aren't types
  });
});

describe("frames from the hub to the app (feed)", () => {
  it("accepts what the hub sends", () => {
    const frames = [
      { t: "snapshot", epoch: "e1", seq: 0, workers: [roster] },
      { t: "events", events: [], caughtUp: true },
      { t: "screen", worker: "%1", text: "$ ", at: 1 },
      { t: "history", worker: "%1", messages: [message, { ...message, id: "m2", kind: "activity", tools: ["Bash"] }], session: { name: null, cwd: "/w", version: "2.1.286" } },
      { t: "messages", worker: "%1", messages: [message] },
      { t: "details", worker: "%1", session: null },
      { t: "decisions", items: [item], ledger: { configured: true, ok: true, at: 1 } },
    ];
    for (const f of frames) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), f.t).toBe("ok");
  });
  it("drops only the element of a list that doesn't fit, never the frame (review M1)", () => {
    const one = (m: unknown) => { const d = decode(ServerFeedFrames, JSON.stringify(m)); if (d.kind !== "ok") throw new Error(d.kind); return d.frame as Record<string, unknown>; };
    expect((one({ t: "snapshot", epoch: "e1", seq: 0, workers: [roster, { ...roster, id: "%2", needsYou: "yes" }] }).workers as unknown[]).length).toBe(1);
    expect((one({ t: "history", worker: "%1", messages: [message, { ...message, id: 7 }], session: null }).messages as unknown[]).length).toBe(1);
    expect((one({ t: "decisions", items: [item, { ...item, id: "ny-8", status: "maybe" }], ledger: { configured: true, ok: true, at: 1 } }).items as unknown[]).length).toBe(1);
    const withPath = one({ t: "messages", worker: "%1", messages: [{ ...message, attachments: [{ id: "../../etc/passwd", name: "x", mime: "x", kind: "file", size: 1, caption: null }] }] });
    expect((withPath.messages as { attachments: unknown[] }[])[0]?.attachments).toEqual([]);              // an id that isn't one of ours is never kept
  });
  it("still drops a frame whose own fields don't fit", () => {
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "screen", worker: "%1" })))).toBe("malformed");
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: -1, workers: [] })))).toBe("malformed");
  });
  it("takes any length from the hub: a long window name, a huge paste", () => {
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [{ ...roster, name: "w".repeat(5000) }] })))).toBe("ok");
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "messages", worker: "%1", messages: [{ ...message, text: "x".repeat(3_000_000) }] })))).toBe("ok");
  });
  it("reads an enum value from a newer hub safely: a state as quiet, a refusal as one, a source as can't check", () => {
    const snap = decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [{ ...roster, state: "hibernating" }] }));
    expect(snap.kind === "ok" && snap.frame.t === "snapshot" ? snap.frame.workers[0]?.state : null).toBe("quiet");
    const dec = decode(ServerFeedFrames, JSON.stringify({ t: "decisions", items: [{ ...item, answerable: "new_reason", source: "new_source" }], ledger: { configured: true, ok: true, at: 1 } }));
    const got = dec.kind === "ok" && dec.frame.t === "decisions" ? dec.frame.items[0] : null;
    expect([got?.answerable, got?.source]).toEqual(["unknown", "unreadable"]);
    const msg = decode(ServerFeedFrames, JSON.stringify({ t: "messages", worker: "%1", messages: [{ ...message, kind: "poll", author: { kind: "bot", name: "x" } }] }));
    const m = msg.kind === "ok" && msg.frame.t === "messages" ? msg.frame.messages[0] : null;
    expect([m?.kind, m?.author.kind]).toEqual(["event", "system"]);
  });
  it("a decision's short form: read as given; from a hub that doesn't send it, none; a link that isn't http(s), none", () => {
    const one = (x: Record<string, unknown>) => {
      const d = decode(ServerFeedFrames, JSON.stringify({ t: "decisions", items: [{ ...item, ...x }], ledger: { configured: true, ok: true, at: 1 } }));
      return d.kind === "ok" && d.frame.t === "decisions" ? d.frame.items[0] : null;
    };
    expect(one({ shortTitle: "Ship it", summary: "Ship the demo tonight.", minutes: 5, link: "https://example.com/pr/1", details: "All green." }))
      .toMatchObject({ shortTitle: "Ship it", summary: "Ship the demo tonight.", minutes: 5, link: "https://example.com/pr/1", details: "All green." });
    expect(one({})).toMatchObject({ shortTitle: null, summary: null, minutes: null, link: null, details: null });
    expect(one({ link: "javascript:alert(1)", minutes: "ten" })).toMatchObject({ link: null, minutes: null });
  });
  it("keeps an optional field absent rather than undefined (exact optional properties)", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "messages", worker: "%1", messages: [message] }));
    expect(d.kind === "ok" && d.frame.t === "messages" && "tools" in (d.frame.messages[0] ?? {})).toBe(false);
  });
});

describe("events, one by one", () => {
  const ev = (body: unknown, seq = 1) => ({ epoch: "e1", seq, at: 1, body });
  it("a known event", () => {
    expect(decodeEvent(ev({ type: "WorkerSpoke", workerId: "%1", at: 2 }))).toEqual({ kind: "event", event: ev({ type: "WorkerSpoke", workerId: "%1", at: 2 }) });
  });
  it("an event type from a newer hub keeps its place in the sequence", () => {
    expect(decodeEvent(ev({ type: "WorkerLearnedToFly", height: 3 }, 9))).toEqual({ kind: "unknown", epoch: "e1", seq: 9 });
  });
  it("an old hub's WorkerActivityNoted is accepted and ignored", () => {
    expect(decodeEvent(ev({ type: "WorkerActivityNoted", workerId: "%1", note: "background task" }))).toEqual({ kind: "unknown", epoch: "e1", seq: 1 });
    expect(decodeEvent(ev({ type: "WorkerActivityNoted", workerId: "%1", note: null })).kind).toBe("unknown");
  });
  it("a known type that doesn't fit, or no envelope, is malformed", () => {
    expect(kind(decodeEvent(ev({ type: "WorkerSpoke", workerId: "%1" })))).toBe("malformed");
    expect(kind(decodeEvent({ seq: 1, body: { type: "WorkerGone", workerId: "%1" } }))).toBe("malformed");
    expect(kind(decodeEvent(null))).toBe("malformed");
  });
});

describe("the terminal socket", () => {
  it("keys from the app; mode, frame and error from the hub", () => {
    expect(kind(decode(ClientTerminalFrames, '{"t":"keys","data":"ls\\r"}'))).toBe("ok");
    expect(kind(decode(ClientTerminalFrames, '{"t":"keys","data":5}'))).toBe("malformed");
    expect(kind(decode(ServerTerminalFrames, '{"t":"frame","cols":80,"rows":24,"x":0,"y":0,"cursor":true,"lines":["$ "]}'))).toBe("ok");
    expect(kind(decode(ServerTerminalFrames, '{"t":"frame","cols":80,"rows":24,"x":0,"y":0,"cursor":true,"lines":[1]}'))).toBe("malformed");
    expect(kind(decode(ServerTerminalFrames, '{"t":"mode","control":false}'))).toBe("ok");
  });
});

describe("HTTP bodies", () => {
  it("a send needs a UUID request id: an empty one is refused", () => {
    expect(parseBody(SendBody, { text: "hi", requestId: UUID, seen: "none" })).toEqual({ text: "hi", requestId: UUID, seen: "none" });
    expect(parseBody(SendBody, { text: "hi", requestId: UUID })).toBeNull();                              // S6: it must say what it answers
    expect(parseBody(SendBody, { text: "hi", requestId: "", seen: "none" })).toBeNull();
    expect(parseBody(SendBody, { text: "hi", requestId: "r1", seen: "none" })).toBeNull();
    expect(parseBody(SendBody, { text: "hi" })).toBeNull();
    expect(parseBody(SendBody, { text: 3, requestId: UUID, seen: "none" })).toBeNull();
    expect(parseBody(SendBody, { text: "", requestId: UUID, seen: "none", uploads: ["a", "b"] })).toEqual({ text: "", requestId: UUID, seen: "none", uploads: ["a", "b"] });
    expect(parseBody(SendBody, { text: "", requestId: UUID, seen: "none", uploads: Array.from({ length: 13 }, (_, i) => `u${i}`) })).toBeNull();
  });
  // RL10 (updates design §11.5): a Command carries the hub store its device saw before its first attempt — a UUID, or
  // nothing (an older app, or a record written before any answer).
  it("a send's hubStore is a UUID when it is there, and only then", () => {
    const OTHER = "1e2d94aa-3b4f-4c5d-9e8f-0a1b2c3d4e5f";
    expect(parseBody(SendBody, { text: "hi", requestId: UUID, seen: "none", hubStore: OTHER })).toEqual({ text: "hi", requestId: UUID, seen: "none", hubStore: OTHER });
    expect(parseBody(SendBody, { text: "hi", requestId: UUID, seen: "none", hubStore: "s-2" })).toBeNull();
    expect(parseBody(SendBody, { text: "hi", requestId: UUID, seen: "none", hubStore: 7 })).toBeNull();
  });
  it("an answer is an option key or words, each with a UUID request id", () => {
    expect(parseBody(AnswerBody, { key: "ship", requestId: UUID })).toEqual({ key: "ship", requestId: UUID });
    expect(parseBody(AnswerBody, { text: "hold it", requestId: UUID })).toEqual({ text: "hold it", requestId: UUID });
    expect(parseBody(AnswerBody, { key: "ship", requestId: "second" })).toBeNull();
    expect(parseBody(AnswerBody, { requestId: UUID })).toBeNull();
  });
  it("drops fields it doesn't know", () => {
    expect(parseBody(PairOptionsBody, { token: "t", name: "phone", admin: true })).toEqual({ token: "t", name: "phone" });
  });
});

describe("adding a device (phase E)", () => {
  it("an answer to a Link request may carry the pinned hub identity: 64 hex digits, nothing else", () => {
    expect(parseBody(LinkDecisionBody, {})).toEqual({});
    expect(parseBody(LinkDecisionBody, { fingerprint: "ab".repeat(32) })).toEqual({ fingerprint: "ab".repeat(32) });
    expect(parseBody(LinkDecisionBody, { fingerprint: "AB".repeat(32) })).toBeNull();
    expect(parseBody(LinkDecisionBody, { fingerprint: "ab".repeat(31) })).toBeNull();
    expect(parseBody(PairCheckBody, { token: "t" })).toEqual({ token: "t" });
    expect(parseBody(PairCheckBody, { token: "x".repeat(201) })).toBeNull();
  });
  it("from the hub: a device was linked (AC13)", () => {
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "linked", name: "laptop", at: 5 })))).toBe("ok");
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "linked", name: "laptop" })))).toBe("malformed");
  });
});

describe("reading frames (phase D)", () => {
  it("from the app: read, mute and older", () => {
    for (const f of [{ t: "read", conversation: "builder", at: 123 }, { t: "mute", conversation: "builder", muted: true }, { t: "older", worker: "%1", before: "a400:0" }]) {
      expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), f.t).toBe("ok");
    }
    for (const f of [{ t: "read", conversation: "", at: 1 }, { t: "read", conversation: "b", at: -1 }, { t: "mute", conversation: "b", muted: "yes" }, { t: "older", worker: "x", before: "a" }, { t: "older", worker: "%1", before: "" }]) {
      expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), JSON.stringify(f)).toBe("malformed");
    }
  });
  it("from the hub: reading, read, mute and older", () => {
    for (const f of [
      { t: "reading", reads: { builder: 5, reviewer: 7 }, muted: ["reviewer"] },
      { t: "read", conversation: "builder", at: 9 },
      { t: "mute", conversation: "builder", muted: false },
      { t: "older", worker: "%1", before: "a400:0", messages: [message], done: false },
      { t: "older", worker: "%1", before: "a400:0", messages: [], done: false, missing: true },
    ]) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), f.t).toBe("ok");
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ t: "reading", reads: { b: "x" }, muted: [] })))).toBe("malformed");
  });
});

describe("files copied in the background (fleet core §3.1)", () => {
  const photo = { name: "p.png", mime: "image/png", kind: "image", size: null, caption: null };
  it("an attachment may be pending (no id yet); pending is only ever true", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "messages", worker: "%1", messages: [{ ...message, attachments: [{ ...photo, id: null, pending: true }, { ...photo, id: null, pending: false }] }] }));
    expect(d.kind === "ok" && d.frame.t === "messages" ? d.frame.messages[0]?.attachments : null).toEqual([{ ...photo, id: null, pending: true }]);
  });
  it("the attachments frame: a message's files once their copies landed", () => {
    const f = { t: "attachments", worker: "%1", message: "u1", attachments: [{ ...photo, id: "a".repeat(32), size: 9 }] };
    expect(decode(ServerFeedFrames, JSON.stringify(f))).toEqual({ kind: "ok", frame: f });
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ ...f, message: 7 })))).toBe("malformed");
  });
});
