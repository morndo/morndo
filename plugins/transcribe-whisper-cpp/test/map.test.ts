// mapWhisper turns whisper.cpp's -oj document into protocol 1. Offsets are already milliseconds.
import { describe, expect, it } from "vitest";
import { parseRun } from "@morndo/protocol";
import { mapWhisper } from "../src/morndo-transcribe.mts";

const heard = {
  result: { language: "de" },
  transcription: [
    { offsets: { from: 0, to: 5200 }, text: " Notiz an den Hafen." },
    { offsets: { from: 5200, to: 8000 }, text: "   " },
    { offsets: { from: 8000, to: 9000 }, text: "Der Steg ist frei." },
  ],
};

const ONE_SECOND = {
  protocol: 1 as const,
  language: "de",
  durationMs: 9100,
  segments: [
    { startMs: 0, endMs: 5200, text: "Notiz an den Hafen." },
    { startMs: 8000, endMs: 9000, text: "Der Steg ist frei." },
  ],
};

describe("mapWhisper", () => {
  it("trims each segment, drops an empty one, and keeps the wav duration when it is longer", () => {
    expect(mapWhisper(heard, 9100)).toEqual(ONE_SECOND);
    expect(parseRun(JSON.stringify(ONE_SECOND))).toEqual({ ok: true, value: ONE_SECOND });
  });

  it("extends the duration to a segment that ends past the wav, and refuses a broken document", () => {
    expect(mapWhisper(heard, 1000)).toEqual({ ...ONE_SECOND, durationMs: 9000 });
    expect(mapWhisper({ result: { language: "DE" }, transcription: [] }, 1000)).toBeNull();
    expect(mapWhisper({ result: { language: "de" }, transcription: [{ offsets: { from: 5, to: 4 }, text: "x" }] }, 1000)).toBeNull();
    expect(mapWhisper({ result: { language: "de" } }, 1000)).toBeNull();
  });
});
