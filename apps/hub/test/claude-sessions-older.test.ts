// Older pages (ADR-0008 phase D, O9): up to 100 messages from before a given one, in time order: its line is found by its
// uuid, then one bounded window before it is parsed, each line once; an empty page means the beginning. Synthetic
// transcripts only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localTranscriptBytes, type TranscriptBytes } from "@morndo/node-ops";
import { olderPage } from "../src/adapters/claude-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-older-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 2, 8);
const reply = (n: number, pad = 0) => JSON.stringify({
  type: "assistant", uuid: `a${n}`, timestamp: new Date(T0 + n * 1000).toISOString(),
  message: { role: "assistant", content: [{ type: "text", text: `reply ${n}${" ".repeat(pad)}` }] },
});
function transcript(n: number, pad = 0) {
  const path = join(dir, "s.jsonl");
  writeFileSync(path, Array.from({ length: n }, (_, i) => reply(i, pad)).join("\n") + "\n");
  return path;
}
const texts = (r: { messages: { text: string }[] }) => r.messages.map(m => m.text.trim());
// A transcript's bytes that count what is asked of them.
function counting(b: TranscriptBytes) {
  const c = {
    bytesRead: 0, locates: 0,
    size: () => b.size(),
    read: async (offset: number, max: number) => { const r = await b.read(offset, max); c.bytesRead += r?.bytes.length ?? 0; return r; },
    locate: (needle: string) => { c.locates++; return b.locate(needle); },
  };
  return c;
}

describe("olderPage", () => {
  it("returns the 100 messages before the given one, oldest first", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(500)), "builder", "a400:0");
    expect(r.messages).toHaveLength(100);
    expect(texts(r)[0]).toBe("reply 300");
    expect(texts(r).at(-1)).toBe("reply 399");
    expect(r.done).toBe(false);
  });
  it("near the start: fewer, and done", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(500)), "builder", "a30:0");
    expect(texts(r)).toEqual(Array.from({ length: 30 }, (_, i) => `reply ${i}`));
    expect(r.done).toBe(true);
  });
  it("before the first message: an empty page, the beginning of the conversation", async () => {
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "a0:0")).toMatchObject({ messages: [], done: true });
  });
  it("reads across many small chunks, without losing or doubling a line at a chunk's edge", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(400, 300)), "builder", "a250:0", { chunk: 1024 });   // ~350-byte lines, 1 KB chunks
    expect(texts(r)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${150 + i}`));
  });
  it("a message it can't find (the transcript was replaced) gives nothing and says so: not the beginning (review L1)", async () => {
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "nope")).toMatchObject({ messages: [], done: false, missing: true });
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "a99:0")).toMatchObject({ messages: [], done: false, missing: true });
  });
  it("keeps multibyte characters whole across chunk edges", async () => {
    const path = join(dir, "u.jsonl");
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => JSON.stringify({
      type: "assistant", uuid: `u${i}`, timestamp: new Date(T0 + i * 1000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `ü中🚀 ${i}` }] },
    })).join("\n") + "\n");
    const r = await olderPage(localTranscriptBytes(path), "builder", "u40:0", { chunk: 97 });
    expect(texts(r).at(-1)).toBe("ü中🚀 39");
    expect(r.messages).toHaveLength(40);
  });
  it("a page that ends inside one line keeps that line's earlier blocks", async () => {
    const path = join(dir, "b.jsonl");
    writeFileSync(path, [reply(0), JSON.stringify({
      type: "assistant", uuid: "two", timestamp: new Date(T0 + 5000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] },
    })].join("\n") + "\n");
    expect(texts(await olderPage(localTranscriptBytes(path), "builder", "two:1"))).toEqual(["reply 0", "first block"]);
  });
  it("parses each line once, however far back the page is (review M1: it was quadratic)", async () => {
    const path = transcript(3000, 200);                                     // ~270-byte lines, 1 KB chunks: ~800 chunks
    const parse = vi.spyOn(JSON, "parse");
    try {
      const r = await olderPage(localTranscriptBytes(path), "builder", "a150:0", { chunk: 1024 });
      expect(texts(r)[0]).toBe("reply 50");
      expect(parse.mock.calls.length).toBeLessThan(2 * 3000);
    } finally { parse.mockRestore(); }
  });
  it("the next page ends where the last one began: found without a search, the same page as with one", async () => {
    const bytes = counting(localTranscriptBytes(transcript(3000, 200)));
    const first = await olderPage(bytes, "builder", "a2900:0");
    expect(first.resume?.id).toBe("a2800:0");
    expect(bytes.locates).toBe(1);
    const next = await olderPage(bytes, "builder", "a2800:0", { from: first.resume?.end });
    expect(bytes.locates).toBe(1);                                          // the hint held: no second search
    expect(texts(next)[0]).toBe("reply 2700");
    expect(texts(next).at(-1)).toBe("reply 2799");
    expect(await olderPage(bytes, "builder", "a2800:0")).toEqual(next);   // negative control: no hint, a search, the same page
    expect(bytes.locates).toBe(2);
  });
  it("reads one window before the message: a small one holds fewer messages, and the pages still join up", async () => {
    const bytes = counting(localTranscriptBytes(transcript(3000, 200)));   // ~270-byte lines: 10 KiB holds ~37
    const page = await olderPage(bytes, "builder", "a2900:0", { window: 10 << 10 });
    expect(page.messages.length).toBeGreaterThan(20);
    expect(page.messages.length).toBeLessThan(100);
    expect(page.done).toBe(false);
    expect(bytes.bytesRead).toBeLessThanOrEqual((10 << 10) + 4096);       // the window and the message's own short line
    const oldest = Number(texts(page)[0]?.replace("reply ", ""));
    const next = await olderPage(bytes, "builder", page.messages[0]?.id ?? "", { window: 10 << 10, from: page.resume?.end });
    expect(texts(next).at(-1)).toBe(`reply ${oldest - 1}`);               // nothing between the two pages lost
  });
  it("a hint that no longer fits (the transcript changed) falls back to the search", async () => {
    const path = transcript(500);
    expect(texts(await olderPage(localTranscriptBytes(path), "builder", "a400:0", { from: 10 }))[0]).toBe("reply 300");
  });
});
