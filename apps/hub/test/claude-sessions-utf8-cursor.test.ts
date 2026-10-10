// The transcript cursor is a byte offset. On the first read of a transcript longer than the window, followTranscript
// skips the partial line it jumped into; multibyte text on that line must not move the cursor off the line ends,
// or a line appended later is lost (or old lines come back).
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTranscriptBytes } from "@morndo/node-ops";
import { followTranscript, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-utf8-cursor-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const WINDOW = 2 << 20;                                   // followTranscript's default first-read window (tailBytes)
const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const T = "2026-10-01T08:00:00.000Z";
const user = (uuid: string, content: unknown) => line({ type: "user", uuid, timestamp: T, message: { role: "user", content }, origin: { kind: "human" } });
const assistant = (uuid: string, content: unknown[]) => line({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content } });
const ask = (id: string) => assistant(`a-${id}`, [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "Merge now?" }] } }]);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// The line the window cuts ("s1") holds `count` copies of `char`; the window starts `into` bytes into the first copy
// (0: on the ASCII just before the run). The last line ends in em dashes. Everything in between is ASCII filler.
type Layout = { name: string; char: string; count: number; into: number };
const LAYOUTS: Layout[] = [
  { name: "3-byte characters (CJK) on the cut line", char: "日", count: 4, into: 0 },
  { name: "2-byte characters (umlauts) on the cut line", char: "ä", count: 8, into: 0 },
  { name: "4-byte characters (emoji) on the cut line", char: "😀", count: 4, into: 0 },
  { name: "the window starts inside a 3-byte character", char: "—", count: 5, into: 1 },
];

function writeTranscript(layout: Layout): string {
  const s = user("s1", "x".repeat(40) + layout.char.repeat(layout.count) + "y".repeat(10));
  const runAt = Buffer.from(s).indexOf(Buffer.from(layout.char));
  const cut = layout.into ? runAt + layout.into : runAt - 20;          // byte offset of the window's start inside s1
  const last = assistant("t1", [{ type: "text", text: "Done " + "—".repeat(10) }]);
  const filler: string[] = [];
  let need = WINDOW - bytes(s) - bytes(last) + cut;                      // so that size - WINDOW === cut
  const fill = (i: number, len: number) => {
    const empty = assistant(`m${String(i).padStart(5, "0")}`, [{ type: "text", text: "" }]);
    return assistant(`m${String(i).padStart(5, "0")}`, [{ type: "text", text: "z".repeat(len - bytes(empty)) }]);
  };
  for (let i = 0; need > 2000; i++) { filler.push(fill(i, 1000)); need -= 1000; }
  filler.push(fill(filler.length, need));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, s + filler.join("") + last);
  // The layout is the adversarial one: the window cuts s1, and the cut line's bytes minus its UTF-16 length,
  // counted back from the end of the file, lands on a UTF-8 continuation byte of the last line.
  const file = readFileSync(path);
  expect(file.length - WINDOW).toBe(cut);
  const skipped = file.subarray(cut, file.indexOf(0x0a, cut) + 1);
  const drift = skipped.length - skipped.toString("utf8").length;
  expect(drift).toBeGreaterThan(0);
  expect((file[file.length - drift] as number) & 0xc0).toBe(0x80);
  return path;
}

const ids = async (path: string, cursor: TranscriptCursor) => (await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries.map(e => e.id);

for (const layout of LAYOUTS) {
  describe(`a transcript longer than the read window, ${layout.name}`, () => {
    it("the first read starts at a line boundary", async () => {
      const first = await ids(writeTranscript(layout), { offset: 0, pending: new Set() });
      expect(first).not.toContain("s1");
      expect(first.at(-1)).toBe("t1:0");
    });

    it("idle polls return nothing", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      for (let poll = 1; poll <= 3; poll++) expect((await ids(path, cursor)).length, `entries returned by idle poll ${poll}`).toBe(0);
    });

    it("a question appended after an idle poll is returned exactly once", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      expect(await ids(path, cursor)).toEqual([]);                       // nothing new yet
      appendFileSync(path, ask("q1"));
      expect(await ids(path, cursor)).toEqual(["q1"]);
    });

    it("lines appended between polls are each returned exactly once", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      appendFileSync(path, ask("q1"));
      expect(await ids(path, cursor)).toEqual(["q1"]);
      appendFileSync(path, user("u2", "And the docs too, please."));
      expect(await ids(path, cursor)).toEqual(["u2"]);
    });
  });
}
