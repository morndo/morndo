import { describe, expect, it } from "vitest";
import { wavDurationMs } from "../src/morndo-transcribe.mts";
import { pcmWav } from "./audio.ts";

describe("wavDurationMs", () => {
  it("reads one second and one and a half seconds from a PCM wav", () => {
    expect(wavDurationMs(pcmWav(1))).toBe(1000);
    expect(wavDurationMs(pcmWav(1.5))).toBe(1500);
  });

  it("refuses bytes that are not a PCM wave", () => {
    expect(wavDurationMs(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull();
    expect(wavDurationMs(Uint8Array.from(Buffer.from("this is not audio\n")))).toBeNull();
  });
});
