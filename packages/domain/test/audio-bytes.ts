// Made-up container bytes for the duration parser's tests: the smallest headers that carry a duration, nothing
// real recorded. Each builder writes only what the parser reads.

const u32be = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
const u64le = (n: number) => [...u32le(n % 4_294_967_296), ...u32le(Math.floor(n / 4_294_967_296))];

export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// A PCM wav at 8000 Hz, one channel, one byte per sample: `ms` milliseconds of audio.
export function wavBytes(ms: number): Uint8Array {
  const data = Math.round(ms);                                     // byteRate 8000: 8 bytes a millisecond
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, ...u32le(36 + data), 0x57, 0x41, 0x56, 0x45,    // RIFF <size> WAVE
    0x66, 0x6d, 0x74, 0x20, ...u32le(16), 1, 0, 1, 0,                      // fmt  16  PCM mono
    ...u32le(8000), ...u32le(8000), 1, 0, 8, 0,                             // rate, byteRate, align, bits
    0x64, 0x61, 0x74, 0x61, ...u32le(data),                                // data <bytes>
  ]);
}

const box = (type: string, body: number[]) => new Uint8Array([...u32be(8 + body.length), ...[...type].map(c => c.charCodeAt(0)), ...body]);

// An mvhd of version 0: timescale and duration where the parser reads them (ISO/IEC 14496-12).
const mvhd = (timescale: number, duration: number) =>
  box("mvhd", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32be(timescale), ...u32be(duration), 0, 0, 0, 0, 0, 0, 0, 0]);

// An m4a: the ftyp the S1 gate accepts, then moov/mvhd. `moovLast` leaves moov out, for the tail.
export function mp4Bytes(timescale: number, duration: number, moovLast = false): { head: Uint8Array; moov: Uint8Array } {
  const ftyp = box("ftyp", [0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]);           // M4A␣, minor 0
  const moov = box("moov", [...mvhd(timescale, duration)]);
  return { head: moovLast ? ftyp : concat(ftyp, moov), moov };
}

// An ID3v2 tag of `tag` padding bytes, then an MPEG-1 Layer III frame header: 128 kbit/s at the given rate.
export function mp3Bytes(tag: number, rate: "44100" | "48000", xing?: { frames: number }): Uint8Array {
  const header = new Uint8Array([0xff, 0xfb, rate === "44100" ? 0x90 : 0x94, 0x00]);
  const id3 = new Uint8Array([
    0x49, 0x44, 0x33, 3, 0, 0,                                             // ID3v2.3, no flags
    (tag >> 21) & 0x7f, (tag >> 14) & 0x7f, (tag >> 7) & 0x7f, tag & 0x7f,  // sync-safe size
    ...new Array<number>(tag).fill(0),
  ]);
  if (!xing) return concat(id3, header);
  const body = new Uint8Array([...new TextEncoder().encode("Xing"), ...u32be(1), ...u32be(xing.frames), ...new Array<number>(96).fill(0)]);
  return concat(id3, header, body);
}

// An Ogg page: only version, type, the granule position and a one-segment payload matter to the parser.
const oggPage = (type: number, granule: number, payload: Uint8Array) =>
  new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, type, ...u64le(granule), 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, payload.length, ...payload]);

// An Opus stream: OpusHead in the first page (granule is always 48 kHz; RFC 7845), and the last page's position.
export const opusBytes = (ms: number) => {
  const head = oggPage(2, 0, new Uint8Array([0x7f, ...new TextEncoder().encode("OpusHead"), 1, 1, 0, 0, ...u32le(48_000), 0, 0, 0, 0]));
  return { head, tail: oggPage(4, Math.round(48_000 * ms / 1000), new Uint8Array([0x7f])) };
};

// A Vorbis stream: the identification header carries its own sample rate, at payload offset 12.
export const vorbisBytes = (ms: number, rate: number) => {
  const body = new Uint8Array([1, ...new TextEncoder().encode("vorbis"), 0, 0, 0, 0, 1, ...u32le(rate), 0, 0, 0, 0, 0, 0]);
  const head = oggPage(2, 0, body);
  return { head, tail: oggPage(4, Math.round(rate * ms / 1000), new Uint8Array([1])) };
};

const f64be = (n: number) => { const b = new ArrayBuffer(8); new DataView(b).setFloat64(0, n); return [...new Uint8Array(b)]; };

// A webm: EBML header, a streamed Segment (unknown size), and an Info with TimecodeScale 1 ms and the duration.
export function webmBytes(ms: number): Uint8Array {
  const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
  const scale = new Uint8Array([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);            // TimecodeScale 1e6 ns
  const duration = new Uint8Array([0x44, 0x89, 0x88, ...f64be(ms)]);                    // Duration, float64
  const info = new Uint8Array([0x15, 0x49, 0xa9, 0x66, 0x80 | scale.length + duration.length, ...scale, ...duration]);
  const segment = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, ...info]);
  return concat(ebml, segment);
}
