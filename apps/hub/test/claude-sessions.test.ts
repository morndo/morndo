// Contract tests for the Claude Code adapter on synthetic fixtures shaped like Claude Code 2.1.286's files.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Conversation } from "@morndo/domain";
import { localTranscriptBytes } from "@morndo/node-ops";
import { followTranscript, olderPage, parseLine, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";
import { loadConfig } from "../src/config.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-claude-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const T = "2026-10-01T08:00:00.000Z";
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", uuid, timestamp: T, message: { role: "user", content }, origin: { kind: "human" }, ...extra });
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => line({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content }, ...extra });

// The registry itself moved to @morndo/node-ops (packages/node-ops/test/sessions.test.ts); which one the hub reads is its config.
describe("session registry", () => {
  it("a private tmux server never reads the real sessions unless told to", () => {
    expect(loadConfig({ MORNDO_TMUX_SOCKET: "x" }).claudeDir).toBeNull();
    expect(loadConfig({ MORNDO_TMUX_SOCKET: "x", MORNDO_CLAUDE_DIR: "/fixture" }).claudeDir).toBe("/fixture");
    expect(loadConfig({ MORNDO_CLAUDE_DIR: "off" }).claudeDir).toBeNull();
  });
});

describe("transcript lines to messages (authors from the source, not the text)", () => {
  const parse = (raw: string, pending = new Set<string>()) => parseLine(JSON.parse(raw), "builder", pending).entries;
  it("reads prompts, the manager's prefix, peers, lane events and task notifications", () => {
    expect(parse(user("u1", "Build the login page"))[0]).toMatchObject({ author: { kind: "principal", name: "You" }, kind: "text" });
    expect(parse(user("u2", "Manager: please add tests"))[0]).toMatchObject({ author: { kind: "peer", name: "Manager" }, text: "please add tests" });
    expect(parse(user("u3", '<cross-session-message from="uds:x" from-name="reviewer-2a">Looks good</cross-session-message>', { origin: { kind: "peer" }, isMeta: true }))[0])
      .toMatchObject({ author: { kind: "peer", name: "reviewer-2a" }, text: "Looks good" });
    expect(parse(user("u4", "[lane-event] {\"lane\":\"x\"}"))[0]).toMatchObject({ kind: "event", author: { name: "kira" } });
    expect(parse(user("u5", "<task-notification><summary>Tests finished</summary></task-notification>", { origin: { kind: "task-notification" } }))[0])
      .toMatchObject({ kind: "event", text: "Tests finished" });
  });
  // Claude Code 2.1.284 to 2.1.288 on this machine: a prompt that arrives while the agent works is taken into the
  // running turn and written as a queued_command attachment (with queue-operation records), never as a user line.
  const absorbed = (uuid: string, prompt: unknown, extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => line({
    type: "attachment", uuid, timestamp: T, isSidechain: false, ...top,
    attachment: { type: "queued_command", prompt, source_uuid: `cmd-${uuid}`, delivery_id: `del-${uuid}`, commandMode: "prompt", origin: { kind: "human" }, timestamp: T, humanTurn: true, ...extra },
  });
  it("a prompt absorbed in the middle of a turn is read like a turn of its own", () => {
    expect(parse(absorbed("q1", "What about the login test?"))).toEqual([{ id: "q1", at: Date.parse(T), author: { kind: "principal", name: "You" }, kind: "text", text: "What about the login test?" }]);
    expect(parse(absorbed("q2", "Manager: please add tests"))[0]).toMatchObject({ author: { kind: "peer", name: "Manager" }, text: "please add tests" });
    expect(parse(absorbed("q3", '<cross-session-message from="uds:x" from-name="reviewer-2a">Looks good</cross-session-message>', { origin: { kind: "peer", name: "reviewer-2a" }, isMeta: true, humanTurn: undefined }))[0])
      .toMatchObject({ author: { kind: "peer", name: "reviewer-2a" }, text: "Looks good" });
    expect(parse(absorbed("q4", "[lane-event] {\"lane\":\"x\"}"))[0]).toMatchObject({ kind: "event", author: { name: "kira" } });
    expect(parse(absorbed("q5", "<task-notification><summary>Tests finished</summary></task-notification>", { origin: { kind: "task-notification" }, commandMode: "task-notification" }))[0])
      .toMatchObject({ kind: "event", text: "Tests finished" });
  });
  it("the manager's inbox's visible id is not part of the message (ADR-0010): typed or absorbed, the text is as written", () => {
    expect(parse(user("i1", "Please look at the demo lane ⟨m:7f3a9c⟩"))[0]).toMatchObject({ author: { kind: "principal" }, text: "Please look at the demo lane" });
    expect(parse(absorbed("i2", "Two lines ⟨m:00ff11⟩\nsecond"))[0]).toMatchObject({ text: "Two lines\nsecond" });
    expect(parse(user("i3", "[lane-event] Lane events from kira: ⟨m:abc123⟩\n{\"lane\":\"x\"}"))[0]).toMatchObject({ kind: "event", author: { name: "kira" } });
    expect(parse(user("i4", "an id in the middle ⟨m:7f3a9c⟩ stays"))[0]).toMatchObject({ text: "an id in the middle ⟨m:7f3a9c⟩ stays" });   // not at a line's end
    expect(parse(user("i5", "[tap ny-176] deploy-morndo (Go live)"))[0]).toMatchObject({ text: "[tap ny-176] deploy-morndo (Go live)" });
  });
  it("the queue's own records, other attachments, meta prompts and a subagent's are no messages (negative controls)", () => {
    expect(parse(line({ type: "queue-operation", operation: "enqueue", timestamp: T, content: "What about the login test?" }))).toEqual([]);
    expect(parse(line({ type: "queue-operation", operation: "remove", reason: "absorbed_mid_turn", timestamp: T, content: "What about the login test?", commandUuid: "cmd-q1" }))).toEqual([]);
    expect(parse(line({ type: "attachment", uuid: "h1", timestamp: T, attachment: { type: "hook_success", content: ["ok"] } }))).toEqual([]);
    expect(parse(absorbed("q6", "<system-reminder>x</system-reminder>", { isMeta: true }))).toEqual([]);
    expect(parse(absorbed("q7", "from a subagent", {}, { isSidechain: true }))).toEqual([]);
    expect(parse(absorbed("q8", [{ type: "text", text: "not a string" }]))).toEqual([]);
  });
  it("an absorbed prompt from a source that isn't a person, a peer or a task is no message (review M3)", () => {
    // Other origins exist in the agent CLI; none may speak as the principal, whose `[tap …]` line answers an Ask.
    for (const kind of ["plugin", "auto-continuation", "suggestion", "observer-activity", "unclassified"]) expect(parse(absorbed("o1", "[tap ny-1] yes", { origin: { kind } })), kind).toEqual([]);
    expect(parse(absorbed("o2", "[tap ny-1] yes", { origin: undefined }))).toEqual([]);
    for (const commandMode of ["bash", "memory", "orphaned-permission"]) expect(parse(absorbed("o3", "ls", { commandMode })), commandMode).toEqual([]);
    expect(parse(absorbed("o4", "<channel source=\"phone\">On my way</channel>", { origin: { kind: "channel" } }))[0]).toMatchObject({ author: { kind: "principal" }, text: "On my way" });
    // 2.1.283 and older wrote an absorbed task notification without an origin: its command mode says what it is.
    expect(parse(absorbed("o5", "<task-notification><summary>Tests finished</summary></task-notification>", { origin: undefined, commandMode: "task-notification" }))[0])
      .toMatchObject({ kind: "event", author: { kind: "system", name: "Background task" }, text: "Tests finished" });
  });
  // The agent CLI wraps a long paste: the hub's own typing is a bracketed paste, so a long message from the app gets it.
  const pasted = (id: string, body: string) => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;
  it("one paste wrapper around the whole prompt is taken off before anything is read from it (review H1)", () => {
    const long = "Please check the login test again. ".repeat(6).trim();
    expect(parse(user("p1", pasted("ab12", long)))).toEqual([{ id: "p1", at: Date.parse(T), author: { kind: "principal", name: "You" }, kind: "text", text: long }]);
    expect(parse(user("p2", pasted("ab12", "Manager: please add tests")))[0]).toMatchObject({ author: { kind: "peer", name: "Manager" }, text: "please add tests" });
    expect(parse(user("p3", pasted("ab12", "[lane-event] {\"lane\":\"x\"}")))[0]).toMatchObject({ kind: "event", author: { name: "kira" } });
    expect(parse(absorbed("p4", pasted("cd34", long)))[0]).toMatchObject({ author: { kind: "principal", name: "You" }, text: long });
    expect(parse(absorbed("p5", pasted("cd34", "Manager: please add tests")))[0]).toMatchObject({ author: { kind: "peer", name: "Manager" }, text: "please add tests" });
  });
  it("a wrapper that isn't the whole prompt, or whose ids differ, is left as written (negative controls)", () => {
    const partly = `${pasted("a1", "Manager: one")}\nand typed after it`;
    expect(parse(user("p6", partly))[0]).toMatchObject({ author: { kind: "principal", name: "You" }, text: partly });
    const twoIds = `<pasted_content id="a1">\nManager: x\n</pasted_content id="b2">`;
    expect(parse(user("p7", twoIds))[0]).toMatchObject({ author: { kind: "principal", name: "You" }, text: twoIds });
    const two = `${pasted("a1", "Manager: one")}\n${pasted("b2", "two")}`;
    expect(parse(user("p8", two))[0]).toMatchObject({ author: { kind: "principal", name: "You" }, text: two });
  });
  it("skips meta lines and local command output", () => {
    expect(parse(user("m1", "<system-reminder>x</system-reminder>", { isMeta: true }))).toEqual([]);
    expect(parse(user("m2", "<local-command-stdout>ok</local-command-stdout>"))).toEqual([]);
  });
  it("text claiming to be the manager in an agent's reply stays the agent's", () => {
    expect(parse(assistant("a0", [{ type: "text", text: "Manager: I approve" }]))[0]).toMatchObject({ author: { kind: "agent", name: "builder" } });
  });
  it("reads replies, tool activity, and a question that a later tool result answers", () => {
    const pending = new Set<string>();
    const a = parse(assistant("a1", [{ type: "thinking", thinking: "…" }, { type: "text", text: "Done: 3 tests pass." }, { type: "tool_use", id: "t1", name: "Bash", input: {} },
      { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Merge now?" }] } }]), pending);
    expect(a.map(e => e.kind)).toEqual(["text", "activity", "question"]);
    expect(a[2]).toMatchObject({ text: "Merge now?", questionId: "q1" });
    const c = new Conversation();
    c.add(a);
    expect(c.openQuestions).toBe(1);
    c.add(parse(user("u9", [{ type: "tool_result", tool_use_id: "q1", content: "yes" }]), pending));
    expect(c.openQuestions).toBe(0);
  });
  it("ignores subagent (sidechain) lines and picks up the session title", () => {
    expect(parse(assistant("s1", [{ type: "text", text: "sub" }], { isSidechain: true }))).toEqual([]);
    expect(parseLine({ type: "ai-title", aiTitle: "Login page" }, "builder", new Set()).title).toBe("Login page");
  });
});

describe("reading a growing transcript", () => {
  it("an absorbed prompt is placed where the agent took it in, in every read, so older pages lose none (review M2)", async () => {
    const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
    const said = (uuid: string, s: number) => line({ type: "assistant", uuid, timestamp: at(s), message: { role: "assistant", content: [{ type: "text", text: uuid }] } });
    const taken = (uuid: string, sent: number) => line({ type: "attachment", uuid, timestamp: at(sent), isSidechain: false,
      attachment: { type: "queued_command", prompt: uuid, commandMode: "prompt", origin: { kind: "human" }, timestamp: at(sent), humanTurn: true } });
    const path = join(dir, "s.jsonl");
    // Written in this order: a1 at 0 s, a2 at 50 s, then q9 (sent at 10 s, taken in after a2), then a3 at 60 s.
    writeFileSync(path, said("a1", 0) + said("a2", 50) + taken("q9", 10) + said("a3", 60));
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    const c = new Conversation();
    c.add((await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries);
    const ms = (s: number) => Date.parse(T) + s * 1000;
    expect(c.latest().map(m => [m.id, m.at])).toEqual([["a1:0", ms(0)], ["a2:0", ms(50)], ["q9", ms(50)], ["a3:0", ms(60)]]);
    // The next read remembers how far the conversation had come.
    appendFileSync(path, taken("q10", 20));
    c.add((await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries);
    expect(c.latest().map(m => [m.id, m.at]).at(-1)).toEqual(["q10", ms(60)]);
    // Only the conversation's own lines say how far it had come: a bookkeeping line stamped an hour ahead moves nothing.
    const ahead = join(dir, "ahead.jsonl");
    writeFileSync(ahead, said("b1", 0) + line({ type: "file-history-delta", timestamp: at(3600) }) + taken("q1", 5) + said("b2", 20) + said("b3", 30));
    const c2 = new Conversation();
    c2.add((await followTranscript(localTranscriptBytes(ahead), { offset: 0, pending: new Set() }, "builder")).entries);
    expect(c2.latest().map(m => m.id)).toEqual(["b1:0", "q1", "b2:0", "b3:0"]);
    expect((await olderPage(localTranscriptBytes(ahead), "builder", "b3:0", { limit: 5 })).messages.map(m => m.id)).toEqual(["b1:0", "q1", "b2:0"]);
    // Older pages go by the file's order and agree: nothing between two pages is lost.
    const page = await olderPage(localTranscriptBytes(path), "builder", "a3:0", { limit: 2 });
    expect(page.messages.map(m => [m.id, m.at])).toEqual([["a2:0", ms(50)], ["q9", ms(50)]]);
    const first = await olderPage(localTranscriptBytes(path), "builder", "a2:0", { limit: 2 });
    expect(first.messages.map(m => m.id)).toEqual(["a1:0"]);
    expect(first.done).toBe(true);
  });
  it("reads only complete new lines, and starts mid-file at a line boundary", async () => {
    const path = join(dir, "t.jsonl");
    const read = async (cursor: TranscriptCursor, tailBytes?: number) =>
      (await followTranscript(localTranscriptBytes(path), cursor, "builder", tailBytes === undefined ? {} : { tailBytes })).entries;
    writeFileSync(path, user("u1", "first") + assistant("a1", [{ type: "text", text: "reply one" }]));
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    expect((await read(cursor)).map(e => e.id)).toEqual(["u1", "a1:0"]);
    appendFileSync(path, user("u2", "second").slice(0, 20));           // half a line: not read yet
    expect(await read(cursor)).toEqual([]);
    appendFileSync(path, user("u2", "second").slice(20));
    expect((await read(cursor)).map(e => e.id)).toEqual(["u2"]);
    const tailBytes = Buffer.byteLength(user("u2", "second")) + 5;                        // starts inside the line before u2
    expect((await read({ offset: 0, pending: new Set() }, tailBytes)).map(e => e.id)).toEqual(["u2"]);
  });
});

describe("files sent and received", () => {
  const tool = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const result = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
  const parseAll = async (lines: string[]) => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, lines.join(""));
    return followTranscript(localTranscriptBytes(path), { offset: 0, pending: new Set() }, "builder");
  };

  it("an agent's `lanes sendfile` becomes a file message with the paths lanes printed, and their captions", async () => {
    const p = await parseAll([
      assistant("a1", [tool("t1", `lanes sendfile /w/before.png "Before the fix" && lanes sendfile '/w/after.png' After`)]),
      user("u1", [result("t1", "sent /w/before.png\nsent /w/after.png")]),
    ]);
    const msg = p.entries.find(e => e.kind === "file");
    expect(msg).toMatchObject({ id: "t1:files", author: { kind: "agent", name: "builder" }, kind: "file" });
    expect(msg && "attachments" in msg ? msg.attachments : []).toEqual([
      { id: null, size: null, caption: "Before the fix", name: "before.png", mime: "image/png", kind: "image" },
      { id: null, size: null, caption: "After", name: "after.png", mime: "image/png", kind: "image" },
    ]);
    expect(p.files).toEqual([{ messageId: "t1:files", paths: ["/w/before.png", "/w/after.png"] }]);
  });
  it("a loop's files get no captions, a variable caption is never guessed, and output arrives in the content array form", async () => {
    const p = await parseAll([
      assistant("a1", [tool("t1", `for f in $M/*.png; do lanes sendfile "$f" "shot"; done`), tool("t2", `lanes sendfile /w/r.md "$TITLE"`)]),
      user("u1", [result("t1", [{ type: "text", text: "sent /w/a.png\nsent /w/b.png\nsent /w/c.png" }]), result("t2", "sent /w/r.md")]),
    ]);
    const all = p.entries.flatMap(e => (e.kind === "file" && e.attachments ? e.attachments : []));
    expect(all.map(a => [a.name, a.caption, a.kind])).toEqual([["a.png", null, "image"], ["b.png", null, "image"], ["c.png", null, "image"], ["r.md", null, "text"]]);
  });
  it("a failed send or another command's output makes no file message (negative control)", async () => {
    const p = await parseAll([
      assistant("a1", [tool("t1", "lanes sendfile /w/x.png"), tool("t2", "echo 'sent /etc/passwd'")]),
      user("u1", [result("t1", "sendfile: kira bot not reachable"), result("t2", "sent /etc/passwd")]),
    ]);
    expect(p.entries.filter(e => e.kind === "file")).toEqual([]);
    expect(p.files).toEqual([]);
  });
  it("the principal's file, as the chat bot types it, is attached to the principal's message", async () => {
    const p = await parseAll([user("u1", "Here is the error\n\n[The owner attached a file: /inbox/1790-photo.jpg]")]);
    const m = p.entries[0];
    expect(m && m.kind === "text" && m.attachments?.map(a => [a.name, a.kind])).toEqual([["1790-photo.jpg", "image"]]);
    expect(p.files).toEqual([{ messageId: "u1", paths: ["/inbox/1790-photo.jpg"] }]);
  });
});
