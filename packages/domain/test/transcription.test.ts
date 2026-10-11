// Transcription (ADR-0021, design docs/design/transcription): voice messages and audio files become text on the
// user's own machine, through a plugin the default install does not include. Pure states: the capability, the
// recording caps, sniffAudio, one attempt per recording, one terminal outcome, the queue via the shared rule, and
// the text it produced. No engine name, no file, no clock of its own.
import { describe, expect, it } from "vitest";
import { sniffAudio } from "../src/index.ts";

const bytes = (head: number[], ...rest: number[]) => new Uint8Array([...head, ...rest]);

describe("sniffAudio", () => {
  it("knows each audio container by its own bytes", () => {
    expect(sniffAudio(bytes([0x4f, 0x67, 0x67, 0x53]))).toBe("ogg");            // OggS: .ogg, .oga, .opus
    expect(sniffAudio(bytes([0x1a, 0x45, 0xdf, 0xa3, 0xbf]))).toBe("webm");      // EBML: a webm recording
    expect(sniffAudio(bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]))).toBe("mp4"); // ftyp at 4
    expect(sniffAudio(bytes([0x49, 0x44, 0x33, 0x04]))).toBe("mp3");             // ID3
    expect(sniffAudio(bytes([0xff, 0xfb, 0x90, 0x00]))).toBe("mp3");             // an MPEG frame sync
    expect(sniffAudio(bytes([0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]))).toBe("wav"); // RIFF…WAVE
  });
  it("refuses bytes that are not one of the audio containers", () => {
    expect(sniffAudio(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();  // an image
    expect(sniffAudio(bytes([0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]))).toBeNull(); // RIFF, not WAVE
    expect(sniffAudio(bytes([0x66, 0x74, 0x79, 0x70]))).toBeNull();              // ftyp at 0, not at 4
    expect(sniffAudio(bytes([0x1a, 0x45]))).toBeNull();                          // cut short
    expect(sniffAudio(new Uint8Array(0))).toBeNull();
  });
});
