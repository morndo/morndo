// Plugin protocol 1 and the transcription HTTP bodies (ADR-0021; design §5, §6). A document that is not protocol 1
// is bad_output. A path is not a field: the wire never carries where the audio sits.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MeTranscription, ProbeDocument, RunDocument, TranscriptionCancelBody, TranscriptionCreateBody, TranscriptionView,
  parseBody, parseProbe, parseRun, problemFromExit,
} from "../src/index.ts";

const PROBE = {
  protocol: 1, ready: true, engine: "fixture-ear", engineVersion: "1.0.0", model: "tiny-fixture",
  languages: "multi", maxSeconds: 600, missing: [],
} as const;
const RUN = {
  protocol: 1, language: "de", durationMs: 5200,
  segments: [{ startMs: 0, endMs: 5200, text: "Notiz an den Hafen: der Steg ist frei." }],
};
const CREATE = { id: "tx-1", recording: { kind: "upload" as const, id: "abc123def456" }, language: "auto" };
const VIEW = {
  id: "tx-1", recording: { kind: "upload" as const, id: "abc123def456" }, language: "auto",
  state: "done" as const, position: null, reason: null, outcome: "done" as const, problem: null,
  text: {
    language: "de", text: "Notiz an den Hafen: der Steg ist frei.", edit: null, edited: false,
    engine: "fixture-ear", model: "tiny-fixture",
  },
};

describe("plugin protocol 1", () => {
  it("reads a ready probe and a run that names its segments", () => {
    expect(parseProbe(JSON.stringify(PROBE))).toEqual({ ok: true, value: PROBE });
    expect(parseRun(`${JSON.stringify(RUN)}\n`)).toEqual({ ok: true, value: RUN });
    expect(parseProbe(JSON.stringify({ protocol: 1, ready: false, missing: ["model", "ffmpeg"] }))).toEqual({
      ok: true, value: { protocol: 1, ready: false, missing: ["model", "ffmpeg"] },
    });
  });

  it("a wrong protocol, an extra field, or broken JSON is bad_output, and the audio path is not kept", () => {
    expect(parseProbe(JSON.stringify({ ...PROBE, protocol: 2 }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseProbe("{")).toEqual({ ok: false, error: "bad_output" });
    expect(parseProbe("")).toEqual({ ok: false, error: "bad_output" });
    const withPath = parseProbe(JSON.stringify({ ...PROBE, path: "/tmp/note.wav" }));
    expect(withPath).toEqual({ ok: false, error: "bad_output" });
    expect(JSON.stringify(withPath)).not.toContain("/tmp/note.wav");
    expect(parseRun(JSON.stringify({ ...RUN, protocol: 2 }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseRun(JSON.stringify({ ...RUN, language: "auto" }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseRun(JSON.stringify({ ...RUN, language: "DE" }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseRun(JSON.stringify({ ...RUN, durationMs: 5200.5 }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseProbe(JSON.stringify({ protocol: 1, ready: false, missing: [] }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseProbe(JSON.stringify({ ...PROBE, missing: ["ffmpeg"] }))).toEqual({ ok: false, error: "bad_output" });
    expect(parseProbe(JSON.stringify({ ...PROBE, ready: false }))).toEqual({ ok: false, error: "bad_output" });
  });

  it("maps a non-zero exit onto a problem, and zero means the JSON is the answer", () => {
    expect(problemFromExit(0)).toBeNull();
    expect(problemFromExit(2)).toBe("engine");
    expect(problemFromExit(3)).toBe("unreadable");
    expect(problemFromExit(4)).toBe("too_long");
    expect(problemFromExit(5)).toBe("not_ready");
    expect(problemFromExit(1)).toBe("engine");
    expect(problemFromExit(9)).toBe("engine");
    expect(ProbeDocument.safeParse(PROBE).success).toBe(true);
    expect(RunDocument.safeParse({ ...RUN, language: "pt-BR" }).success).toBe(true);
  });

  it("takes ids, languages and problems from the domain instead of restating them", () => {
    const src = readFileSync(new URL("../src/transcription.ts", import.meta.url), "utf8");
    expect(src).toContain("TRANSCRIPTION_ID");
    expect(src).toContain("LANGUAGE_CHOICE");
    expect(src).toContain("LANGUAGE_CODE");
    expect(src).toContain("TX_PROBLEMS");
    expect(src).toContain("TX_STATES");
    expect(src).not.toMatch(/A-Za-z0-9:_-/);
  });
});

describe("transcription API bodies", () => {
  it("accepts a create, a done view and a cancel, and refuses a path or a command on any of them", () => {
    expect(parseBody(TranscriptionCreateBody, CREATE)).toEqual(CREATE);
    expect(parseBody(TranscriptionCreateBody, { ...CREATE, language: "pt-BR" })).toEqual({ ...CREATE, language: "pt-BR" });
    expect(parseBody(TranscriptionCreateBody, { ...CREATE, path: "/tmp/note.wav" })).toBeNull();
    expect(parseBody(TranscriptionCreateBody, { ...CREATE, language: "DE" })).toBeNull();
    expect(parseBody(TranscriptionCreateBody, { ...CREATE, sizeBytes: 4096 })).toBeNull();
    expect(parseBody(TranscriptionCreateBody, { ...CREATE, recording: { kind: "note", id: "abc123def456" } })).toBeNull();
    expect(parseBody(TranscriptionView, VIEW)).toEqual(VIEW);
    const edited = { ...VIEW, text: { ...VIEW.text, edit: "Der Steg ist frei.", edited: true } };
    expect(parseBody(TranscriptionView, edited)).toEqual(edited);
    const waiting = { ...VIEW, state: "queued", position: 2, reason: "class", outcome: null, text: null };
    expect(parseBody(TranscriptionView, waiting)).toEqual(waiting);
    expect(parseBody(TranscriptionView, { ...VIEW, path: "/tmp/note.wav" })).toBeNull();
    expect(parseBody(TranscriptionView, { ...VIEW, state: "paused" })).toBeNull();
    expect(parseBody(TranscriptionCancelBody, {})).toEqual({});
    expect(parseBody(TranscriptionCancelBody, { command: "rm -rf /" })).toBeNull();
  });

  it("reports the capability as false, or as the engine the probe named", () => {
    expect(parseBody(MeTranscription, false)).toBe(false);
    const on = { engine: "fixture-ear", model: "tiny-fixture", languages: "multi" as const, maxSeconds: 600 };
    expect(parseBody(MeTranscription, on)).toEqual(on);
    expect(parseBody(MeTranscription, { ...on, languages: ["de", "en"] })).toEqual({ ...on, languages: ["de", "en"] });
    expect(parseBody(MeTranscription, true)).toBeNull();
    expect(parseBody(MeTranscription, { ...on, path: "/models/x.bin" })).toBeNull();
    expect(parseBody(MeTranscription, { ...on, languages: ["auto"] })).toBeNull();
    expect(parseBody(MeTranscription, { ...on, languages: [] })).toBeNull();
    expect(parseBody(MeTranscription, { engine: "fixture-ear" })).toBeNull();
  });
});
