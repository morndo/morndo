import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
    const dir = mkdtempSync(join(tmpdir(), "morndo-wav-"));
    const path = join(dir, "declared.wav");
    const dataBytes = 16_000 * 2 * 601;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(16_000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(dataBytes, 40);
    const fd = openSync(path, "w");
    try {
      writeSync(fd, header);
      ftruncateSync(fd, 44 + dataBytes);
    } finally {
      closeSync(fd);
    }
    try {
      expect(wavDurationFile(path)).toBe(601_000);
      writeFileSync(path, pcmWav(1));
      expect(wavDurationFile(path)).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not trust a data size past the end of the file or the unseekable placeholder", () => {
    const full = pcmWav(1);
    full.writeUInt32LE(0xffffffff, 40);
    const dir = mkdtempSync(join(tmpdir(), "morndo-wav-"));
    const lying = join(dir, "placeholder.wav");
    const headerOnly = join(dir, "header.wav");
    const declared = Buffer.alloc(44);
    full.copy(declared, 0, 0, 44);
    try {
      writeFileSync(lying, full);
      expect(wavDurationFile(lying)).toBe(1000);
      const oversized = Buffer.from(pcmWav(1));
      oversized.writeUInt32LE(16_000 * 2 * 601, 40);
      writeFileSync(lying, oversized);
      expect(wavDurationFile(lying)).toBe(1000);
      writeFileSync(headerOnly, declared);
      expect(wavDurationFile(headerOnly)).toBe("engine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
