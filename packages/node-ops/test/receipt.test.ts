// The transcript receipt (src/receipt.ts; docs/design/fleet-clients/README.md §4.3, §1; plan.md Review Focus 1): the manager
// inbox's receipt rules and their tests (the chat bot's inbox tests, "transcript receipts", and its review fixes' finding 1),
// ported, and every entry kind Claude Code 2.1.293 writes, each from a recorded transcript in
// test/fixtures/claude-code/2.1.293: synthetic texts in the shapes and with the keys seen on the owner's PC on 2026-10-08.
// Not ported: the inbox's visible id ("⟨m:…⟩"), which Morndo never types.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newSessionReceipt, promptMatches, readReceipts, startsNewSession, type PendingText } from "../src/receipt.ts";

const FIXTURES = join(import.meta.dirname, "../../../test/fixtures/claude-code/2.1.293");
const lines = (name: string) => readFileSync(join(FIXTURES, name), "utf8").split("\n").filter(Boolean);
const at = (hms: string) => Date.parse(`2026-10-08T${hms}Z`);
const T0 = at("11:59:00.000");                                     // every fixture's text was typed after this
const pending = (id: string, text: string, typedAt = T0): PendingText => ({ id, text, typedAt });
const verdicts = (rows: string[], p: PendingText[]) => readReceipts(rows, p).map(r => `${r.id}:${r.verdict}`);

describe("the inbox's rules, ported", () => {
  const row = (o: object) => JSON.stringify({ timestamp: "2026-10-08T12:00:00.000Z", ...o });
  const of = (o: object, text = "q") => verdicts([row(o)], [pending("d1", text)]);
  it("the row kinds Claude Code writes for a prompt", () => {
    expect(of({ type: "user", message: { content: "hi" } }, "hi")).toEqual(["d1:delivered"]);
    expect(of({ type: "user", message: { content: [{ type: "tool_result", content: "x" }] } }, "x")).toEqual([]);
    expect(of({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }, { type: "text", text: "x" }] } }, "x")).toEqual([]);
    expect(of({ type: "user", message: { content: [{ type: "text", text: "a" }, { type: "image" }] } }, "a")).toEqual(["d1:delivered"]);
    expect(of({ type: "queue-operation", operation: "enqueue", content: "q" })).toEqual(["d1:held"]);
    expect(of({ type: "queue-operation", operation: "remove", content: "q", reason: "absorbed_mid_turn" })).toEqual(["d1:delivered"]);
    expect(of({ type: "queue-operation", operation: "dequeue" })).toEqual([]);
    expect(of({ type: "attachment", attachment: { type: "queued_command", prompt: "q" } })).toEqual(["d1:delivered"]);
    expect(of({ type: "user", isSidechain: true, message: { content: "q" } })).toEqual([]);
  });
  it("an interrupt that clears Claude Code's queue (remove, cleared_on_cancel) is not a delivery (review fix 1)", () => {
    expect(of({ type: "queue-operation", operation: "remove", content: "x", reason: "cleared_on_cancel" }, "x")).toEqual(["d1:dropped"]);
    expect(of({ type: "queue-operation", operation: "remove", content: "x", reason: "absorbed_mid_turn" }, "x")).toEqual(["d1:delivered"]);
  });
  it("a remove without a reason gives no verdict (the inbox took it as a delivery; 2.1.293 always writes a reason)", () => {
    expect(of({ type: "queue-operation", operation: "remove", content: "q" })).toEqual([]);
  });
  it("matching: exact, a pasted_content wrapper, the [Pasted text] form, inside a merged prompt", () => {
    const typed = "[lane-event] Lane events:\n{\"ts\":1}\n{\"ts\":2}";
    expect(promptMatches(typed, `${typed}  \r\n`)).toBe(true);
    const tap = "[tap ny-176] deploy-morndo (Go live after the review)";
    expect(promptMatches(tap, `\n\n<pasted_content id="0512">\n${tap}\n</pasted_content id="0512">\n`)).toBe(true);
    expect(promptMatches("ship it", `\n\n<pasted_content id="c1d2">\nship it\n</pasted_content id="c1d2">\n`)).toBe(true);   // too short to be found inside: the wrapper itself
    expect(promptMatches(tap, `Make sure to queue\n\n${tap}`)).toBe(true);
    expect(promptMatches(tap, `${tap} and more`)).toBe(false);                     // not a whole line
    expect(promptMatches("a\nb\nc", "[Pasted text #3 +2 lines]")).toBe(true);
    expect(promptMatches("a\nb\nc", "[Pasted text #3 +9 lines]")).toBe(false);
    expect(promptMatches("x  \n y \n", "x\n y")).toBe(true);                       // line ends and both ends trimmed
  });
  it("a short text is never found inside another prompt, only as a whole one (negative control)", () => {
    expect(promptMatches("ok", "fine\nok")).toBe(false);
    expect(promptMatches("ok", "ok")).toBe(true);
  });
  it("matches the text as the paste typed it: control characters but newline and tab dropped", () => {
    expect(promptMatches("a\x1b[201~b", "a[201~b")).toBe(true);
    expect(promptMatches("one\r\ntwo", "one\ntwo")).toBe(true);
  });
});

describe("each kind 2.1.293 writes, from a recorded transcript", () => {
  it("a prompt typed at the box: delivered", () => {
    expect(readReceipts(lines("typed-prompt.jsonl"), [pending("d1", "[fixture] a line typed at the box")]))
      .toEqual([{ id: "d1", verdict: "delivered", at: at("12:00:01.000") }]);
  });
  it("typed while busy and taken as the next prompt: held, then delivered by the prompt after the dequeue", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken as the next prompt")];
    const rows = lines("queued-then-prompt.jsonl");
    expect(readReceipts(rows, p)).toEqual([{ id: "d1", verdict: "held", at: at("12:01:00.000") }, { id: "d1", verdict: "delivered", at: at("12:01:30.050") }]);
  });
  it("a dequeue gives no verdict, without a text as recorded or with one (negative control)", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken as the next prompt")];
    const dequeue = lines("queued-then-prompt.jsonl")[1] ?? "";
    expect(readReceipts([dequeue], p)).toEqual([]);
    const withText = JSON.stringify({ ...(JSON.parse(dequeue) as object), content: "[fixture] typed while busy, taken as the next prompt" });
    expect(readReceipts([withText], p)).toEqual([]);
  });
  it("taken into the running turn (remove absorbed_mid_turn): delivered; the queued_command alone delivers too", () => {
    const p = [pending("d1", "[fixture] typed while busy, taken into the running turn")];
    const rows = lines("absorbed-mid-turn.jsonl");
    expect(verdicts(rows, p)).toEqual(["d1:held", "d1:delivered"]);
    expect(readReceipts(rows, p)[1]?.at).toBe(at("12:02:05.000"));
    expect(readReceipts([rows[2] ?? ""], p)).toEqual([{ id: "d1", verdict: "delivered", at: at("12:02:00.000") }]);
  });
  it("remove delivered_to_agent: delivered", () => {
    expect(verdicts(lines("delivered-to-agent.jsonl"), [pending("d1", "[fixture] handed to the agent")])).toEqual(["d1:held", "d1:delivered"]);
  });
  it("remove cleared_on_cancel: dropped, never delivered (negative control)", () => {
    expect(verdicts(lines("cleared-on-cancel.jsonl"), [pending("d1", "[fixture] dropped by an interrupt")])).toEqual(["d1:held", "d1:dropped"]);
  });
  it("a remove reason not known here: no verdict, the delivery stays held", () => {
    expect(verdicts(lines("unknown-remove-reason.jsonl"), [pending("d1", "[fixture] removed for a reason not known here")])).toEqual(["d1:held"]);
  });
  it("a pasted text comes back wrapped: typed at the box, and held then taken into the turn", () => {
    const text = "[fixture] pasted line one\n[fixture] pasted line two\n[fixture] pasted line three";
    const p = [pending("d1", text), pending("d2", text, at("12:06:10.000"))];
    expect(readReceipts(lines("pasted-wrapper.jsonl"), p)).toEqual([
      { id: "d1", verdict: "delivered", at: at("12:06:00.000") },
      { id: "d2", verdict: "held", at: at("12:06:30.000") },
      { id: "d2", verdict: "delivered", at: at("12:06:35.000") },
    ]);
  });
  it("the input box's short form of a long paste: held", () => {
    expect(verdicts(lines("pasted-short-form.jsonl"), [pending("d1", "[fixture] one\n[fixture] two\n[fixture] three")])).toEqual(["d1:held"]);
  });
  it("a subagent's entry, a tool result, a meta entry and a compaction's summary are not prompts (negative controls)", () => {
    const p = ["[fixture] seen by a subagent only", "[fixture] seen in a tool result only", "[fixture] seen in a meta entry only",
      "[fixture] quoted by a compaction summary"].map((t, i) => pending(`d${i}`, t));
    expect(readReceipts(lines("not-prompts.jsonl"), p)).toEqual([]);
  });
});

describe("a slash command (Review Focus 1)", () => {
  it("/compact is confirmed by its command entry, not by the summary that quotes it", () => {
    expect(readReceipts(lines("slash-command.jsonl"), [pending("d1", "/compact", at("12:08:00.000"))]))
      .toEqual([{ id: "d1", verdict: "delivered", at: at("12:08:40.030") }]);
  });
  const entry = (name: string, args: string) =>
    `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>`;
  it("a command with arguments: the same name and the same arguments", () => {
    expect(promptMatches("/compact keep the parser notes", entry("/compact", "keep the parser notes"))).toBe(true);
    expect(promptMatches("/telegram:access pair", "<command-message>telegram:access</command-message>\n<command-name>/telegram:access</command-name>\n<command-args>pair</command-args>")).toBe(true);
    expect(promptMatches("/goal fix <x> & ship", entry("/goal", "fix &lt;x&gt; &amp; ship"))).toBe(true);
  });
  it("another command, other arguments, or a text that isn't a command: no match (negative controls)", () => {
    expect(promptMatches("/compact", entry("/clear", ""))).toBe(false);
    expect(promptMatches("/compact keep notes", entry("/compact", "drop notes"))).toBe(false);
    expect(promptMatches("/compact", entry("/compact", "keep notes"))).toBe(false);
    expect(promptMatches("compact", entry("/compact", ""))).toBe(false);
    expect(promptMatches("/compact", "/compact")).toBe(true);                          // taken as a prompt instead: matches as text
  });
});

describe("which pending text an entry decides", () => {
  const typedRow = (text: string, hms: string) => JSON.stringify({ type: "user", message: { content: text }, timestamp: `2026-10-08T${hms}Z` });
  it("two deliveries of one text need two receipts; the earliest typed goes first", () => {
    const p = [pending("d2", "same", at("12:00:02.000")), pending("d1", "same", at("12:00:01.000"))];
    expect(verdicts([typedRow("same", "12:00:03.000")], p)).toEqual(["d1:delivered"]);
    expect(verdicts([typedRow("same", "12:00:03.000"), typedRow("same", "12:00:04.000")], p)).toEqual(["d1:delivered", "d2:delivered"]);
  });
  it("an entry from before a text was typed decides nothing (negative control)", () => {
    expect(verdicts([typedRow("same", "12:00:00.000")], [pending("d1", "same", at("12:00:01.000"))])).toEqual([]);
  });
  it("an enqueue holds a text once; the next enqueue of the same text holds the next pending one", () => {
    const enq = (hms: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "same", timestamp: `2026-10-08T${hms}Z` });
    const p = [pending("d1", "same", at("12:00:01.000")), pending("d2", "same", at("12:00:02.000"))];
    expect(verdicts([enq("12:00:03.000"), enq("12:00:04.000"), typedRow("same", "12:00:05.000")], p)).toEqual(["d1:held", "d2:held", "d1:delivered"]);
  });
  it("a line that isn't JSON, a kind it doesn't know and an entry without a time give no verdict", () => {
    expect(verdicts(["{\"type\":\"user\",\"mess", "not json", JSON.stringify({ type: "summary", summary: "same", timestamp: "2026-10-08T12:00:03.000Z" }),
      JSON.stringify({ type: "user", message: { content: "same" } })], [pending("d1", "same")])).toEqual([]);
  });
});

describe("a command that starts a new session (/clear, /reset, /new)", () => {
  it("is known from its text, with or without its argument", () => {
    for (const t of ["/clear", "/clear release-prep", "/reset", "/new", "/new  "]) expect(startsNewSession(t), t).toBe(true);
    for (const t of ["/compact", "/clearer", "/newt", " /clear", "clear", "/clear\nand more", "please /clear"]) expect(startsNewSession(t), JSON.stringify(t)).toBe(false);
  });
  it("is recorded only in the new session's transcript: the session it was typed into has no verdict", () => {
    const newSession = lines("clear-new-session.jsonl");
    expect(newSession.findIndex(l => l.includes("<command-name>/clear</command-name>"))).toBe(6);              // its 7th line
    expect(readReceipts(newSession, [pending("d1", "/clear")])).toEqual([{ id: "d1", verdict: "delivered", at: at("12:10:01.040") }]);
    expect(readReceipts(lines("typed-prompt.jsonl"), [pending("d1", "/clear")])).toEqual([]);
  });
  it("its receipt is the pane's session changing to another id after the typing (negative control)", () => {
    expect(newSessionReceipt("/clear", "s-old", "s-new")).toBe(true);
    expect(newSessionReceipt("/new", "s-old", "s-old")).toBe(false);
    expect(newSessionReceipt("/clear", "s-old", null)).toBe(false);
    expect(newSessionReceipt("/compact", "s-old", "s-new")).toBe(false);
  });
});

// The engine layer's lane (test/fixtures/engine-lane/transcript.jsonl, lane.py `_log`): a `user` line when the lane takes a
// message, timestamped in whole seconds. Its time can't say a line came after a text was typed in the same second, so the
// deliverer gives each text the transcript's byte offset from before the typing: only lines from there on can be its receipt.
describe("the engine layer's lane transcript", () => {
  const fixture = readFileSync(join(import.meta.dirname, "../../../test/fixtures/engine-lane/transcript.jsonl"), "utf8").split("\n").filter(Boolean);
  const typedAt = (hms: string) => Date.parse(`2026-10-16T${hms}Z`);
  const starts = (rows: string[]) => { let at = 0; return rows.map(r => { const s = at; at += Buffer.byteLength(r) + 1; return s; }); };
  const user = (text: string, hms: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: `2026-10-16T${hms}Z` });
  const withOffsets = (rows: string[], p: PendingText[]) => readReceipts(rows, p, starts(rows)).map(r => `${r.id}:${r.verdict}`);

  it("delivers a text the lane took after the offset it was typed at, in the second it was typed in", () => {
    expect(withOffsets(fixture, [{ ...pending("d1", "Build the demo", typedAt("05:00:03.800")), after: 0 }])).toEqual(["d1:delivered"]);
  });
  it("does not take a line from before that offset for the receipt: two identical short briefs a moment apart (negative control)", () => {
    const rows = [user("continue", "05:00:03"), user("something else", "05:00:03")];
    const second = { ...pending("d2", "continue", typedAt("05:00:03.900")), after: starts(rows)[1]! };
    expect(withOffsets(rows, [second])).toEqual([]);
    const next = [...rows, user("continue", "05:00:03")];
    expect(withOffsets(next, [second])).toEqual(["d2:delivered"]);
    expect(withOffsets(next, [{ ...second, id: "d1", after: 0 }, second])).toEqual(["d1:delivered", "d2:delivered"]);   // each line decides one text
  });
  it("without an offset (after a restart) only a line from a later second counts: same-second order can't be told", () => {
    expect(verdicts(fixture, [pending("d1", "Build the demo", typedAt("05:00:03.800"))])).toEqual([]);
    expect(verdicts(fixture, [pending("d1", "Build the demo", typedAt("05:00:02.800"))])).toEqual(["d1:delivered"]);
  });
  it("keeps a time with a fraction exact, and an offset does not excuse a line before the typing", () => {
    const row = JSON.stringify({ type: "user", message: { content: "hi" }, timestamp: "2026-10-16T05:00:03.100Z" });
    expect(readReceipts([row], [{ ...pending("d1", "hi", typedAt("05:00:03.800")), after: 0 }], [0])).toEqual([]);
    expect(readReceipts([row], [{ ...pending("d1", "hi", typedAt("05:00:03.000")), after: 0 }], [0]).map(r => r.verdict)).toEqual(["delivered"]);
  });
  it("gives no verdict for the lane's other lines", () => {
    expect(verdicts(fixture, [pending("d1", "working", typedAt("05:00:00.000")), pending("d2", "STATUS: DONE", typedAt("05:00:00.000"))])).toEqual([]);
  });
});
