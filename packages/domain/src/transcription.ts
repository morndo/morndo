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
import { type QueueReason } from "./queue.ts";

// The one class Transcriptions run in (ADR-0021 decision 7: the Job rules, not the Job rows).
export type AudioContainer = "ogg" | "webm" | "mp4" | "mp3" | "wav";

const at = (b: Uint8Array, i: number, ...magic: number[]) => magic.every((x, k) => b[i + k] === x);

// S1: an audio file is known by its own bytes, as an image is (steering.ts). `OggS` covers .ogg, .oga and .opus;
// the EBML magic a webm recording; `ftyp` at offset 4 an mp4 recording (Safari names it .m4a); `ID3` or an MPEG
// frame sync an mp3; `RIFF`…`WAVE` a wav.
export function sniffAudio(b: Uint8Array): AudioContainer | null {
  if (b.length >= 4 && at(b, 0, 0x4f, 0x67, 0x67, 0x53)) return "ogg";
  if (b.length >= 4 && at(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (b.length >= 8 && at(b, 4, 0x66, 0x74, 0x79, 0x70)) return "mp4";
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
  startedAt: number | null;
  endedAt: number | null;
};

export type TranscriptionBody = {
  id: string;
  recording: Recording;
  sizeBytes: number;
  language: string;
};

export type RequestProblem = "no_capability" | "bad_id" | "bad_recording" | "bad_language" | "bad_size";

const TX_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
// `auto`, or a language code with optional subtags (`de`, `pt-br`). Not case-free: `DE` is not a code.
const LANGUAGE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{1,8})*)$/;

const capable = (c: TranscriptionCapability): boolean =>
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
  if (!capable(capability)) return err("no_capability");
  if (!TX_ID.test(body.id)) return err("bad_id");
  const recording = body.recording;
  if (!recording || (recording.kind !== "upload" && recording.kind !== "attachment") || !TX_ID.test(recording.id ?? "")) {
    return err("bad_recording");
  }
  if (!LANGUAGE.test(body.language)) return err("bad_language");
  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes < 0) return err("bad_size");
  const inFlight = existing.find(row => sameRecording(row.recording, recording) && row.language === body.language && open(row.state));
  if (inFlight) return ok(inFlight);
  return ok({
    id: body.id, recording, language: body.language, sizeBytes: body.sizeBytes, acceptedAt: at,
    state: "queued", position: null, reason: null, outcome: null, problem: null, text: null, startedAt: null, endedAt: null,
  });
}
