// renderTranscript (T-336): which rows of a Claude Code session file `morndo lanes peek` shows as transcript text. It is
// the hub's own reading of the file (claude-sessions.ts parseLine), so a row shows here exactly when it shows in a
// conversation; the cut a chunk makes is on bytes, so it never breaks a character. Made-up messages only.
import { describe, expect, it } from "vitest";
import { renderTranscript } from "../src/console/transcript-tail.ts";

const enc = new TextEncoder();
const row = (type: "user" | "assistant", content: unknown, extra: object = {}) =>
  JSON.stringify({ type, uuid: `u-${Math.random()}`, timestamp: "2026-10-26T10:00:00Z", message: { role: type, content }, ...extra });
const bytes = (rows: string[]) => enc.encode(`${rows.join("\n")}\n`);

describe("renderTranscript", () => {
  it("shows what a conversation shows: text of both sides, a compaction as a one-line event; never a summary, local command output, meta rows, tool calls or results", () => {
    const out = renderTranscript(bytes([
      row("user", "hello"),
      row("assistant", [{ type: "text", text: "hi\nthere" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "echo X-TOOL" } }]),
      row("user", [{ type: "tool_result", tool_use_id: "t", content: "X-RESULT" }]),
      row("user", "long summary X-SUMMARY", { isCompactSummary: true }),
      row("user", "<local-command-stdout>X-LOCAL</local-command-stdout>"),
      row("user", "<bash-stdout>X-BASH</bash-stdout>"),
      row("user", "reminder X-META", { isMeta: true }),
      row("assistant", [{ type: "text", text: "side X-SIDE" }], { isSidechain: true }),
      row("assistant", [{ type: "thinking", thinking: "X-THINK" }, { type: "text", text: "done" }]),
    ]), false);
    expect(out).toEqual(["user: hello", "assistant: hi", "there", "Morndo: The conversation was compacted.", "assistant: done"]);
    expect(out.join("\n")).not.toMatch(/X-/);
  });

  it("drops the first piece of a read that began inside a line, even a cut inside a multi-byte character, and breaks no character", () => {
    const whole = bytes([row("user", "ü ö ä — first"), row("assistant", [{ type: "text", text: "second ü" }]), row("user", "third ö")]);
    const cut = Buffer.from(whole).indexOf("ö") + 1;                   // one byte into the 2-byte "ö" of the first row
    const out = renderTranscript(whole.subarray(cut), true);
    expect(out).toEqual(["assistant: second ü", "user: third ö"]);
    expect(out.join("\n")).not.toContain("�");
  });

  it("skips a first line that does not parse (a torn start the caller did not drop) and keeps the rest", () => {
    const whole = bytes([row("user", "first"), row("assistant", [{ type: "text", text: "second" }])]);
    const torn = whole.subarray(12);                                    // inside the first row
    expect(renderTranscript(torn, false)).toEqual(["assistant: second"]);
    expect(renderTranscript(bytes(["not json at all", row("user", "kept")]), false)).toEqual(["user: kept"]);
    expect(renderTranscript(new Uint8Array(0), true)).toEqual([]);
  });
});
