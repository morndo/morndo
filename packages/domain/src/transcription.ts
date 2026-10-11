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
