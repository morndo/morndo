// Transcript and screen views blank API-key shapes (ADR-0018 §13). Synthetic keys only. Emails and paths stay:
// those views are what the principal reads, and the log redactor's other rules are not applied here.
import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { redactFeed, redactResponse } from "../src/adapters/view-redact.ts";

const ANTHROPIC = `sk-ant-api03-${"a".repeat(24)}`;
const OPENAI = `sk-proj-${"b".repeat(24)}`;
const DEEPSEEK = `sk-${"0123456789abcdef".repeat(2)}`;

const message = (text: string, extra: Partial<Message> = {}): Message =>
  ({ id: "m1", at: 1, author: { kind: "agent", name: "builder" }, kind: "text", text, ...extra });

describe("transcript and screen views", () => {
  it("blanks a key wrapped onto the next screen line, tail included", () => {
    const tail = "defghijklmnopqrstuvwxyz0123456789";
    const frame = redactFeed({ t: "screen", worker: "%1", text: `key: sk-ant-abc\n  ${tail}`, at: 1 });
    expect(JSON.stringify(frame)).not.toContain(tail);
    expect(frame).toEqual({ t: "screen", worker: "%1", text: "key: [redacted]", at: 1 });
  });
  it("blanks a key on a screen and keeps an email and a path", () => {
    const frame = redactFeed({ t: "screen", worker: "%1", text: `mail a@b.test at /home/someone ${ANTHROPIC}`, at: 1 });
    expect(frame).toEqual({ t: "screen", worker: "%1", text: "mail a@b.test at /home/someone [redacted]", at: 1 });
  });
  it("blanks keys in a transcript message, its question and its file caption", () => {
    const frame = redactFeed({
      t: "history", worker: "%1", session: null,
      messages: [message(`see ${OPENAI} and a@b.test`, {
        kind: "question",
        questions: [{ question: `use ${ANTHROPIC}?`, header: null, multiSelect: false, options: [{ label: "Yes", description: DEEPSEEK }] }],
        attachments: [{ id: null, name: "notes.txt", mime: "text/plain", kind: "text", size: 1, caption: OPENAI }],
      })],
    });
    if (!frame || typeof frame !== "object" || !("messages" in frame) || !Array.isArray(frame.messages)) throw new Error("history frame");
    const text = JSON.stringify(frame);
    for (const secret of [ANTHROPIC, OPENAI, DEEPSEEK]) expect(text).not.toContain(secret);
    expect(frame.messages[0]).toMatchObject({
      text: "see [redacted] and a@b.test",
      questions: [{ question: "use [redacted]?", options: [{ description: "[redacted]" }] }],
      attachments: [{ name: "notes.txt", caption: "[redacted]" }],
    });
  });
  it("blanks a key in a decision's screen excerpt", () => {
    const frame = redactFeed({
      t: "decisions", ledger: { configured: false, ok: false, at: null },
      items: [{ title: "Waiting", context: `prompt\n${ANTHROPIC}`, contextKind: "screen", options: [{ key: "1", label: "Go", detail: null }] }],
    });
    if (!frame || typeof frame !== "object" || !("items" in frame) || !Array.isArray(frame.items)) throw new Error("decisions frame");
    const item = frame.items[0];
    if (!item || typeof item !== "object" || !("context" in item)) throw new Error("decision");
    expect(item.context).toBe("prompt\n[redacted]");
    expect(JSON.stringify(frame)).not.toContain(ANTHROPIC);
  });
  it("blanks a key on board, snapshot, events, usage, catch-up and an unknown frame", () => {
    const frames = [
      { t: "board", tasks: [{ title: "ship", description: ANTHROPIC }], lanes: [], at: 1 },
      { t: "snapshot", epoch: "e", seq: 0, workers: [{ id: "%1", title: ANTHROPIC }] },
      { t: "events", events: [{ type: "note", text: ANTHROPIC }] },
      { t: "usage", accounts: [{ account: ANTHROPIC }], at: 1 },
      { t: "catchup", conversations: [{ worker: "%1", name: ANTHROPIC, messages: [] }] },
      { t: "history", worker: "%1", messages: [], session: { name: ANTHROPIC, cwd: "/tmp", version: null } },
      { t: "not-a-frame", note: ANTHROPIC },
      { item: { context: ANTHROPIC } },
    ];
    for (const frame of frames) {
      const out = JSON.stringify(redactFeed(frame));
      expect(out, JSON.stringify(frame.t ?? "body")).not.toContain(ANTHROPIC);
      expect(out).toContain("[redacted]");
    }
  });
  it("leaves identity and webauthn material, and still blanks a question option", () => {
    const publicKey = `AIza${"a".repeat(35)}`;
    const signature = `-sk-${"b".repeat(20)}`;
    const challenge = publicKey;
    const options = { challenge, rpId: "localhost", user: ANTHROPIC };
    const frame = redactFeed({ publicKey, signature, challenge, options, questions: [{ options: [{ description: ANTHROPIC }] }] });
    expect(frame).toEqual({
      publicKey, signature, challenge, options,
      questions: [{ options: [{ description: "[redacted]" }] }],
    });
  });
  it("skips an identity or webauthn route and still blanks a board body", () => {
    const body = { publicKey: `AIza${"a".repeat(35)}`, user: ANTHROPIC, challenge: `sk-${"c".repeat(20)}` };
    expect(redactResponse("/api/identity", body)).toBe(body);
    expect(redactResponse("/api/login/options", body)).toBe(body);
    expect(redactResponse("/api/stepup/verify", body)).toBe(body);
    expect(redactResponse("/api/pair/options", body)).toBe(body);
    expect(redactResponse("/api/push/key", body)).toBe(body);
    expect(redactResponse("/api/board", { description: ANTHROPIC })).toEqual({ description: "[redacted]" });
  });
  it("leaves a frame with no key material unchanged (negative control)", () => {
    const pong = { t: "pong", n: 1 };
    expect(redactFeed(pong)).toBe(pong);
    const screen = redactFeed({ t: "screen", worker: "%1", text: "ready\nno key here", at: 1 });
    expect(screen).toEqual({ t: "screen", worker: "%1", text: "ready\nno key here", at: 1 });
  });
});
