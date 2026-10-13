import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wavDurationFile, wavDurationMs } from "../src/morndo-transcribe.mts";
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

  it("reads a declared length from the header without the sample bytes", () => {
    const full = pcmWav(1);
    const header = Buffer.alloc(44);
    full.copy(header, 0, 0, 44);
    header.writeUInt32LE(16_000 * 2 * 601, 40);
    const dir = mkdtempSync(join(tmpdir(), "morndo-wav-"));
    const path = join(dir, "declared.wav");
    try {
      writeFileSync(path, header);
      expect(wavDurationFile(path)).toBe(601_000);
      writeFileSync(path, full);
      expect(wavDurationFile(path)).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
