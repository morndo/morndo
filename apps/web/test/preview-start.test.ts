// A text file's preview reads only its start: an HTML page the owner attached may be 10 MB, and six can sit in one
// message, so the rest of the body is let go, not downloaded to be thrown away.
import { describe, expect, it } from "vitest";
import { readStart } from "../src/lib/desktop/preview.ts";

// A body served in chunks, counting how many were pulled and whether the reader let it go.
function body(chunks: string[]) {
  const seen = { pulled: 0, cancelled: false };
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { const next = chunks[seen.pulled++]; if (next === undefined) c.close(); else c.enqueue(enc.encode(next)); },
    cancel() { seen.cancelled = true; },
  });
  return { stream, seen };
}

describe("readStart", () => {
  it("reads a short file whole and says nothing was cut", async () => {
    const { stream, seen } = body(["<p>a</p>", "<p>b</p>"]);
    expect(await readStart(stream, 100)).toEqual({ text: "<p>a</p><p>b</p>", cut: false });
    expect(seen.cancelled).toBe(false);
  });
  it("stops at the limit, lets the rest go, and says it was cut", async () => {
    const { stream, seen } = body(Array.from({ length: 1000 }, () => "x".repeat(100)));
    const start = await readStart(stream, 250);
    expect(start).toEqual({ text: "x".repeat(250), cut: true });
    expect(seen.pulled).toBeLessThan(10);
    expect(seen.cancelled).toBe(true);
  });
  it("a file exactly at the limit is whole, not cut", async () => {
    const { stream } = body(["x".repeat(100), "y".repeat(100)]);
    expect(await readStart(stream, 200)).toEqual({ text: "x".repeat(100) + "y".repeat(100), cut: false });
  });
  it("never shows half a character where the cut falls", async () => {
    const { stream } = body(["ab", "ü".repeat(10)]);                     // ü is two bytes: the limit of 5 falls inside one
    const start = await readStart(stream, 5);
    expect(start.cut).toBe(true);
    expect(start.text).toBe("abü");
  });
});
