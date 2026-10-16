// The deliverer's transcript view says where each whole line starts, so a receipt can be required to come after the typing.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentTranscripts } from "../src/deliveries/views.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

describe("agentTranscripts.lines", () => {
  it("returns the byte offset each line starts at, multi-byte text and a half-written last line included", async () => {
    const home = tempHome();
    homes.push(home);
    const path = join(home.home, "t.jsonl");
    writeFileSync(path, '{"a":"é"}\n\n{"b":2}\n{"c"');
    const view = agentTranscripts(() => path);
    const got = await view.lines("s", 0);
    expect(got?.lines).toEqual(['{"a":"é"}', '{"b":2}']);
    expect(got?.starts).toEqual([0, 12]);                       // "é" is two bytes; the empty line between them is skipped
    expect(got?.next).toBe(20);
    appendFileSync(path, ':3}\n');
    const more = await view.lines("s", got!.next);
    expect(more?.lines).toEqual(['{"c":3}']);
    expect(more?.starts).toEqual([20]);
  });
});

describe("agentTranscripts.lines offsets from raw bytes", () => {
  it("counts the bytes of a row that is not valid UTF-8 as they are, not as the replacement characters they decode to", async () => {
    const home = tempHome();
    homes.push(home);
    const path = join(home.home, "t.jsonl");
    const bad = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from('"}')]);
    const rows = [Buffer.from('{"a":1}'), bad, Buffer.from('{"c":3}')];
    writeFileSync(path, Buffer.concat(rows.flatMap(r => [r, Buffer.from("\n")])));
    const got = await agentTranscripts(() => path).lines("s", 0);
    expect(got?.lines.length).toBe(3);
    expect(got?.starts).toEqual([0, rows[0]!.length + 1, rows[0]!.length + rows[1]!.length + 2]);
  });

  it("keeps true offsets after a line longer than one read is skipped, though the next read starts inside a multi-byte character", async () => {
    const home = tempHome();
    homes.push(home);
    const path = join(home.home, "t.jsonl");
    const first = Buffer.from('{"a":1}\n');
    const huge = Buffer.from(`"x${"é".repeat(800_000)}"`);                       // 1.6 MB, its two-byte characters start at odd offsets
    const tail = [Buffer.from('{"b":2}'), Buffer.from([0x7b, 0xff, 0x7d]), Buffer.from('{"d":4}')];
    writeFileSync(path, Buffer.concat([first, huge, Buffer.from("\n"), ...tail.flatMap(r => [r, Buffer.from("\n")])]));
    const view = agentTranscripts(() => path);
    let from = 0;
    const seen: { line: string; start: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const got = await view.lines("s", from);
      if (!got) break;
      got.lines.forEach((line, k) => seen.push({ line, start: got.starts![k]! }));
      if (got.next === from) break;
      from = got.next;
    }
    const whole = readFileSync(path);
    const tailStart = first.length + huge.length + 1;
    const expected = [0, tailStart, tailStart + tail[0]!.length + 1, tailStart + tail[0]!.length + tail[1]!.length + 2];
    const tails = seen.filter(s => s.start >= tailStart);
    expect(tails.map(s => s.start)).toEqual(expected.slice(1));
    for (const s of tails) expect(whole[s.start]).toBe(0x7b);                    // every offset starts a row: `{`
    expect(seen[0]).toEqual({ line: '{"a":1}', start: 0 });
  });
});
