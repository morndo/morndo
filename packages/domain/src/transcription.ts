// Transcription (ADR-0021; design docs/design/transcription): one attempt to turn one Recording into Text, on the
// hub's own machine, through a Transcriber the default install does not include. This module holds the ubiquitous
// language and the invariants TX1–TX9: the states, the caps, the queue decision (shared with Jobs, queue.ts) and
// the Text. It starts nothing and reads nothing: no engine, no file, no clock. Callers pass `at` and the Capability.
//
// Recording   an audio Upload of the principal's, or an audio Attachment an agent sent. Known by its upload id or
//             its hub file id. Not a Transcript (Observation's word for a session log).
// Transcription  one attempt on one Recording: a state, a queue position and reason, an outcome, and when done its
//             Text. Not a Job: no command line, no lane (TX1).
// Text        what the engine heard: the language, segments with start and end times, the joined text, the engine
//             and model that produced it, and whether the principal edited it. Not a Command, until sent (TX8).
// Language choice  `auto`, or a language code the engine lists. Not a translation target.
// Capability  whether a ready Transcriber is there now. Not a setting: it follows the probe (TX9).
import { err, ok, type Result } from "./shared.ts";
import { queueDecision, type QueueGuard, type QueueReason } from "./queue.ts";

// The one class Transcriptions run in (ADR-0021 decision 7: the Job rules, not the Job rows).
export type AudioContainer = "ogg" | "webm" | "mp4" | "mp3" | "wav";

const at = (b: Uint8Array, i: number, ...magic: number[]) => magic.every((x, k) => b[i + k] === x);

// S1: an audio file is known by its own bytes, as an image is (steering.ts). `OggS` covers .ogg, .oga and .opus;
// the EBML magic a webm recording (the magic is all this reads of one: whether a webm holds audio sits deeper in
// the file than a sniff goes); `ftyp` at offset 4 with the audio major brand `M4A` an mp4 recording (Safari names
// it .m4a) — the design names only `ftyp`, and the brand is this check's own conservative call, so a photo (heic,
// avif) or a movie (isom, mp42) brand is not audio; `ID3` or an MPEG frame sync an mp3; `RIFF`…`WAVE` a wav.
export function sniffAudio(b: Uint8Array): AudioContainer | null {
  if (b.length >= 4 && at(b, 0, 0x4f, 0x67, 0x67, 0x53)) return "ogg";
  if (b.length >= 4 && at(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (b.length >= 11 && at(b, 4, 0x66, 0x74, 0x79, 0x70) && at(b, 8, 0x4d, 0x34, 0x41)) return "mp4";
  if (b.length >= 3 && at(b, 0, 0x49, 0x44, 0x33)) return "mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return "mp3";
  if (b.length >= 12 && at(b, 0, 0x52, 0x49, 0x46, 0x46) && at(b, 8, 0x57, 0x41, 0x56, 0x45)) return "wav";
  return null;
}

// The Capability (TX9): `present` only when the probe says a Transcriber is ready, with the longest Recording it
// will take. It follows the probe; it is not a setting. A malformed `present` counts as absent.
export const CAPABILITY_REASONS = ["missing", "not_ready", "protocol"] as const;
export type CapabilityReason = (typeof CAPABILITY_REASONS)[number];
export type TranscriptionCapability =
  | { present: true; maxSeconds: number }
  | { present: false; reason: CapabilityReason };
export const NO_CAPABILITY: TranscriptionCapability = { present: false, reason: "missing" };

// A Recording is the principal's audio Upload or an agent's audio Attachment, by id. The same id under the two
// kinds is two recordings.
export type RecordingKind = "upload" | "attachment";
export type Recording = { kind: RecordingKind; id: string };

// What the engine reports: the language it settled on, how long the audio was, and what it heard, segment by
// segment. The domain joins and caps the words; this never carries audio (4, EngineText).
export type Segment = { startMs: number; endMs: number; text: string };
export type EngineText = { language: string; durationMs: number; segments: readonly Segment[] };

// TX6: a Recording is at most 10 MiB and at most maxSeconds long, and the Text of one attempt is at most 64 KiB
// of UTF-8. The cut lands on a code point boundary and names itself.
export const MAX_RECORDING_BYTES = 10 * 1024 * 1024;
export const MAX_RECORDING_SECONDS = 600;
export const MAX_TEXT_BYTES = 64 * 1024;
const TEXT_MARK = "[truncated]";

const utf8Bytes = (ch: string): number => {
  const c = ch.codePointAt(0) ?? 0;
  return c <= 0x7f ? 1 : c <= 0x7ff ? 2 : c <= 0xffff ? 3 : 4;
};

// The engine's segments become one text: trimmed words joined by a space, capped to MAX_TEXT_BYTES. Words that fit
// are kept whole; only a cut sets room aside for the mark that names it. One walk counts the bytes as the words are
// joined: the moment a code point would pass the cap, the cut falls where the mark still fits.
export function makeText(engine: EngineText, engineName: string, model: string): TranscriptionText {
  const joined = engine.segments.map(seg => seg.text.trim()).filter(word => word !== "").join(" ");
  const room = MAX_TEXT_BYTES - TEXT_MARK.length;
  let out = "";
  let bytes = 0;
  let roomy = 0;   // code points of `out` that still leave room for the mark
  for (const ch of joined) {
    const b = utf8Bytes(ch);
    if (bytes + b > MAX_TEXT_BYTES) {
      return { language: engine.language, text: out.slice(0, roomy) + TEXT_MARK, edit: null, edited: false, engine: engineName, model };
    }
    out += ch;
    bytes += b;
    if (bytes <= room) roomy = out.length;
  }
  return { language: engine.language, text: out, edit: null, edited: false, engine: engineName, model };
}

// The states of one attempt (3.4): queued behind others, starting, running, or terminal once. `lost` is a run the
// hub no longer knows the end of (TX4). The row's `outcome` holds the terminal state it ended in.
export const TX_TERMINAL = ["done", "failed", "timed_out", "cancelled", "lost"] as const;
export const TX_STATES = ["queued", "starting", "running", ...TX_TERMINAL] as const;
export type TranscriptionState = (typeof TX_STATES)[number];
export type TxOutcome = (typeof TX_TERMINAL)[number];
export type TranscriptionProblem = "unreadable" | "too_long" | "not_ready" | "bad_output" | "engine";

// The Text one attempt produced: the joined words, the language the engine settled on, the engine and model that
// made them, and whether the principal edited them (TX7). It grants nothing by itself (TX8).
export type TranscriptionText = {
  language: string;
  text: string;
  edit: string | null;
  edited: boolean;
  engine: string;
  model: string;
};

export type Transcription = {
  id: string;
  recording: Recording;
  language: string;
  sizeBytes: number;
  acceptedAt: number;
  state: TranscriptionState;
  position: number | null;
  reason: QueueReason | null;
  outcome: TxOutcome | null;
  problem: TranscriptionProblem | null;
  text: TranscriptionText | null;
  report: EndReport | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type TranscriptionBody = {
  id: string;
  recording: Recording;
  sizeBytes: number;
  language: string;
};

// The report that ended a `done` attempt, whatever verdict the cap gave it: the words as capped, the language, the
// engine and the model that made them, and the duration they name (TX3). A repeat of it is the same row; a report
// that differs in any field is refused, whatever the cap now in force.
export type EndReport = {
  language: string;
  durationMs: number;
  engineName: string;
  model: string;
  text: string;
};

export type RequestProblem = "no_capability" | "bad_id" | "id_conflict" | "bad_recording" | "bad_language" | "bad_size";

const TX_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
// `auto`, or a language code with optional subtags (`de`, `pt-br`). Not case-free: `DE` is not a code.
const LANGUAGE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{1,8})*)$/;

// The one question both contexts ask of it (TX9, S1): present means a ready Transcriber, and a malformed
// `present` counts as absent.
export const capabilityReady = (c: TranscriptionCapability): boolean =>
  c.present === true && Number.isInteger(c.maxSeconds) && c.maxSeconds > 0;

const sameRecording = (a: Recording, b: Recording): boolean => a.kind === b.kind && a.id === b.id;
const open = (state: TranscriptionState) => state === "queued" || state === "starting" || state === "running";

// TX9 first: with no ready Transcriber nothing runs and nothing is offered, whatever the body. Then the body is
// checked, then TX2: one attempt per Recording and Language, so a repeat returns the attempt already in flight
// unchanged. A terminal attempt holds nothing (TX3): asking again makes a new one, and only the caller's ids tell
// them apart.
export function requestTranscription(
  existing: readonly Transcription[],
  body: TranscriptionBody,
  at: number,
  capability: TranscriptionCapability,
): Result<Transcription, RequestProblem> {
  if (!capabilityReady(capability)) return err("no_capability");
  // The pattern is for strings only: `test` would read a missing id as "undefined" and a number as its digits, and
  // a row keyed by such an id would answer for every other (TX5's queue is keyed by id).
  if (typeof body.id !== "string" || !TX_ID.test(body.id)) return err("bad_id");
  const recording = body.recording;
  if (!recording || (recording.kind !== "upload" && recording.kind !== "attachment")
    || typeof recording.id !== "string" || !TX_ID.test(recording.id)) {
    return err("bad_recording");
  }
  if (!LANGUAGE.test(body.language)) return err("bad_language");
  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes < 0 || body.sizeBytes > MAX_RECORDING_BYTES) return err("bad_size");
  const inFlight = existing.find(row => sameRecording(row.recording, recording) && row.language === body.language && open(row.state));
  if (inFlight) return ok(inFlight);
  // TX3: asking again after an end makes a new attempt, and only the caller's ids tell the two apart, so an id that
  // names a finished attempt is a conflict, as a Job's is (jobs.ts). An id may be shared only by attempts in flight.
  if (existing.some(row => row.id === body.id && terminal(row.state))) return err("id_conflict");
  return ok({
    id: body.id, recording, language: body.language, sizeBytes: body.sizeBytes, acceptedAt: at,
    state: "queued", position: null, reason: null, outcome: null, problem: null, text: null, report: null,
    startedAt: null, endedAt: null,
  });
}

// TranscriptionStarted (3.5): the engine has begun. Only `starting` moves, and a repeat is the same row: a late
// duplicate of the report changes nothing.
export type TranscriptionStartProblem = "not_starting";

export function startTranscription(tx: Transcription, at: number): Result<Transcription, TranscriptionStartProblem> {
  if (tx.state === "running") return ok(tx);
  if (tx.state !== "starting") return err("not_starting");
  return ok({ ...tx, state: "running", startedAt: at, position: null, reason: null });
}

// TranscriptionEnded (3.5), the only event that carries Text. `done` from a running attempt; `failed` also from a
// queued one (an engine that turned out not ready before any start); `timed_out` needs a run; `cancelled` at any
// live state; `lost` is the hub's own verdict on a run whose end it never recorded (TX4).
export type TranscriptionEnd =
  | { outcome: "done"; at: number; engine: EngineText; engineName: string; model: string }
  | { outcome: "failed"; at: number; problem: TranscriptionProblem }
  | { outcome: "timed_out"; at: number }
  | { outcome: "cancelled"; at: number }
  | { outcome: "lost"; at: number };

export type EndProblem = "not_running" | "already_terminal" | "bad_end";

// TX3: terminal once. The same outcome again is the same row; a different one, or a different report for the same
// outcome, is refused. A `failed` report is its problem; a `done` report is every field of it: the words, the
// language, the engine, the model and the duration. When it ended never matters. Nothing here starts a new attempt:
// asking again is a new request (requestTranscription).
const engineOk = (e: EngineText): boolean =>
  typeof e === "object" && e !== null && typeof e.language === "string"
  && Number.isInteger(e.durationMs) && e.durationMs >= 0
  && Array.isArray(e.segments)
  && e.segments.every(seg => typeof seg === "object" && seg !== null
    && Number.isInteger(seg.startMs) && Number.isInteger(seg.endMs) && typeof seg.text === "string");

const sameReport = (report: EndReport | null, event: { engine: EngineText; engineName: string; model: string }): boolean =>
  report !== null
  && report.language === event.engine.language
  && report.durationMs === event.engine.durationMs
  && report.engineName === event.engineName
  && report.model === event.model
  && report.text === makeText(event.engine, event.engineName, event.model).text;

export function endTranscription(tx: Transcription, event: TranscriptionEnd, maxSeconds = MAX_RECORDING_SECONDS): Result<Transcription, EndProblem> {
  if (!Number.isInteger(event.at)) return err("bad_end");
  if (event.outcome === "done" && !engineOk(event.engine)) return err("bad_end");
  if (terminal(tx.state)) {
    // A `done` the cap turned into `failed: too_long` is that report's outcome, so the done again — an adapter's
    // retry — is judged on the report it keeps, never on the cap now in force.
    if (event.outcome === "done" && tx.outcome === "failed" && tx.problem === "too_long") {
      return sameReport(tx.report, event) ? ok(tx) : err("already_terminal");
    }
    if (event.outcome !== tx.outcome) return err("already_terminal");
    if (event.outcome === "done") return sameReport(tx.report, event) ? ok(tx) : err("already_terminal");
    if (event.outcome === "failed" && event.problem !== tx.problem) return err("already_terminal");
    return ok(tx);
  }
  const ran = tx.state === "running";
  if (event.outcome === "done" && !ran) return err("not_running");
  if (event.outcome === "timed_out" && !ran) return err("not_running");
  if (event.outcome === "lost" && !ran && tx.state !== "starting") return err("not_running");
  if (event.outcome === "done") {
    const text = makeText(event.engine, event.engineName, event.model);
    const report: EndReport = {
      language: event.engine.language, durationMs: event.engine.durationMs,
      engineName: event.engineName, model: event.model, text: text.text,
    };
    if (event.engine.durationMs > maxSeconds * 1000) {
      return ok({ ...tx, state: "failed", outcome: "failed", problem: "too_long", endedAt: event.at, position: null, reason: null, report });
    }
    return ok({
      ...tx, state: "done", outcome: "done", endedAt: event.at, position: null, reason: null,
      text, report,
    });
  }
  if (event.outcome === "failed") {
    return ok({ ...tx, state: "failed", outcome: "failed", problem: event.problem, endedAt: event.at, position: null, reason: null });
  }
  return ok({ ...tx, state: event.outcome, outcome: event.outcome, endedAt: event.at, position: null, reason: null });
}

// 9: the timeout is the config's, or 120 s plus six times the duration when it names none.
export function transcriptionTimeoutMs(durationMs: number, timeoutSec: number | null): number {
  return typeof timeoutSec === "number" && timeoutSec > 0 ? timeoutSec * 1000 : 120_000 + 6 * durationMs;
}

// 9: half the cores, at most eight, so the agents keep the other half — and never fewer than one, for a run needs
// a thread however small the machine.
export function threadsFor(cores: number): number {
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

// 9: the probe can lower the cap; the setting cannot raise it past what the plugin offered.
export function effectiveMaxSeconds(configured: number, pluginMaxSeconds: number): number {
  return Math.min(configured, pluginMaxSeconds);
}

const utf8Len = (s: string): number => {
  let n = 0;
  for (const ch of s) n += utf8Bytes(ch);
  return n;
};

// TX7, TextEdited (3.5): the engine's words are never overwritten. An edit is kept beside them, trimmed and within
// the Text cap, and the result is marked `edited`. The Recording stays; the Text grants nothing (TX8).
export type EditProblem = "not_done" | "bad_text";

export function editText(tx: Transcription, text: string): Result<Transcription, EditProblem> {
  if (tx.state !== "done" || tx.text === null) return err("not_done");
  const clean = text.trim();
  if (clean === "" || utf8Len(clean) > MAX_TEXT_BYTES) return err("bad_text");
  // Going back to the engine's words takes the edit away: they are the words again, unmarked. Words identical to
  // the engine's were never an edit, and an edit that returns to them no longer is one either.
  if (clean === tx.text.text) {
    return ok(tx.text.edit === null ? tx : { ...tx, text: { ...tx.text, edit: null, edited: false } });
  }
  return ok({ ...tx, text: { ...tx.text, edit: clean, edited: true } });
}

const terminal = (state: TranscriptionState): state is TxOutcome => !open(state);

// TX4: after a restart, a run with no recorded end is `lost` and the row stays, with no Text. What never ran is
// still queued and waits on. A second restart changes nothing: `lost` is terminal once too.
export function afterRestart(rows: readonly Transcription[], at: number): Transcription[] {
  return rows.map(tx => tx.state === "running" || tx.state === "starting"
    ? { ...tx, state: "lost", outcome: "lost", endedAt: at, position: null, reason: null, text: null }
    : tx);
}

// TX5: the one class runs at most its limit (the default is one), by the same decision Jobs uses (queue.ts). A free
// slot is `starting`, with no start time, until work has begun. A guard delays every start and stops nothing. The
// limit is the caller's: the config's number, or this default when it names none.
export const TRANSCRIPTION_LIMIT_DEFAULT = 1;

export function scheduleTranscriptions(rows: readonly Transcription[], limit: number, guard: QueueGuard): Transcription[] {
  const queued = rows.filter(tx => tx.state === "queued");
  const running = rows.filter(tx => tx.state === "starting" || tx.state === "running").length;
  const slots = queueDecision(queued, running, limit, guard);
  return rows.map(tx => {
    // TX3: a slot is for a waiting row only, as Jobs' schedule is. A finished row keeps its end whatever its id,
    // so a queued row that shares a finished row's id can never bring it back to life.
    if (tx.state !== "queued") return tx;
    const slot = slots.get(tx.id);
    if (!slot) return tx;
    return slot.start
      ? { ...tx, state: "starting", position: null, reason: null, startedAt: null, endedAt: null }
      : { ...tx, position: slot.position, reason: slot.reason };
  });
}

// TX8: Text grants nothing. These are the words the composer may show, and only for the principal's own done
// Upload — an agent's Recording is that agent's content. It becomes part of a Command only when the principal
// sends it; that decision is Steering's, on send.
export function composerText(tx: Transcription): string | null {
  if (tx.state !== "done" || tx.text === null) return null;
  if (tx.recording.kind !== "upload") return null;
  return tx.text.edit ?? tx.text.text;
}
