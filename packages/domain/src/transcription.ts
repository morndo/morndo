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
// the file than a sniff goes, and the engine's own decoding is the second gate); `ftyp` at offset 4 with a major
// brand a recorder writes an mp4 recording — `M4A ` (Safari names the file .m4a) or one of the iso and mp4 brands
// a browser's MediaRecorder writes (Chromium's muxer writes isom). An image's brand (heic, heix, avif, mif1,
// msf1) or any other brand is not audio; a movie's brand passes the gate and the engine reads the file's audio
// track, which is acceptable. `ID3` or an MPEG frame sync an mp3; `RIFF`…`WAVE` a wav.
const MP4_BRANDS = new Set(["M4A ", "isom", "iso2", "iso5", "iso6", "mp41", "mp42"]);

export function sniffAudio(b: Uint8Array): AudioContainer | null {
  if (b.length >= 4 && at(b, 0, 0x4f, 0x67, 0x67, 0x53)) return "ogg";
  if (b.length >= 4 && at(b, 0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (b.length >= 12 && at(b, 4, 0x66, 0x74, 0x79, 0x70)
    && MP4_BRANDS.has(String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!))) return "mp4";
  if (b.length >= 3 && at(b, 0, 0x49, 0x44, 0x33)) return "mp3";
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return "mp3";
  if (b.length >= 12 && at(b, 0, 0x52, 0x49, 0x46, 0x46) && at(b, 8, 0x57, 0x41, 0x56, 0x45)) return "wav";
  return null;
}

// §9: how long one Recording's audio is, read from its own container — the timeout scales with it. The bytes are
// what a reader took of the file: `head` from the front, and the last `tail` bytes starting at `tailAt`, where
// some containers keep their length (an m4a's moov can sit at the end, and an Ogg's last page holds the final
// granule position). Null whenever the bytes do not say: the caller uses its cap, never a guess.
//
// Where each container keeps it: a wav's `data` chunk over the `fmt ` chunk's byte rate (RIFF); an mp4's mvhd
// timescale and duration, version 0 or 1 (ISO/IEC 14496-12); an mp3's Xing frame count (VBR) or its frame
// bitrate over the bytes that follow the ID3v2 tag (id3.org/id3v2.3.0); an Ogg page's granule position — always
// 48 kHz for Opus (RFC 7845 §4), the identification header's rate for Vorbis; a webm's Duration element scaled
// by TimecodeScale, both read only from Segment > Info (Matroska's EBML).
export type AudioBytes = { head: Uint8Array; tail?: Uint8Array; tailAt?: number; size: number };

const fits = (b: Uint8Array, i: number, n: number) => i >= 0 && i + n <= b.length;
const u32be = (b: Uint8Array, i: number) => b[i]! * 2 ** 24 + b[i + 1]! * 2 ** 16 + b[i + 2]! * 2 ** 8 + b[i + 3]!;
const u32le = (b: Uint8Array, i: number) => b[i]! + b[i + 1]! * 256 + b[i + 2]! * 2 ** 16 + b[i + 3]! * 2 ** 24;
const u64le = (b: Uint8Array, i: number) => u32le(b, i) + u32le(b, i + 4) * 2 ** 32;
const text = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function wavDuration(head: Uint8Array): number | null {
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  let i = 12;                                                // past RIFF <size> WAVE
  while (i + 8 <= head.length && (byteRate === null || dataBytes === null)) {
    const id = text(head, i, 4);
    const size = u32le(head, i + 4);
    if (id === "fmt " && fits(head, i + 20, 4)) byteRate = u32le(head, i + 16);              // body: … byteRate @ 8
    if (id === "data") dataBytes = size;
    i += 8 + size + (size % 2);                              // chunks are word-aligned
  }
  return byteRate !== null && byteRate > 0 && dataBytes !== null && dataBytes > 0
    ? Math.round((dataBytes / byteRate) * 1000)
    : null;
}

// Bytes at a file offset. A range that sits in the head, or in the tail, is that slice. A range that
// starts in the head and ends in the tail is both slices joined, and only when they meet: a hole between
// them is not guessed at.
function readAt(bytes: AudioBytes, offset: number, n: number): Uint8Array | null {
  if (offset < 0 || n < 0 || offset + n > bytes.size) return null;
  if (offset + n <= bytes.head.length) return bytes.head.subarray(offset, offset + n);
  const tail = bytes.tail;
  if (!tail) return null;
  const tailAt = bytes.tailAt ?? bytes.size - tail.length;
  const end = offset + n;
  if (offset >= tailAt && end <= tailAt + tail.length) return tail.subarray(offset - tailAt, end - tailAt);
  if (offset < bytes.head.length && bytes.head.length >= tailAt && end > tailAt && end <= tailAt + tail.length) {
    const headPart = bytes.head.subarray(offset, tailAt);
    const tailPart = tail.subarray(0, end - tailAt);
    const out = new Uint8Array(headPart.length + tailPart.length);
    out.set(headPart, 0);
    out.set(tailPart, headPart.length);
    return out;
  }
  return null;
}

// ISO/IEC 14496-12: size 1 means the next 8 bytes are the real size; size 0 means the box runs to the end of the file.
function boxSizeAt(bytes: AudioBytes, offset: number): { size: number; header: number } | null {
  const header = readAt(bytes, offset, 8);
  if (!header) return null;
  const size = u32be(header, 0);
  if (size === 1) {
    const ext = readAt(bytes, offset + 8, 8);
    if (!ext) return null;
    const full = u32be(ext, 0) * 2 ** 32 + u32be(ext, 4);
    return full >= 16 ? { size: full, header: 16 } : null;
  }
  if (size === 0) {
    const full = bytes.size - offset;
    return full >= 8 ? { size: full, header: 8 } : null;
  }
  return size >= 8 ? { size, header: 8 } : null;
}

function mvhdMs(moov: Uint8Array): number | null {
  let j = u32be(moov, 0) === 1 ? 16 : 8;
  while (j + 8 <= moov.length) {
    const inner = boxSizeAt({ head: moov, size: moov.length }, j);
    if (!inner || j + inner.size > moov.length) return null;
    if (text(moov, j + 4, 4) === "mvhd") {
      const version = moov[j + inner.header];                  // 0: 32-bit fields; 1: 64-bit dates, then the same
      const scaleAt = j + inner.header + (version === 1 ? 20 : 12);
      const durationAt = scaleAt + 4;
      if (!fits(moov, scaleAt, 4) || !fits(moov, durationAt, version === 1 ? 8 : 4)) return null;
      const scale = u32be(moov, scaleAt);
      const duration = version === 1
        ? u32be(moov, durationAt) * 2 ** 32 + u32be(moov, durationAt + 4)
        : u32be(moov, durationAt);
      return scale > 0 && duration > 0 && duration < 2 ** 32 - 1
        ? Math.round((duration / scale) * 1000)
        : null;
    }
    j += inner.size;
  }
  return null;
}

// Walk top-level boxes from offset 0. Each box names its own size, so a moov that sits after a large mdat is
// reached by skipping that size, and a header is read only where the head or the tail actually holds it. The
// tail slice is not itself a box: starting the walk at its first byte parses the middle of mdat.
function mp4Duration(bytes: AudioBytes): number | null {
  let pos = 0;
  while (pos + 8 <= bytes.size) {
    const header = readAt(bytes, pos, 8);
    const box = boxSizeAt(bytes, pos);
    if (!header || !box || pos + box.size > bytes.size) return null;
    if (text(header, 4, 4) === "moov") {
      const moov = readAt(bytes, pos, box.size);
      return moov ? mvhdMs(moov) : null;
    }
    pos += box.size;
  }
  return null;
}

// MPEG audio frame header tables (MPEG-1/2/2.5, Layer III), as every decoder reads them.
const MP3_BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

function mp3Duration(head: Uint8Array, size: number): number | null {
  let i = 0;
  if (at(head, 0, 0x49, 0x44, 0x33)) {                        // an ID3v2 tag first: a sync-safe size
    if (!fits(head, 0, 10)) return null;
    const flags = head[5]!;
    i = 10 + (((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f))
      + (flags & 0x10 ? 10 : 0);                            // ID3v2.4 footer is 10 bytes, and the size excludes it
  }
  if (!fits(head, i, 4) || head[i] !== 0xff || (head[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (head[i + 1]! >> 3) & 0x3;                  // 3: MPEG-1; 2: MPEG-2; 0: MPEG-2.5
  const layer = (head[i + 1]! >> 1) & 0x3;                    // 1: Layer III
  if (version === 1 || layer !== 1) return null;              // a reserved version, or not Layer III
  const bitrate = (version === 3 ? MP3_BITRATE_V1 : MP3_BITRATE_V2)[head[i + 2]! >> 4] ?? 0;
  const rate = MP3_RATES[version]?.[(head[i + 2]! >> 2) & 0x3] ?? 0;
  if (bitrate <= 0 || rate <= 0) return null;
  // A VBR file names its frames in a Xing/Info tag inside the first frame (Xing header specification).
  const scanEnd = Math.min(head.length, i + 200);
  for (let k = i + 4; k + 12 <= scanEnd; k++) {
    const tag = text(head, k, 4);
    if (tag !== "Xing" && tag !== "Info") continue;
    if (u32be(head, k + 4) & 0x1) {                           // the frames flag
      const frames = u32be(head, k + 8);
      return frames > 0 ? Math.round((frames * (version === 3 ? 1152 : 576) / rate) * 1000) : null;
    }
    break;
  }
  return size > i ? Math.round(((size - i) / (bitrate * 125)) * 1000) : null;   // CBR: the bytes over the bitrate
}

function oggDuration(head: Uint8Array, tail: Uint8Array | undefined): number | null {
  if (!fits(head, 0, 28)) return null;
  const payload = 27 + head[26]!;                             // page header, then the segment table
  let rate: number | null = null;
  if (fits(head, payload, 8) && head[payload] === 0x7f && text(head, payload + 1, 8) === "OpusHead") rate = 48_000;
  else if (fits(head, payload, 16) && head[payload] === 0x01 && text(head, payload + 1, 6) === "vorbis") {
    const rate2 = u32le(head, payload + 12);                  // the identification header names its rate
    if (rate2 > 0) rate = rate2;
  }
  if (rate === null) return null;
  const granuleOf = (b: Uint8Array): number | null => {
    for (let k = b.length - 4; k >= 0; k--) {
      if (!at(b, k, 0x4f, 0x67, 0x67, 0x53)) continue;        // the last page in the slice
      return fits(b, k, 14) && u64le(b, k + 6) > 0 ? u64le(b, k + 6) : null;
    }
    return null;
  };
  const granule = (tail ? granuleOf(tail) : null) ?? granuleOf(head);
  return granule !== null ? Math.round((granule / rate) * 1000) : null;
}

// Matroska's EBML: lengths are vints, a size of all ones means "to the end" (a streamed file).
const vintLen = (b: Uint8Array, i: number): number => {
  for (let k = 0; k < 8; k++) {
    if (!fits(b, i, k + 1)) return 0;
    if (b[i]! & (0x80 >> k)) return k + 1;
  }
  return 0;
};
const vintId = (b: Uint8Array, i: number, len: number) => { let v = 0; for (let k = 0; k < len; k++) v = v * 256 + b[i + k]!; return v; };
const vintSize = (b: Uint8Array, i: number, len: number) => {
  let v = b[i]! & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + b[i + k]!;
  return v;
};

// One EBML element at `i`, or null when the header does not fit. The payload is not walked here: Duration and
// TimecodeScale live in Segment > Info, and a Cluster's audio must not be searched for those ids.
function ebmlAt(b: Uint8Array, i: number, end: number): { id: number; data: number; stop: number } | null {
  const idLen = vintLen(b, i);
  if (idLen === 0 || i + idLen > end) return null;
  const id = vintId(b, i, idLen);
  let j = i + idLen;
  const sizeLen = vintLen(b, j);
  if (sizeLen === 0 || j + sizeLen > end) return null;
  const size = vintSize(b, j, sizeLen);
  j += sizeLen;
  const stop = size === 2 ** (7 * sizeLen) - 1 ? end : Math.min(end, j + size);   // all ones: streamed to the end
  if (stop < j) return null;
  return { id, data: j, stop };
}

const ebmlUint = (b: Uint8Array, data: number, stop: number): number | null => {
  const width = stop - data;
  if (width <= 0 || width > 8) return null;
  let v = 0;
  for (let k = 0; k < width; k++) v = v * 256 + b[data + k]!;
  return v;
};

const ebmlFloat = (b: Uint8Array, data: number, stop: number): number | null => {
  const width = stop - data;
  if (width !== 4 && width !== 8) return null;
  const view = new DataView(b.buffer, b.byteOffset + data, width);       // big-endian, as EBML writes it
  return width === 4 ? view.getFloat32(0) : view.getFloat64(0);
};

function webmDuration(head: Uint8Array): number | null {
  // Matroska: Duration and TimestampScale are children of Segment > Info, nowhere else. A Cluster is skipped
  // by its size. Descending into it would treat audio bytes that happen to match those ids as the length.
  let scale: number | null = null;
  let duration: number | null = null;
  let i = 0;
  while (i + 2 <= head.length) {
    const top = ebmlAt(head, i, head.length);
    if (!top || top.stop <= i) break;
    if (top.id === 0x18538067) {                                          // Segment
      let j = top.data;
      while (j + 2 <= top.stop) {
        const child = ebmlAt(head, j, top.stop);
        if (!child || child.stop <= j) break;
        if (child.id === 0x1549a966) {                                    // Info, and only Info
          let k = child.data;
          while (k + 2 <= child.stop) {
            const field = ebmlAt(head, k, child.stop);
            if (!field || field.stop <= k) break;
            if (field.id === 0x2ad7b1) scale = ebmlUint(head, field.data, field.stop);
            else if (field.id === 0x4489) duration = ebmlFloat(head, field.data, field.stop);
            k = field.stop;
          }
        }
        j = child.stop;
      }
    }
    i = top.stop;
  }
  const unit = scale ?? 1_000_000;                                        // the spec's default unit: one millisecond
  const ms = duration !== null ? (duration * unit) / 1e6 : null;
  return ms !== null && ms > 0 && Number.isFinite(ms) ? Math.round(ms) : null;
}

export function audioDurationMs(bytes: AudioBytes): number | null {
  const container = sniffAudio(bytes.head);
  if (!container) return null;
  const ms = container === "wav" ? wavDuration(bytes.head)
    : container === "mp4" ? mp4Duration(bytes)
      : container === "mp3" ? mp3Duration(bytes.head, bytes.size)
        : container === "ogg" ? oggDuration(bytes.head, bytes.tail)
          : webmDuration(bytes.head);
  return ms !== null && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
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
export const TX_PROBLEMS = ["unreadable", "too_long", "not_ready", "bad_output", "engine"] as const;
export type TranscriptionProblem = (typeof TX_PROBLEMS)[number];

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

export type TranscriptionRequestProblem = "no_capability" | "bad_id" | "id_conflict" | "bad_recording" | "bad_language" | "bad_size" | "too_many";

// The caller's id for an attempt or a Recording. The same shape as a job id: one run of letters, digits and a few
// marks, so a path cannot be one.
export const TRANSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
// A language the engine settled on (`de`, `pt-BR`). Not `auto`, and not case-free: `DE` is not a code.
// The choice is that body, or `auto`. One body, so the two patterns cannot drift.
const LANGUAGE_CODE_BODY = "[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*";
export const LANGUAGE_CODE = new RegExp(`^${LANGUAGE_CODE_BODY}$`);
export const LANGUAGE_CHOICE = new RegExp(`^(?:auto|${LANGUAGE_CODE_BODY})$`);

// The one question both contexts ask of it (TX9, S1): present means a ready Transcriber, and a malformed
// `present` counts as absent.
export const capabilityReady = (c: TranscriptionCapability): boolean =>
  c.present === true && Number.isInteger(c.maxSeconds) && c.maxSeconds > 0;

const sameRecording = (a: Recording, b: Recording): boolean => a.kind === b.kind && a.id === b.id;
// The body a row was accepted on, as a Job's accept compares its own (jobs.ts): the Recording, the size and the
// language, with the id already held.
const sameBody = (row: Transcription, body: TranscriptionBody): boolean =>
  row.id === body.id && sameRecording(row.recording, body.recording)
  && row.language === body.language && row.sizeBytes === body.sizeBytes;
const open = (state: TranscriptionState) => state === "queued" || state === "starting" || state === "running";

// TX9 first: with no ready Transcriber nothing runs and nothing is offered, whatever the body. Then the body is
// checked — a Language choice is `auto` or a code the engine itself lists, so the languages the probe reported come
// in with it — then TX2: one attempt per Recording and Language, so a repeat returns the attempt already in flight
// unchanged. A terminal attempt holds nothing (TX3): asking again makes a new one, and only the caller's ids tell
// them apart.
// The queue's cap on live rows (TX5): one class on one machine, and a client looping languages or ids must not
// fill the store with rows the engine would reach only after hours. A repeat of a row already in flight never
// counts and never pays it (TX2); a terminal row holds no slot (TX3).
export const TRANSCRIPTION_QUEUE_CAP = 100;

export function requestTranscription(
  existing: readonly Transcription[],
  body: TranscriptionBody,
  at: number,
  capability: TranscriptionCapability,
  languages: "multi" | readonly string[],
  queueCap: number = TRANSCRIPTION_QUEUE_CAP,
): Result<Transcription, TranscriptionRequestProblem> {
  if (!capabilityReady(capability)) return err("no_capability");
  // The pattern is for strings only: `test` would read a missing id as "undefined" and a number as its digits, and
  // a row keyed by such an id would answer for every other (TX5's queue is keyed by id).
  if (typeof body.id !== "string" || !TRANSCRIPTION_ID.test(body.id)) return err("bad_id");
  const recording = body.recording;
  if (!recording || (recording.kind !== "upload" && recording.kind !== "attachment")
    || typeof recording.id !== "string" || !TRANSCRIPTION_ID.test(recording.id)) {
    return err("bad_recording");
  }
  if (typeof body.language !== "string" || !LANGUAGE_CHOICE.test(body.language)) return err("bad_language");
  // A code that is well-shaped but not on the engine's list would only fail inside the run: refuse it here, where
  // the answer is a body problem and not an engine one. `auto` asks the engine to choose, so every engine takes it.
  if (body.language !== "auto" && languages !== "multi" && !languages.includes(body.language)) return err("bad_language");
  if (!Number.isInteger(body.sizeBytes) || body.sizeBytes < 0 || body.sizeBytes > MAX_RECORDING_BYTES) return err("bad_size");
  const inFlight = existing.find(row => sameRecording(row.recording, recording) && row.language === body.language && open(row.state));
  if (inFlight) return ok(inFlight);
  // TX3: asking again after an end makes a new attempt, and only the caller's ids tell the two apart. An id that
  // names a finished attempt is that attempt again for the same body — the stored row, unchanged, as a Job's
  // accept is (jobs.ts) — and a conflict for a different one. An id may be shared by attempts in flight.
  const held = existing.find(row => row.id === body.id && terminal(row.state));
  if (held) return sameBody(held, body) ? ok(held) : err("id_conflict");
  if (existing.filter(row => open(row.state)).length >= queueCap) return err("too_many");
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

export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) n += utf8Bytes(ch);
  return n;
}

// TX7, TextEdited (3.5): the engine's words are never overwritten. An edit is kept beside them, trimmed and within
// the Text cap, and the result is marked `edited`. The Recording stays; the Text grants nothing (TX8).
export type EditProblem = "not_done" | "bad_text";

export function editText(tx: Transcription, text: string): Result<Transcription, EditProblem> {
  if (tx.state !== "done" || tx.text === null) return err("not_done");
  const clean = text.trim();
  if (clean === "" || utf8ByteLength(clean) > MAX_TEXT_BYTES) return err("bad_text");
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

// The key that tells two rows apart wherever rows are held together, as the queue asks (queue.ts). An endpoint,
// a Recording and a Language name one attempt (TX2). Another endpoint's row is a different attempt, even on the
// same clip. An id does not: an agent's attachment and the principal's upload may share one and still be two rows.
// `|` is not part of an id, so the four parts stay four.
const rowKey = (tx: Transcription): string => {
  const owner = "endpointId" in tx && typeof tx.endpointId === "string" ? tx.endpointId : "";
  return `${owner}|${tx.recording.kind}|${tx.recording.id}|${tx.language}`;
};

export function scheduleTranscriptions(rows: readonly Transcription[], limit: number, guard: QueueGuard): Transcription[] {
  const queued = rows.filter(tx => tx.state === "queued");
  const running = rows.filter(tx => tx.state === "starting" || tx.state === "running").length;
  const slots = queueDecision(queued.map(tx => ({ key: rowKey(tx), acceptedAt: tx.acceptedAt })), running, limit, guard);
  return rows.map(tx => {
    // TX3: a slot is for a waiting row only, as Jobs' schedule is. A finished row keeps its end whatever its id,
    // so a queued row that shares a finished row's id can never bring it back to life.
    if (tx.state !== "queued") return tx;
    const slot = slots.get(rowKey(tx));
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
