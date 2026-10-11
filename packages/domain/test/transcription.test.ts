// Transcription (ADR-0021, design docs/design/transcription): voice messages and audio files become text on the
// user's own machine, through a plugin the default install does not include. Pure states: the capability, the
// recording caps, sniffAudio, one attempt per recording, one terminal outcome, the queue via the shared rule, and
// the text it produced. No engine name, no file, no clock of its own.
import { describe, expect, it } from "vitest";
import { afterRestart, endTranscription, NO_CAPABILITY, requestTranscription, sniffAudio, startTranscription, type Transcription, type TranscriptionBody } from "../src/index.ts";

const bytes = (head: number[], ...rest: number[]) => new Uint8Array([...head, ...rest]);
const AT = 1_700_000_000_000;
const READY = { present: true, maxSeconds: 600 } as const;
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
};
const ask = (over: Partial<TranscriptionBody> = {}): TranscriptionBody => ({
  id: "tx-1", recording: { kind: "upload", id: "up-1" }, sizeBytes: 4096, language: "auto", ...over,
});
const live = (over: Partial<Transcription> = {}): Transcription => ({ ...value(requestTranscription([], ask(), AT, READY)), ...over });

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

describe("requesting a transcription", () => {
  it("runs nothing and offers nothing while no ready Transcriber is there, whatever the body (TX9)", () => {
    expect(requestTranscription([], ask(), AT, NO_CAPABILITY)).toEqual({ ok: false, error: "no_capability" });
    expect(requestTranscription([], ask({ id: "" }), AT, { present: false, reason: "not_ready" })).toEqual({ ok: false, error: "no_capability" });
    expect(requestTranscription([], ask(), AT, { present: true, maxSeconds: Number.NaN })).toEqual({ ok: false, error: "no_capability" });
  });
  it("refuses a bad id, recording, language or size before it queues anything", () => {
    expect(requestTranscription([], ask({ id: "../up" }), AT, READY)).toEqual({ ok: false, error: "bad_id" });
    expect(requestTranscription([], ask({ recording: { kind: "upload", id: "" } }), AT, READY)).toEqual({ ok: false, error: "bad_recording" });
    expect(requestTranscription([], ask({ recording: { kind: "agent", id: "up-1" } }), AT, READY)).toEqual({ ok: false, error: "bad_recording" });
    expect(requestTranscription([], ask({ language: "DE" }), AT, READY)).toEqual({ ok: false, error: "bad_language" });
    expect(requestTranscription([], ask({ language: "auto-detected" }), AT, READY)).toEqual({ ok: false, error: "bad_language" });
    expect(requestTranscription([], ask({ sizeBytes: -1 }), AT, READY)).toEqual({ ok: false, error: "bad_size" });
    expect(requestTranscription([], ask({ sizeBytes: 4096.5 }), AT, READY)).toEqual({ ok: false, error: "bad_size" });
  });
  it("queues one attempt, waiting for a slot, with no outcome and no text", () => {
    expect(live()).toMatchObject({
      id: "tx-1", recording: { kind: "upload", id: "up-1" }, language: "auto", sizeBytes: 4096,
      acceptedAt: AT, state: "queued", position: null, reason: null, outcome: null, problem: null,
      text: null, startedAt: null, endedAt: null,
    });
  });
  it("returns the attempt already in flight for the same recording and language (TX2)", () => {
    const first = live();
    expect(value(requestTranscription([first], ask({ id: "tx-2" }), AT + 5, READY))).toBe(first);
    const german = live({ id: "tx-3", language: "de" });
    const again = value(requestTranscription([german], ask({ id: "tx-4", language: "de", recording: { kind: "upload", id: "up-2" } }), AT + 5, READY));
    expect(again).not.toBe(german);   // another recording is another attempt, not a conflict
    expect(again.acceptedAt).toBe(AT + 5);
    const otherLanguage = value(requestTranscription([first], ask({ id: "tx-5", language: "de" }), AT + 6, READY));
    expect(otherLanguage.id).toBe("tx-5");
  });
  it("an agent's attachment and the principal's upload of the same id are two recordings", () => {
    const first = live({ recording: { kind: "attachment", id: "file-1" } });
    const second = requestTranscription([first], ask({ recording: { kind: "upload", id: "file-1" } }), AT + 5, READY);
    expect(second.ok && second.value.id).toBe("tx-1");   // a new attempt: not the one in flight
    expect(second.ok && second.value.recording.kind).toBe("upload");
  });
  it("a finished attempt does not hold the recording: asking again makes a new one (TX3)", () => {
    const done = { ...live(), state: "failed" as const, outcome: "failed" as const, problem: "engine" as const };
    const again = value(requestTranscription([done], ask({ id: "tx-9" }), AT + 9, READY));
    expect(again).toMatchObject({ id: "tx-9", state: "queued", acceptedAt: AT + 9 });
    expect(done.state).toBe("failed");
  });
});

describe("starting and ending a transcription", () => {
  const starting = (over: Partial<Transcription> = {}): Transcription => ({ ...live(), state: "starting", ...over });
  const run = (over: Partial<Transcription> = {}): Transcription => ({ ...live(), state: "running", startedAt: AT + 10, ...over });

  it("a start moves starting to running and stamps when work began; a repeat changes nothing", () => {
    const begun = value(startTranscription(starting(), AT + 10));
    expect(begun).toMatchObject({ state: "running", startedAt: AT + 10 });
    expect(value(startTranscription(begun, AT + 20))).toBe(begun);
    expect(startTranscription(live(), AT)).toEqual({ ok: false, error: "not_starting" });
  });

  it("done keeps the engine's words and when it ended, and only a running attempt can finish", () => {
    const done = value(endTranscription(run(), { outcome: "done", at: AT + 40, durationSec: 30, language: "de", text: "guten Morgen", engine: "local", model: "small" }));
    expect(done).toMatchObject({
      state: "done", outcome: "done", endedAt: AT + 40, position: null, reason: null,
      text: { language: "de", text: "guten Morgen", edited: false, engine: "local", model: "small" },
    });
    expect(endTranscription(live(), { outcome: "done", at: AT, durationSec: 1, language: "de", text: "x", engine: "e", model: "m" }))
      .toEqual({ ok: false, error: "not_running" });
  });

  it("failed names its problem, even before a start: an engine that is not ready fails a queued attempt", () => {
    const queuedFail = value(endTranscription(live(), { outcome: "failed", at: AT + 1, durationSec: 0, problem: "not_ready" }));
    expect(queuedFail).toMatchObject({ state: "failed", outcome: "failed", problem: "not_ready", text: null, endedAt: AT + 1 });
    const runFail = value(endTranscription(run(), { outcome: "failed", at: AT + 20, durationSec: 5, problem: "engine" }));
    expect(runFail).toMatchObject({ state: "failed", problem: "engine" });
  });

  it("a timeout needs a run; a cancel works at any live state, queued ones never ran", () => {
    expect(endTranscription(live(), { outcome: "timed_out", at: AT + 9, durationSec: 1 })).toEqual({ ok: false, error: "not_running" });
    const queuedCancel = value(endTranscription(live(), { outcome: "cancelled", at: AT + 2 }));
    expect(queuedCancel).toMatchObject({ state: "cancelled", outcome: "cancelled", startedAt: null, endedAt: AT + 2 });
    const runCancel = value(endTranscription(run(), { outcome: "cancelled", at: AT + 30 }));
    expect(runCancel).toMatchObject({ state: "cancelled", startedAt: AT + 10 });
  });

  it("terminal once: the same end again is the same row, a different one is refused (TX3)", () => {
    const done = value(endTranscription(run(), { outcome: "done", at: AT + 40, durationSec: 30, language: "de", text: "guten Morgen", engine: "local", model: "small" }));
    const same = { outcome: "done", at: AT + 99, durationSec: 30, language: "de", text: "guten Morgen", engine: "local", model: "small" } as const;
    expect(value(endTranscription(done, same))).toBe(done);
    expect(endTranscription(done, { outcome: "done", at: AT + 99, durationSec: 30, language: "de", text: "andere Worte", engine: "local", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });
    expect(endTranscription(done, { outcome: "cancelled", at: AT + 99 })).toEqual({ ok: false, error: "already_terminal" });
  });

  it("a restart with no recorded end marks the run lost and keeps the row; what never ran waits on (TX4)", () => {
    const rows = [live({ id: "tx-q" }), starting({ id: "tx-s" }), run({ id: "tx-r" }),
      value(endTranscription(run({ id: "tx-d" }), { outcome: "done", at: AT + 40, durationSec: 30, language: "de", text: "w", engine: "e", model: "m" }))];
    const after = afterRestart(rows, AT + 60);
    expect(after.find(r => r.id === "tx-q")).toMatchObject({ state: "queued" });
    expect(after.find(r => r.id === "tx-s")).toMatchObject({ state: "lost", outcome: "lost", endedAt: AT + 60, text: null });
    expect(after.find(r => r.id === "tx-r")).toMatchObject({ state: "lost", outcome: "lost", endedAt: AT + 60 });
    expect(after.find(r => r.id === "tx-d")).toMatchObject({ state: "done" });
    expect(after.find(r => r.id === "tx-r")).not.toHaveProperty("position", 1);
    expect(afterRestart(after, AT + 70).find(r => r.id === "tx-r")).toMatchObject({ state: "lost" });
  });
});
