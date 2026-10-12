// Transcription (ADR-0021, design docs/design/transcription): voice messages and audio files become text on the
// user's own machine, through a plugin the default install does not include. Pure states: the capability, the
// recording caps, sniffAudio, one attempt per recording, one terminal outcome, the queue via the shared rule, and
// the text it produced. No engine name, no file, no clock of its own.
import { describe, expect, it } from "vitest";
import { afterRestart, effectiveMaxSeconds, endTranscription, makeText, MAX_RECORDING_BYTES, NO_CAPABILITY, requestTranscription, scheduleTranscriptions, sniffAudio, startTranscription, MAX_TEXT_BYTES, threadsFor, transcriptionTimeoutMs,
  composerText, editText, type EngineText, type Transcription, type TranscriptionBody } from "../src/index.ts";

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
    expect(sniffAudio(bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]))).toBe("mp4"); // ftyp at 4
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

  it("an iso-bmff file is audio when its major brand is one of the audio and movie brands, and only those", () => {
    const ftyp = (brand: number[]): Uint8Array => bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...brand]);
    for (const brand of [[0x4d, 0x34, 0x41, 0x20], [0x69, 0x73, 0x6f, 0x6d], [0x69, 0x73, 0x6f, 0x32], [0x69, 0x73, 0x6f, 0x35], [0x69, 0x73, 0x6f, 0x36], [0x6d, 0x70, 0x34, 0x31], [0x6d, 0x70, 0x34, 0x32]])
      expect(sniffAudio(ftyp(brand))).toBe("mp4");   // M4A␣, isom, iso2, iso5, iso6, mp41, mp42: the brands a recorder writes
    for (const brand of [[0x68, 0x65, 0x69, 0x63], [0x68, 0x65, 0x69, 0x78], [0x61, 0x76, 0x69, 0x66], [0x6d, 0x69, 0x66, 0x31], [0x6d, 0x73, 0x66, 0x31]])
      expect(sniffAudio(ftyp(brand))).toBeNull();    // heic, heix, avif, mif1, msf1: an image's brands
    expect(sniffAudio(ftyp([0x33, 0x67, 0x70, 0x34]))).toBeNull();   // 3gp4: any other brand
    expect(sniffAudio(bytes([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41]))).toBeNull();   // the brand cut short
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
    const agentKind = { kind: "agent", id: "up-1" } as unknown as TranscriptionBody["recording"];   // not one of the two kinds
    expect(requestTranscription([], ask({ recording: agentKind }), AT, READY)).toEqual({ ok: false, error: "bad_recording" });
    expect(requestTranscription([], ask({ language: "DE" }), AT, READY)).toEqual({ ok: false, error: "bad_language" });
    expect(requestTranscription([], ask({ language: "auto-detected" }), AT, READY)).toEqual({ ok: false, error: "bad_language" });
    expect(requestTranscription([], ask({ sizeBytes: -1 }), AT, READY)).toEqual({ ok: false, error: "bad_size" });
    expect(requestTranscription([], ask({ sizeBytes: 4096.5 }), AT, READY)).toEqual({ ok: false, error: "bad_size" });
  });

  it("refuses an id that is missing or not a string, instead of reading it as its own spelling", () => {
    expect(requestTranscription([], ask({ id: undefined as unknown as string }), AT, READY)).toEqual({ ok: false, error: "bad_id" });
    expect(requestTranscription([], ask({ id: 42 as unknown as string }), AT, READY)).toEqual({ ok: false, error: "bad_id" });
    expect(requestTranscription([], ask({ recording: { kind: "upload", id: 7 as unknown as string } }), AT, READY))
      .toEqual({ ok: false, error: "bad_recording" });
    // An array stringifies to "de", and RegExp.test would accept that. The language has to be a string first.
    expect(requestTranscription([], ask({ language: ["de"] as unknown as string }), AT, READY)).toEqual({ ok: false, error: "bad_language" });
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

  it("an id that names a finished attempt takes its own body again, and only its body (TX3)", () => {
    const done = { ...live(), state: "failed" as const, outcome: "failed" as const, problem: "engine" as const };
    expect(requestTranscription([done], ask(), AT + 5, READY)).toEqual({ ok: true, value: done });
    const finished = { ...live({ id: "tx-7" }), state: "done" as const, outcome: "done" as const };
    expect(requestTranscription([finished], ask({ id: "tx-7", recording: { kind: "upload", id: "up-9" } }), AT + 5, READY))
      .toEqual({ ok: false, error: "id_conflict" });
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

  it("a segment that is not an object is bad_output to the domain: bad_end, never a crash (3.4)", () => {
    const broken = (segments: unknown[]): EngineText =>
      ({ language: "de", durationMs: 1000, segments }) as unknown as EngineText;
    expect(endTranscription(run(), { outcome: "done", at: AT + 40, engine: broken([undefined]), engineName: "local", model: "small" }))
      .toEqual({ ok: false, error: "bad_end" });
    expect(endTranscription(run(), { outcome: "done", at: AT + 40, engine: broken([42]), engineName: "local", model: "small" }).ok).toBe(false);
    expect(endTranscription(run(), { outcome: "done", at: AT + 40, engine: broken(["ein Wort"]), engineName: "local", model: "small" }).ok).toBe(false);
  });

  it("repeating the done the cap turned into too_long is the same report, not a conflict (TX3)", () => {
    const tooLong = value(endTranscription(run(), { outcome: "done", at: AT + 700_000, engine: heard("zu lang", 700_000), engineName: "local", model: "small" }));
    expect(tooLong).toMatchObject({ state: "failed", outcome: "failed", problem: "too_long" });
    const retried = endTranscription(tooLong, { outcome: "done", at: AT + 800_000, engine: heard("zu lang", 700_000), engineName: "local", model: "small" });
    expect(retried).toEqual({ ok: true, value: tooLong });
    expect(endTranscription(tooLong, { outcome: "done", at: AT + 800_000, engine: heard("kurz", 100_000), engineName: "local", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });
  });

  it("a repeated failed report is the same only when its problem is the same (TX3)", () => {
    const failed = value(endTranscription(run(), { outcome: "failed", at: AT + 20, problem: "engine" }));
    expect(value(endTranscription(failed, { outcome: "failed", at: AT + 99, problem: "engine" }))).toBe(failed);
    expect(endTranscription(failed, { outcome: "failed", at: AT + 99, problem: "not_ready" }))
      .toEqual({ ok: false, error: "already_terminal" });
  });

  it("a repeated done report is the same only when every field of it is (TX3)", () => {
    const done = value(endTranscription(run(), { outcome: "done", at: AT + 40, engine: heard(), engineName: "local", model: "small" }));
    expect(value(endTranscription(done, { outcome: "done", at: AT + 99, engine: heard(), engineName: "local", model: "small" }))).toBe(done);
    expect(endTranscription(done, { outcome: "done", at: AT + 99, engine: heard("guten Morgen", 31_000), engineName: "local", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });   // another duration
    expect(endTranscription(done, { outcome: "done", at: AT + 99, engine: { ...heard(), language: "en" }, engineName: "local", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });   // another language
    expect(endTranscription(done, { outcome: "done", at: AT + 99, engine: heard(), engineName: "anderer", model: "small" }))
      .toEqual({ ok: false, error: "already_terminal" });   // another engine
    expect(endTranscription(done, { outcome: "done", at: AT + 99, engine: heard(), engineName: "local", model: "turbo" }))
      .toEqual({ ok: false, error: "already_terminal" });   // another model
  });

  it("the verdict a too_long row keeps does not follow the cap now in force (TX3)", () => {
    const tooLong = value(endTranscription(run(), { outcome: "done", at: AT + 700_000, engine: heard("zu lang", 700_000), engineName: "local", model: "small" }));
    const same = { outcome: "done" as const, at: AT + 800_000, engine: heard("zu lang", 700_000), engineName: "local", model: "small" };
    expect(value(endTranscription(tooLong, same, 900))).toBe(tooLong);   // the cap was raised: still the same report
    expect(endTranscription(tooLong, { outcome: "done", at: AT + 800_000, engine: heard("andere Worte", 700_000), engineName: "local", model: "small" }, 300))
      .toEqual({ ok: false, error: "already_terminal" });   // over a lowered cap, different words are still a different report
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

  it("a queue slot never touches a finished row, even one that shares a queued row's id (TX3)", () => {
    const finished = { ...live({ id: "tx-1" }), state: "done" as const, outcome: "done" as const, endedAt: AT + 30 };
    const waiting = live({ id: "tx-1", acceptedAt: AT + 1, recording: { kind: "upload", id: "up-2" } });
    const out = scheduleTranscriptions([finished, waiting], 1, "off");
    expect(out[0]).toMatchObject({ state: "done", outcome: "done", endedAt: AT + 30 });
    expect(out[1]).toMatchObject({ state: "starting", position: null });
  });

  it("two waiting rows that share an id each get their own slot: the key is the Recording and the Language (TX2, TX5)", () => {
    const att = live({ id: "tx-1", recording: { kind: "attachment", id: "file-1" } });
    const upl = live({ id: "tx-1", acceptedAt: AT + 1, recording: { kind: "upload", id: "file-1" } });
    const out = scheduleTranscriptions([att, upl], 1, "off");
    expect(out[0]).toMatchObject({ state: "starting", position: null, reason: null });
    expect(out[1]).toMatchObject({ state: "queued", position: 1, reason: "class" });
  });
});

describe("the caps on a recording, a run and its text (TX6)", () => {
  const run = (): Transcription => ({ ...live(), state: "running", startedAt: AT + 10 });

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
    expect(words).toEqual({ language: "de", text: "guten Morgen", edit: null, edited: false, engine: "local", model: "small" });
    const long = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "ä".repeat(40_000) }] }, "local", "small");
    expect(long.text.endsWith("[truncated]")).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    for (let i = 0; i < long.text.length; i++) expect(long.text.codePointAt(i)).toBeTruthy();
    const plain = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "a".repeat(100) }] }, "local", "small");
    expect(plain.text).toBe("a".repeat(100));
  });

  it("words that fit the cap are kept whole: no room is set aside for the mark before a cut is needed", () => {
    const fits = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "a".repeat(MAX_TEXT_BYTES) }] }, "local", "small");
    expect(fits.text).toBe("a".repeat(MAX_TEXT_BYTES));
    const oneOver = makeText({ language: "de", durationMs: 1000, segments: [{ startMs: 0, endMs: 1000, text: "a".repeat(MAX_TEXT_BYTES + 1) }] }, "local", "small");
    expect(oneOver.text.endsWith("[truncated]")).toBe(true);
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

  it("one core still gets one thread: the engine is never started with none", () => {
    expect(threadsFor(1)).toBe(1);
    expect(threadsFor(2)).toBe(1);
  });

  it("the effective cap is the lower of the setting and what the plugin offered", () => {
    expect(effectiveMaxSeconds(600, 300)).toBe(300);
    expect(effectiveMaxSeconds(300, 600)).toBe(300);
    expect(effectiveMaxSeconds(700, 600)).toBe(600);
  });
});

describe("editing the text of a done transcription (TX7)", () => {
  const done = (): Transcription => value(endTranscription(
    { ...live(), state: "running", startedAt: AT + 10 },
    { outcome: "done", at: AT + 40, engine: heard("guten Morgen"), engineName: "local", model: "small" }));

  it("keeps the engine's words and keeps the edit beside them, marked", () => {
    const edited = value(editText(done(), "  guten Abend "));
    expect(edited.text).toEqual({ language: "de", text: "guten Morgen", edit: "guten Abend", edited: true, engine: "local", model: "small" });
    const again = value(editText(edited, "guten Nacht"));
    expect(again.text).toMatchObject({ text: "guten Morgen", edit: "guten Nacht", edited: true });
  });

  it("only a done attempt has a Text to edit", () => {
    expect(editText(live(), "x")).toEqual({ ok: false, error: "not_done" });
    const failed = value(endTranscription({ ...live(), state: "running" }, { outcome: "failed", at: AT + 20, problem: "engine" }));
    expect(editText(failed, "x")).toEqual({ ok: false, error: "not_done" });
  });

  it("refuses empty words and words past the cap", () => {
    expect(editText(done(), "   ")).toEqual({ ok: false, error: "bad_text" });
    expect(editText(done(), "w".repeat(MAX_TEXT_BYTES + 1))).toEqual({ ok: false, error: "bad_text" });
    expect(editText(done(), "ä".repeat(MAX_TEXT_BYTES)).ok).toBe(false);
  });

  it("words identical to the engine's are no edit", () => {
    const row = done();
    expect(value(editText(row, "guten Morgen"))).toBe(row);
  });

  it("editing back to the engine's words takes the edit away, and with it the mark", () => {
    const edited = value(editText(done(), "guten Abend"));
    const back = value(editText(edited, "guten Morgen"));
    expect(back.text).toEqual({ language: "de", text: "guten Morgen", edit: null, edited: false, engine: "local", model: "small" });
    expect(composerText(back)).toBe("guten Morgen");
  });
});

describe("the words a done transcription offers the composer (TX8)", () => {
  const done = (over: Partial<Transcription> = {}): Transcription => value(endTranscription(
    { ...live(), state: "running", startedAt: AT + 10, ...over },
    { outcome: "done", at: AT + 40, engine: heard("guten Morgen"), engineName: "local", model: "small" }));

  it("offers the engine's words, and the principal's edit in their place", () => {
    expect(composerText(done())).toBe("guten Morgen");
    const edited = value(editText(done(), "guten Abend"));
    expect(composerText(edited)).toBe("guten Abend");
  });

  it("offers nothing until the attempt is done", () => {
    expect(composerText(live())).toBeNull();
    const failed = value(endTranscription({ ...live(), state: "running" }, { outcome: "failed", at: AT + 20, problem: "engine" }));
    expect(composerText(failed)).toBeNull();
    expect(composerText({ ...live(), state: "lost", outcome: "lost" })).toBeNull();
  });

  it("an agent's recording is the agent's content: never offered as the principal's Command", () => {
    const heardAttachment = done({ recording: { kind: "attachment", id: "file-9" } });
    expect(heardAttachment.state).toBe("done");
    expect(composerText(heardAttachment)).toBeNull();
  });
});
