// The end of a lane's session transcript as plain text, for `morndo lanes peek --lines N` on a pane that runs on tmux's
// alternate screen (Claude Code's fullscreen renderer, https://code.claude.com/docs/en/fullscreen, read 2026-10-26):
// tmux keeps no scrollback there (capture-pane -S: "negative numbers are lines in the history", and the alternate screen
// has none), so the screen is all a capture can give and the transcript's last lines are added in front of it.
import type { FleetClient } from "@morndo/fleet-client";
import { LIMITS, redactKeyMaterial } from "@morndo/protocol";
import { parseLine } from "../adapters/claude-sessions.ts";

// The bytes' messages as "<role>: <text>" lines, the hub's own reading of the session file: each line is parsed with
// parseLine (claude-sessions.ts), so a row shows here exactly when it shows in a conversation — tool calls, tool results
// and thinking blocks never, nor sidechain rows, meta rows, compact summaries' text or local command output; a compaction
// shows as its one event line. The split on 0x0a comes before the UTF-8 decoding, because a chunk can cut a multi-byte
// character in half; with dropFirstPartialLine the first piece is such a cut, not a line. A line that does not parse is
// skipped. A message's own newlines stay, so it is one or more lines.
export function renderTranscript(jsonl: Uint8Array, dropFirstPartialLine: boolean): string[] {
  const pieces: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < jsonl.length; i++) {
    if (jsonl[i] === 0x0a) { pieces.push(jsonl.subarray(start, i)); start = i + 1; }
  }
  pieces.push(jsonl.subarray(start));
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (const piece of dropFirstPartialLine ? pieces.slice(1) : pieces) {
    let line: unknown;
    try { line = JSON.parse(decoder.decode(piece)); } catch { continue; }
    if (line === null || typeof line !== "object" || Array.isArray(line)) continue;
    // parseLine skips a sidechain row only on the assistant and attachment sides, so a subagent's user rows are dropped here.
    if ((line as { isSidechain?: unknown }).isSidechain === true) continue;
    let entries: ReturnType<typeof parseLine>["entries"];
    try { entries = parseLine(line as Parameters<typeof parseLine>[0], "assistant", new Set()).entries; } catch { continue; }   // an odd block (null) throws there: the line is skipped like one that does not parse
    for (const e of entries) {
      // "text" and "event" are the messages ("answer" entries carry no author, and questions, activity and files are not
      // prose). The label is the person's word for the author: "user", "assistant", or the author's own name.
      if ((e.kind !== "text" && e.kind !== "event") || !("author" in e)) continue;
      const label = e.author.kind === "principal" ? "user" : e.author.kind === "agent" ? "assistant" : e.author.name;
      out.push(...`${label}: ${e.text}`.split("\n"));
    }
  }
  return out;
}

// At most 1 MiB of transcript (LIMITS.chunkBytes each): more than any screen's worth of lines, without dragging a huge
// session over the fleet for a peek.
const TAIL_CHUNKS = 4;

// The last `lines` lines of the lane's session transcript on `node`, plain text and redacted, or why there are none.
// Reads backwards from the end in ranges of at most LIMITS.chunkBytes (a read may come back short, so a range is asked
// for until it is covered; eof or an empty read ends it), prepending older chunks, until enough lines or the start of
// the file. The redaction is key material only (redactKeyMaterial): the transcript is the lane's own words, and the
// hub's home directory is not the node's. It runs over the joined text, so a key wrapped over two lines is caught.
export async function transcriptTail(client: FleetClient, node: string, sessionId: string, lines: number): Promise<{ ok: true; lines: string[] } | { ok: false; note: string }> {
  const unreadable = (message: string) => ({ ok: false as const, note: `its transcript can't be read here (${message.replace(/\s+/g, " ").trim()})` });
  const sizeAnswer = await client.op({ node }, "transcript.size", { sessionId }, { timeoutMs: 5000 });
  if (!sizeAnswer.ok) return unreadable(sizeAnswer.error.message);
  if (sizeAnswer.result.size === null) return { ok: false, note: "its session transcript is gone" };
  let end = sizeAnswer.result.size;
  let have = new Uint8Array(0);
  let rendered: string[] = [];
  let start = end;
  for (let n = 0; n < TAIL_CHUNKS && start > 0; n++) {
    start = Math.max(0, end - LIMITS.chunkBytes);
    const parts: Buffer[] = [];
    let at = start;
    while (at < end) {
      const r = await client.op({ node }, "transcript.read", { sessionId, offset: at, max: end - at }, { timeoutMs: 5000 });
      if (!r.ok) return unreadable(r.error.message);
      const bytes = Buffer.from(r.result.bytes, "base64");
      if (bytes.length === 0) break;                        // nothing more comes back
      parts.push(bytes);
      at += bytes.length;
      if (r.result.eof) break;
    }
    if (at < end) return unreadable("a read came back empty before the end of the range");   // a gap would join two lines
    have = Buffer.concat([...parts, have]);                 // the older chunk goes in front of the newer ones
    rendered = renderTranscript(have, start > 0);
    if (rendered.length >= lines) break;
    end = start;
  }
  if (rendered.length === 0) return { ok: false, note: "its transcript holds no messages" };
  const all = redactKeyMaterial(rendered.join("\n")).split("\n");
  return { ok: true, lines: all.slice(-lines) };
}
