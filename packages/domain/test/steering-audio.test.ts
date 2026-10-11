// The S1 audio gate (ADR-0021, TX9): an audio Upload — a voice note or an audio file — is allowed only while a
// ready Transcriber is there, and its bytes must be the container its name claims. Pure: the Capability comes in
// as an argument. The rest of the upload rules live in steering.test.ts and stay as they were.
import { describe, expect, it } from "vitest";
import { acceptNamedUpload, screenNamedUpload } from "../src/steering.ts";
import { NO_CAPABILITY, type TranscriptionCapability } from "../src/transcription.ts";

const READY: TranscriptionCapability = { present: true, maxSeconds: 600 };
const bytes = (head: number[], ...rest: number[]) => new Uint8Array([...head, ...rest]);
const OGGS = bytes([0x4f, 0x67, 0x67, 0x53]);
const EBML = bytes([0x1a, 0x45, 0xdf, 0xa3, 0xbf]);
const MP4 = bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]);
const ID3 = bytes([0x49, 0x44, 0x33, 0x04]);
const WAVE = bytes([0x52, 0x49, 0x46, 0x46, 0x24, 0x08, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);

describe("an audio upload", () => {
  it("is refused while no ready Transcriber is there, whatever its name or size (TX9)", () => {
    for (const name of ["note.ogg", "note.opus", "note.webm", "note.m4a", "note.mp3", "note.wav"]) {
      expect(screenNamedUpload(name, 4096, NO_CAPABILITY)).toEqual({ ok: false, error: "not_allowed" });
      expect(screenNamedUpload(name, 4096, { present: false, reason: "not_ready" })).toEqual({ ok: false, error: "not_allowed" });
    }
    expect(acceptNamedUpload(OGGS, "note.ogg", NO_CAPABILITY)).toEqual({ ok: false, error: "not_allowed" });
  });

  it("screens and accepts each container while the Capability is there", () => {
    expect(screenNamedUpload("note.ogg", 4096, READY)).toEqual({ ok: true, value: { kind: "audio", name: "note.ogg" } });
    const cases: [string, Uint8Array, string][] = [
      ["note.ogg", OGGS, "ogg"], ["note.oga", OGGS, "ogg"], ["note.opus", OGGS, "ogg"],
      ["note.webm", EBML, "webm"], ["note.m4a", MP4, "mp4"], ["note.mp3", ID3, "mp3"], ["note.wav", WAVE, "wav"],
    ];
    for (const [name, body, container] of cases) {
      expect(acceptNamedUpload(body, name, READY)).toEqual({ ok: true, value: { kind: "audio", container, name } });
    }
  });

  it("wants the bytes of the container the name claims", () => {
    expect(acceptNamedUpload(EBML, "note.ogg", READY)).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(ID3, "note.wav", READY)).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(bytes([0x89, 0x50, 0x4e, 0x47]), "note.mp3", READY)).toEqual({ ok: false, error: "not_allowed" });
  });

  it("an iso-bmff photo or movie under an audio name is not audio: the brand must be M4A", () => {
    const HEIC = bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const ISOM = bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(acceptNamedUpload(HEIC, "note.m4a", READY)).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(ISOM, "note.webm", READY)).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(MP4, "note.m4a", READY).ok).toBe(true);
  });

  it("is at most 10 MiB, refused on name and size before anyone reads the bytes", () => {
    expect(screenNamedUpload("note.m4a", 10 * 1024 * 1024 + 1, READY)).toEqual({ ok: false, error: "too_big" });
    expect(screenNamedUpload("note.m4a", 10 * 1024 * 1024, READY).ok).toBe(true);
  });

  it("keeps the old rules for the old kinds: they never needed a Capability", () => {
    expect(screenNamedUpload("photo.png", 2048)).toEqual({ ok: true, value: { kind: "image", name: "photo.png" } });
    expect(screenNamedUpload("note.ogg", 4096)).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(bytes([0xff, 0xd8, 0xff, 0xe0]), "photo.jpg", NO_CAPABILITY).ok).toBe(true);
  });

  it("keeps the audio name rule the others have: a space becomes an underscore", () => {
    expect(acceptNamedUpload(OGGS, "voice note.ogg", READY))
      .toEqual({ ok: true, value: { kind: "audio", container: "ogg", name: "voice_note.ogg" } });
  });
});
