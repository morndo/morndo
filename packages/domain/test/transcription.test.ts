// Transcription (ADR-0021, design docs/design/transcription): voice messages and audio files become text on the
// user's own machine, through a plugin the default install does not include. Pure states: the capability, the
// recording caps, sniffAudio, one attempt per recording, one terminal outcome, the queue via the shared rule, and
// the text it produced. No engine name, no file, no clock of its own.
import { describe, expect, it } from "vitest";
import { afterRestart, effectiveMaxSeconds, endTranscription, makeText, MAX_RECORDING_BYTES, MAX_RECORDING_SECONDS, NO_CAPABILITY, requestTranscription, scheduleTranscriptions, sniffAudio, startTranscription, TEXT_MAX_BYTES, threadsFor, transcriptionTimeoutMs,
  type EngineText, type Transcription, type TranscriptionBody } from "../src/index.ts";

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
const heard = (text = "guten Morgen", durationMs = 30_000): EngineText =>
  ({ language: "de", durationMs, segments: [{ startMs: 0, endMs: durationMs, text }] });
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
    const done = value(endTranscription(run(), { outcome: "done", at: AT + 40, engine: heard(), engineName: "local", model: "small" }));
    expect(done).toMatchObject({
      state: "done", outcome: "done", endedAt: AT + 40, position: null, reason: null,
      text: { language: "de", text: "guten Morgen", edited: false, engine: "local", model: "small" },
    });
    expect(endTranscription(live(), { outcome: "done", at: AT, engine: heard("x", 1_000), engineName: "e", model: "m" }))
      .toEqual({ ok: false, error: "not_running" });
  });

  it("failed names its problem, even before a start: an engine that is not ready fails a queued attempt", () => {
    const queuedFail = value(endTranscription(live(), { outcome: "failed", at: AT + 1, problem: "not_ready" }));
    expect(queuedFail).toMatchObject({ state: "failed", outcome: "failed", problem: "not_ready", text: null, endedAt: AT + 1 });
    const runFail = value(endTranscription(run(), { outcome: "failed", at: AT + 20, problem: "engine" }));
    expect(runFail).toMatchObject({ state: "failed", problem: "engine" });
  });

  it("a timeout needs a run; a cancel works at any live state, queued ones never ran", () => {
    expect(endTranscription(live(), { outcome: "timed_out", at: AT + 9 })).toEqual({ ok: false, error: "not_running" });
    const queuedCancel = value(endTranscription(live(), { outcome: "cancelled", at: AT + 2 }));
    expect(queuedCancel).toMatchObject({ state: "cancelled", outcome: "cancelled", startedAt: null, endedAt: AT + 2 });
    const runCancel = value(endTranscription(run(), { outcome: "cancelled", at: AT + 30 }));
    expect(runCancel).toMatchObject({ state: "cancelled", startedAt: AT + 10 });
  });

  it("terminal once: the same end again is the same row, a different one is refused (TX3)", () => {
    const done = value(endTranscription(run(), { outcome: "done", at: AT + 40, engine: heard(), engineName: "local", model: "small" }));
    const same = { outcome: "done", at: AT + 99, engine: heard(), engineName: "local", model: "small" } as const;
    expect(value(endTranscription(done, same))).toBe(done);
    expect(endTranscription(done, { outcome: "done", at: AT + 99, engine: heard("andere Worte"), engineName: "local", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });
    expect(endTranscription(done, { outcome: "cancelled", at: AT + 99 })).toEqual({ ok: false, error: "already_terminal" });
  });

  it("a restart with no recorded end marks the run lost and keeps the row; what never ran waits on (TX4)", () => {
    const rows = [live({ id: "tx-q" }), starting({ id: "tx-s" }), run({ id: "tx-r" }),
      value(endTranscription(run({ id: "tx-d" }), { outcome: "done", at: AT + 40, engine: heard("w"), engineName: "e", model: "m" }))];
    const after = afterRestart(rows, AT + 60);
    expect(after.find(r => r.id === "tx-q")).toMatchObject({ state: "queued" });
    expect(after.find(r => r.id === "tx-s")).toMatchObject({ state: "lost", outcome: "lost", endedAt: AT + 60, text: null });
    expect(after.find(r => r.id === "tx-r")).toMatchObject({ state: "lost", outcome: "lost", endedAt: AT + 60 });
    expect(after.find(r => r.id === "tx-d")).toMatchObject({ state: "done" });
    expect(after.find(r => r.id === "tx-r")).not.toHaveProperty("position", 1);
    expect(afterRestart(after, AT + 70).find(r => r.id === "tx-r")).toMatchObject({ state: "lost" });
  });
});

describe("scheduling transcriptions", () => {
  const askAt = (id: string, acceptedAt: number, recordingId = `up-${id}`): Transcription =>
    live({ id, acceptedAt, recording: { kind: "upload", id: recordingId } });

  it("runs at most the limit, the rest wait in the order accepted with a visible position", () => {
    const rows = [askAt("tx-c", AT + 2), askAt("tx-a", AT), askAt("tx-b", AT + 1)];
    const out = scheduleTranscriptions(rows, 1, "off");
    expect(out.find(r => r.id === "tx-a")).toMatchObject({ state: "starting", startedAt: null, position: null, reason: null });
    expect(out.find(r => r.id === "tx-b")).toMatchObject({ state: "queued", position: 1, reason: "class" });
    expect(out.find(r => r.id === "tx-c")).toMatchObject({ state: "queued", position: 2, reason: "class" });
  });

  it("what already runs or starts counts against the limit and is not stopped", () => {
    const rows = [askAt("tx-run", AT), askAt("tx-start", AT + 1), askAt("tx-wait", AT + 2)];
    rows[0]!.state = "running";
    rows[1]!.state = "starting";
    const out = scheduleTranscriptions(rows, 2, "off");
    expect(out.find(r => r.id === "tx-run")).toMatchObject({ state: "running" });
    expect(out.find(r => r.id === "tx-start")).toMatchObject({ state: "starting" });
    expect(out.find(r => r.id === "tx-wait")).toMatchObject({ state: "queued", position: 1, reason: "class" });
  });

  it("a guard over the line delays every start with its own reason, and stops nothing (TX5)", () => {
    const rows = [askAt("tx-run", AT), askAt("tx-next", AT + 1)];
    rows[0]!.state = "running";
    const out = scheduleTranscriptions(rows, 2, "load");
    expect(out.find(r => r.id === "tx-run")).toMatchObject({ state: "running" });
    expect(out.find(r => r.id === "tx-next")).toMatchObject({ state: "queued", position: 1, reason: "load" });
    expect(scheduleTranscriptions([askAt("tx-m", AT)], 1, "unknown").find(r => r.id === "tx-m"))
      .toMatchObject({ state: "queued", position: 1, reason: "guard_unknown" });
  });

  it("a finished attempt is not scheduled again", () => {
    const rows = [askAt("tx-done", AT), askAt("tx-lost", AT + 1)];
    rows[0]!.state = "done";
    rows[1]!.state = "lost";
    const out = scheduleTranscriptions(rows, 1, "off");
    expect(out.find(r => r.id === "tx-done")).toMatchObject({ state: "done", position: null });
    expect(out.find(r => r.id === "tx-lost")).toMatchObject({ state: "lost", position: null });
  });
});

describe("the caps on a recording, a run and its text (TX6)", () => {
  it("a recording over 10 MiB is refused at the request; one exactly at the line is taken", () => {
    expect(requestTranscription([], ask({ sizeBytes: MAX_RECORDING_BYTES + 1 }), AT, READY)).toEqual({ ok: false, error: "bad_size" });
    expect(requestTranscription([], ask({ sizeBytes: MAX_RECORDING_BYTES }), AT, READY).ok).toBe(true);
  });

  it("words that took longer than the cap are failed: too_long, not done", () => {
    const over = value(endTranscription(run(), { outcome: "done", at: AT + 610_000, engine: heard("zu lang", 601_000), engineName: "local", model: "small" }));
    expect(over).toMatchObject({ state: "failed", outcome: "failed", problem: "too_long", text: null });
    const atTheLine = value(endTranscription(run(), { outcome: "done", at: AT + 600_000, engine: heard("punktlich", 600_000), engineName: "local", model: "small" }));
    expect(atTheLine).toMatchObject({ state: "done" });
    const probeLowered = value(endTranscription(run(), { outcome: "done", at: AT + 400_000, engine: heard("knapp", 300_500), engineName: "local", model: "small" }, 300));
    expect(probeLowered).toMatchObject({ state: "failed", problem: "too_long" });
  });

  it("the domain joins what the engine heard and caps it at 64 KiB of UTF-8", () => {
    const words = makeText({ language: "de", durationMs: 1000, segments: [
      { startMs: 0, endMs: 400, text: "  guten " }, { startMs: 400, endMs: 900, text: "Morgen  " }, { startMs: 900, endMs: 1000, text: "" },
    ] }, "local", "small");
    expect(words).toEqual({ language: "de", text: "guten Morgen", edited: false, engine: "local", model: "small" });
    const long = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "ä".repeat(40_000) }] }, "local", "small");
    expect(long.text.endsWith("[truncated]")).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(TEXT_MAX_BYTES);
    for (let i = 0; i < long.text.length; i++) expect(long.text.codePointAt(i)).toBeTruthy();
    const plain = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "a".repeat(100) }] }, "local", "small");
    expect(plain.text).toBe("a".repeat(100));
  });

  it("a run's timeout is 120 s plus six times the duration, unless the config names one", () => {
    expect(transcriptionTimeoutMs(10_000, null)).toBe(120_000 + 60_000);
    expect(transcriptionTimeoutMs(10_000, 30)).toBe(30_000);
  });

  it("threads are half the cores, at most eight", () => {
    expect(threadsFor(32)).toBe(8);
    expect(threadsFor(9)).toBe(4);
    expect(threadsFor(4)).toBe(2);
  });

  it("the effective cap is the lower of the setting and what the plugin offered", () => {
    expect(effectiveMaxSeconds(600, 300)).toBe(300);
    expect(effectiveMaxSeconds(300, 600)).toBe(300);
    expect(effectiveMaxSeconds(700, 600)).toBe(600);
  });
});
