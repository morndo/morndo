// Long transcript lines (docs/design/fleet-core/README.md §3.1, §9 "Long lines"; real transcripts have lines up to
// 3.7 MB). The follow reads in bounded pieces, at most one chunk (LIMITS.chunkBytes) each, as a node serves them through
// the fleet, and carries a line across them: a 3 MB line arrives whole, a 10 MB one is skipped as one message too large
// to show, and the follow goes on past both. Negative control: the old reader, without the carry, stalls on the 3 MB
// line. Synthetic transcripts only.
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "@morndo/domain";
import { localTranscriptBytes, type TranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { MAX_LINE_BYTES, followTranscript, olderPage, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-long-lines-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = "2026-10-06T08:00:00.000Z";
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const user = (uuid: string, content: string) => line({ type: "user", uuid, timestamp: T, message: { role: "user", content }, origin: { kind: "human" } });
const assistant = (uuid: string, text: string) => line({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content: [{ type: "text", text }] } });

// The bytes, checking that no read asks for or gets more than one chunk.
function bounded(path: string): TranscriptBytes {
  const b = localTranscriptBytes(path);
  return {
    size: () => b.size(),
    read: async (offset, max) => {
      expect(max).toBeLessThanOrEqual(LIMITS.chunkBytes);
      const r = await b.read(offset, max);
      expect(r?.bytes.length ?? 0).toBeLessThanOrEqual(LIMITS.chunkBytes);
      return r;
    },
    locate: needle => b.locate(needle),
  };
}
const carried = (c: TranscriptCursor) => (c.carry ?? []).reduce((n, part) => n + part.length, 0);
// Polls the follow `polls` times, one chunk per poll, so the carry is checked after every read: it never holds more
// than one line's limit. What the follow returned, in order.
async function follow(src: TranscriptBytes, cursor: TranscriptCursor, polls: number): Promise<ConversationEntry[]> {
  const out: ConversationEntry[] = [];
  for (let i = 0; i < polls; i++) {
    out.push(...(await followTranscript(src, cursor, "builder", { budget: LIMITS.chunkBytes })).entries);
    expect(carried(cursor)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  }
  return out;
}

// readTranscript as it was before the carry (claude-sessions.ts at 38ea4be, lines 259-298): the same rules, but its
// bytes come through the same bounded reads, at most one chunk per poll. It can only take the complete lines inside
// what one read returns; with none there it returns nothing and doesn't move.
async function oldFollow(src: TranscriptBytes, cursor: { offset: number }, tailBytes = 2 << 20): Promise<string[]> {
  const size = (await src.size()) ?? 0;
  if (size < cursor.offset) cursor.offset = 0;
  const start = cursor.offset === 0 && size > tailBytes ? size - tailBytes : cursor.offset;
  if (start >= size) return [];
  const r = await src.read(start, Math.min(size - start, LIMITS.chunkBytes));
  if (!r) return [];
  const buf = Buffer.from(r.bytes);
  let from = 0;
  if (start > cursor.offset) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return [];
    from = nl + 1;
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < from) return [];                                          // no complete line yet
  cursor.offset = start + end + 1;
  return buf.toString("utf8", from, end).split("\n").filter(l => l.trim()).map(l => String((JSON.parse(l) as { uuid?: unknown }).uuid));
}

describe("the follow over bounded reads", () => {
  it("a 3 MB line arrives whole, and the follow goes on past it", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + assistant("a1", "reply one"));
    const src = bounded(path);
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    expect((await follow(src, cursor, 1)).map(e => e.id)).toEqual(["u1", "a1:0"]);
    appendFileSync(path, user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const got = await follow(src, cursor, 15);                       // 3 MB in 256 KiB reads: 12
    expect(got.map(e => e.id)).toEqual(["u2", "a2:0"]);
    expect(got[0]?.kind === "text" ? got[0].text.length : 0).toBe(3_000_000);
    expect(cursor.offset).toBe(statSync(path).size);
  });

  it("a 10 MB line is one message too large to show, and the follow goes on past it", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const src = bounded(path);
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    await follow(src, cursor, 1);
    const start = statSync(path).size;
    appendFileSync(path, user("u3", "y".repeat(10_000_000)) + assistant("a3", "after the huge one"));
    const got = await follow(src, cursor, 45);                       // 10 MB in 256 KiB reads: 39
    expect(got.map(e => e.id)).toEqual([`too-large-${start}`, "a3:0"]);
    expect(got[0]).toMatchObject({ kind: "event", author: { kind: "system", name: "Morndo" }, text: "A message too large to show." });
    appendFileSync(path, assistant("a4", "and on"));
    expect((await follow(src, cursor, 1)).map(e => e.id)).toEqual(["a4:0"]);
  });

  it("the old reader, without the carry, stalls on the 3 MB line (negative control)", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + assistant("a1", "reply one"));
    const src = bounded(path);
    const cursor = { offset: 0 };
    expect(await oldFollow(src, cursor)).toEqual(["u1", "a1"]);
    const stuckAt = statSync(path).size;
    appendFileSync(path, user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) seen.push(...(await oldFollow(src, cursor)));
    expect(seen).toEqual([]);                                         // neither the long line nor anything after it
    expect(cursor.offset).toBe(stuckAt);
  });
});

describe("a source that fails mid-follow", () => {
  it("leaves the cursor as it was, and the next follow reads every line once", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    expect((await follow(bounded(path), cursor, 1)).map(e => e.id)).toEqual(["u1"]);
    const ids = Array.from({ length: 2000 }, (_, i) => `a${i}`);
    appendFileSync(path, ids.map(id => assistant(id, "x".repeat(150))).join(""));   // ~0.5 MB: more than one read
    const before = structuredClone(cursor);
    const local = localTranscriptBytes(path);
    let reads = 0;
    const flaky: TranscriptBytes = {
      size: () => local.size(),
      read: async (offset, max) => { if (++reads === 2) throw new Error("node offline"); return local.read(offset, max); },
      locate: needle => local.locate(needle),
    };
    await expect(followTranscript(flaky, cursor, "builder", { budget: MAX_LINE_BYTES })).rejects.toThrow("node offline");
    expect(reads).toBe(2);                                             // the first read had come back, and was parsed
    expect(cursor).toEqual(before);
    const got = (await followTranscript(bounded(path), cursor, "builder", { budget: MAX_LINE_BYTES })).entries.map(e => e.id);
    expect(got).toEqual(ids.map(id => `${id}:0`));
  });
});

describe("older pages past a long line", () => {
  it("from a message after the 10 MB line, paging moves on past it to the beginning, never asking twice", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + user("u3", "y".repeat(10_000_000)) + assistant("a3", "after the huge one"));
    const src = bounded(path);
    const asked: string[] = [];
    let before = "a3:0";
    let page = await olderPage(src, "builder", before);
    for (let i = 0; i < 5 && !page.done; i++) {
      expect(page.missing).toBeUndefined();
      expect(asked).not.toContain(page.messages[0]?.id);
      asked.push(page.messages[0]?.id ?? "");
      before = page.messages[0]?.id ?? "";
      page = await olderPage(src, "builder", before, page.resume ? { from: page.resume.end } : {});
    }
    expect(page.done).toBe(true);
    expect(page.messages.map(m => m.id)).toEqual(["u1"]);
    expect(asked.every(id => id.startsWith("too-large-"))).toBe(true);
  });
  it("from the follow's message too large to show, the page before it is the messages before the line", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const start = statSync(path).size;
    appendFileSync(path, user("u3", "y".repeat(10_000_000)) + assistant("a3", "after"));
    const page = await olderPage(bounded(path), "builder", `too-large-${start}`);
    expect(page).toMatchObject({ done: true, messages: [{ id: "u1" }] });
  });
  it("a 3 MB line fits a page's window: an older page holds it whole", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const page = await olderPage(bounded(path), "builder", "a2:0");
    expect(page.messages.map(m => m.id)).toEqual(["u1", "u2"]);
    expect(page.done).toBe(true);
  });
});
