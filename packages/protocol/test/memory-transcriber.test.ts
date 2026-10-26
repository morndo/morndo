// MemoryTranscriber: scripted answers and a manual clock (design §4). The contract suite is the port's proof.
// The clock test is this fake's own: a delayed answer arrives when time is moved, and an abort still wins.
import { describe, expect, it } from "vitest";
import { SENTENCE } from "./answers.mjs";
import { ManualClock, MemoryTranscriber } from "./memory-transcriber.ts";
import { transcriberContract } from "./transcriber-contract.ts";

transcriberContract(() => {
  const transcriber = new MemoryTranscriber();
  return { transcriber, started: () => transcriber.hasStarted() };
});

describe("MemoryTranscriber clock", () => {
  it("a delayed answer arrives when the clock reaches it, and an abort wins over a later tick", async () => {
    const clock = new ManualClock();
    const tx = new MemoryTranscriber(clock);
    const pending = tx.transcribe({
      path: "/audio/delay.wav", language: "auto", threads: 1, maxSeconds: 600, signal: new AbortController().signal,
    });
    let settled = false;
    const done = pending.then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1000);
    expect(await done).toEqual({
      ok: true,
      value: { language: "de", durationMs: 5200, segments: [{ startMs: 0, endMs: 5200, text: SENTENCE }] },
    });

    const ac = new AbortController();
    const aborted = tx.transcribe({
      path: "/audio/delay.wav", language: "en", threads: 1, maxSeconds: 600, signal: ac.signal,
    });
    ac.abort();
    clock.advance(1000);
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });
});
