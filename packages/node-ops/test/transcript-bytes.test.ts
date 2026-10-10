// A transcript's bytes on this machine (docs/design/fleet-core/README.md §3.1): its size, bounded reads, and where the
// last line holding a needle starts. Synthetic files in a temporary directory only.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { localTranscriptBytes } from "../src/transcript-bytes.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-bytes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = (content: string | Buffer) => { const p = join(dir, "t.jsonl"); writeFileSync(p, content); return p; };
const line = (uuid: string, pad = 0) => `${JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text: "x".repeat(pad) }] } })}\n`;
// Where the last line holding `needle` starts, the slow and obvious way.
const reference = (content: Buffer, needle: string) => {
  const hit = content.lastIndexOf(Buffer.from(needle));
  return hit === -1 ? null : hit === 0 ? 0 : content.lastIndexOf(0x0a, hit - 1) + 1;
};

describe("size", () => {
  it("is the file's size; null when there is no file to read", async () => {
    expect(await localTranscriptBytes(file("abc\n")).size()).toBe(4);
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).size()).toBeNull();
    expect(await localTranscriptBytes(dir).size()).toBeNull();                           // a directory
  });
});

describe("read", () => {
  it("reads at an offset, at most max bytes, and says when nothing lies past them", async () => {
    const b = localTranscriptBytes(file("0123456789"));
    const read = async (offset: number, max: number) => { const r = await b.read(offset, max); return r && { text: Buffer.from(r.bytes).toString(), eof: r.eof }; };
    expect(await read(2, 3)).toEqual({ text: "234", eof: false });
    expect(await read(7, 100)).toEqual({ text: "789", eof: true });
    expect(await read(10, 5)).toEqual({ text: "", eof: true });
    expect(await read(50, 5)).toEqual({ text: "", eof: true });
  });
  it("never returns more than one chunk, however much is asked for", async () => {
    const b = localTranscriptBytes(file(Buffer.alloc(LIMITS.chunkBytes * 2 + 5, 0x61)));
    const r = await b.read(0, 10 << 20);
    expect(r?.bytes.length).toBe(LIMITS.chunkBytes);
    expect(r?.eof).toBe(false);
  });
  it("is null without a file; a negative offset or size is refused", async () => {
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).read(0, 10)).toBeNull();
    await expect(localTranscriptBytes(file("x")).read(-1, 10)).rejects.toThrow(RangeError);
    await expect(localTranscriptBytes(file("x")).read(0, 1.5)).rejects.toThrow(RangeError);
  });
});

describe("locate", () => {
  it("finds the start of the line holding the needle", async () => {
    const content = line("a1") + line("a2") + line("a3");
    const b = localTranscriptBytes(file(content));
    expect(await b.locate('"uuid":"a2"')).toBe(Buffer.byteLength(line("a1")));
    expect(await b.locate('"uuid":"a1"')).toBe(0);
    expect(await b.locate('"uuid":"a9"')).toBeNull();
    expect(await b.locate("")).toBeNull();
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).locate("x")).toBeNull();
  });
  it("the last line that holds it", async () => {
    const content = line("a1") + line("a2") + line("a1");
    expect(await localTranscriptBytes(file(content)).locate('"uuid":"a1"')).toBe(Buffer.byteLength(line("a1") + line("a2")));
  });
  it("a needle across the edge of the 1 MiB windows it reads backwards, and a line that starts windows earlier", async () => {
    const needle = '"uuid":"ü-edge"';
    const n = Buffer.byteLength(needle);
    for (let k = -2; k <= n + 2; k++) {
      // the needle ends k bytes after the edge one window back from the end
      const tail = (1 << 20) - k;
      const content = Buffer.concat([Buffer.from(line("a0")), Buffer.from("x".repeat(1_500_000)), Buffer.from(needle), Buffer.from(`${"y".repeat(Math.max(0, tail - 1))}\n`)]);
      const p = file(content);
      expect(await localTranscriptBytes(p).locate(needle), `k=${k}`).toBe(reference(content, needle));
    }
  });
  it("agrees with the obvious search on a file of many windows", async () => {
    const p = file("");
    for (let i = 0; i < 400; i++) appendFileSync(p, line(`a${i}`, (i * 7919) % 20_000));
    const content = readFileSync(p);
    const b = localTranscriptBytes(p);
    for (const i of [0, 1, 57, 199, 200, 333, 398, 399]) expect(await b.locate(`"uuid":"a${i}"`), `a${i}`).toBe(reference(content, `"uuid":"a${i}"`));
  });
});
