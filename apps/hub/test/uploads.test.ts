// The upload inbox on a temporary directory: what is saved, where, how, and what a photo or a recording loses on
// the way.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audioDurationMs, endpointId } from "@morndo/domain";
import { webmBytes } from "../../../packages/domain/test/audio-bytes.ts";
import { stripMetadata, uploadInbox } from "../src/adapters/uploads.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-inbox-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);   // CRC not checked here
};
const png = (...extra: Buffer[]) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), ...extra,
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 128, 0]))), chunk("IEND", Buffer.alloc(0)),
]);
const pngChunks = (b: Uint8Array) => { const out: string[] = []; let i = 8; while (i + 12 <= b.length) { const n = Buffer.from(b).readUInt32BE(i); out.push(Buffer.from(b.subarray(i + 4, i + 8)).toString("latin1")); i += 12 + n; } return out; };
const seg = (marker: number, payload: string) => { const p = Buffer.from(payload, "latin1"); const h = Buffer.from([0xff, marker, 0, 0]); h.writeUInt16BE(p.length + 2, 2); return Buffer.concat([h, p]); };

describe("metadata a photo carries", () => {
  it("PNG: text, time and EXIF chunks go; the image chunks stay in order", () => {
    const b = png(chunk("tEXt", Buffer.from("Author\0me")), chunk("eXIf", Buffer.from("gps")), chunk("tIME", Buffer.alloc(7)));
    expect(pngChunks(stripMetadata(b, "image/png"))).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it("JPEG: EXIF/XMP (APP1), IPTC (APP13) and comments go; JFIF, tables and the scan stay", () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF\0\x01\x01"), seg(0xe1, "Exif\0\0GPSLatitude 52.5"), seg(0xed, "Photoshop 3.0"),
      seg(0xfe, "shot on my phone"), seg(0xdb, "quant"), Buffer.from([0xff, 0xda, 0, 2]), Buffer.from("scan-data"), Buffer.from([0xff, 0xd9])]);
    const out = Buffer.from(stripMetadata(b, "image/jpeg")).toString("latin1");
    expect(out).not.toMatch(/Exif|GPS|Photoshop|my phone/);
    expect(out).toMatch(/JFIF/);
    expect(out).toMatch(/quant/);
    expect(out.endsWith("scan-data\xff\xd9")).toBe(true);
  });
});

describe("metadata a recording carries", () => {
  const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64le = (n: number) => Buffer.concat([u32le(n % 2 ** 32), u32le(Math.floor(n / 2 ** 32))]);
  const mp4Box = (type: string, ...body: Buffer[]) =>
    Buffer.concat([u32be(8 + body.reduce((n, p) => n + p.length, 0)), Buffer.from(type, "latin1"), ...body]);
  // An m4a the way a recorder writes one: moov with mvhd and a udta holding the iOS location atom and a title.
  const m4aMemo = () => Buffer.concat([
    mp4Box("ftyp", Buffer.from("M4A ", "latin1")),
    mp4Box("moov", mp4Box("mvhd", Buffer.alloc(24, 1)),
      mp4Box("udta", mp4Box("©xyz", Buffer.from("52.5200;13.4050", "latin1")), mp4Box("©nam", Buffer.from("memo at home", "latin1")))),
    mp4Box("mdat", Buffer.from("the audio itself", "latin1")),
  ]);
  const syncsafe = (n: number) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
  const mp3Memo = () => {
    const frame = Buffer.concat([Buffer.from("TIT2", "latin1"), u32be(9), Buffer.from([0, 0]), Buffer.from("memo at home", "latin1"), Buffer.from([0])]);
    const tag = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0]), syncsafe(frame.length), frame]);
    const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(500, 1)]);
    return Buffer.concat([tag, audio, Buffer.from("TAG", "latin1"), Buffer.alloc(125)]);   // and an ID3v1 tail
  };
  const wavMemo = () => {
    const fmt = Buffer.concat([Buffer.from("fmt ", "latin1"), u32le(16), Buffer.from([1, 0, 1, 0]), u32le(8000), u32le(8000), Buffer.from([1, 0, 8, 0])]);
    const note = Buffer.concat([Buffer.from("INFO", "latin1"), Buffer.from("ICMT", "latin1"), u32le(9), Buffer.from("at home", "latin1"), Buffer.from([0])]);
    const list = Buffer.concat([Buffer.from("LIST", "latin1"), u32le(note.length), note]);
    const data = Buffer.concat([Buffer.from("data", "latin1"), u32le(8000), Buffer.alloc(8000, 1)]);
    return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(4 + fmt.length + list.length + data.length), Buffer.from("WAVE", "latin1"), fmt, list, data]);
  };
  const oggPage = (type: number, granule: number, payload: Buffer) => Buffer.concat([
    Buffer.from("OggS", "latin1"), Buffer.from([0, type]), u64le(granule), Buffer.alloc(12), Buffer.from([1, payload.length]), payload,
  ]);
  const opusMemo = () => Buffer.concat([
    oggPage(2, 0, Buffer.concat([Buffer.from([0x7f]), Buffer.from("OpusHead", "latin1"), Buffer.alloc(11)])),
    oggPage(0, 0, Buffer.concat([Buffer.from("OpusTags", "latin1"), u32le(8), Buffer.from("libtests", "latin1"), u32le(1), u32le(10), Buffer.from("where=home", "latin1")])),
    oggPage(4, 240_000, Buffer.from([0x7f])),
  ]);
  const webmMemo = () => Buffer.concat([
    webmBytes(7500),
    Buffer.concat([Buffer.from([0x12, 0x54, 0xc3, 0x67, 0x87]), Buffer.from("at home", "latin1")]),
  ]);

  it("m4a: the udta and meta boxes go — a recorder's location and title — and the audio's own boxes stay", () => {
    const out = stripMetadata(m4aMemo(), "mp4");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/xyz|©nam|udta|memo at home/);
    expect(latin).toMatch(/ftyp|moov|mvhd|mdat|the audio itself/);
    expect(audioDurationMs({ head: out, size: out.length })).not.toBeNull();   // still a container the hub reads
  });
  it("mp3: the ID3v2 tag and the ID3v1 tail go; the frames stay", () => {
    const out = stripMetadata(mp3Memo(), "mp3");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/ID3|TIT2|memo at home|TAG/);
    expect(out[0]).toBe(0xff);
    expect(out.length).toBe(504);
  });
  it("wav: LIST INFO chunks go, the walk stays word-aligned and the data chunk keeps its duration", () => {
    const out = stripMetadata(wavMemo(), "wav");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/LIST|ICMT|at home/);
    expect(latin).toMatch(/fmt |data/);
    expect(audioDurationMs({ head: out, size: out.length })).toBe(1000);
  });
  it("ogg: a comment header page is blanked in place, framing and checksum intact, the audio pages untouched", () => {
    // CRC-32/MPEG-2 (Ogg's, RFC 3533 §5): check value for the nine digits is 0x0376e6e7.
    const table: number[] = [];
    for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; table[n] = c >>> 0; }
    const crc32mpeg = (b: Uint8Array, at: number, end: number) => { let c = 0; for (let i = at; i < end; i++) c = (((c << 8) >>> 0) ^ table[((c >>> 24) ^ b[i]!) & 0xff]) >>> 0; return c; };
    expect(crc32mpeg(Buffer.from("123456789"), 0, 9)).toBe(0x0376e6e7);
    const out = stripMetadata(opusMemo(), "ogg");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/OpusTags|libtests|where=home/);
    expect(latin).toMatch(/OpusHead/);
    expect(audioDurationMs({ head: out, size: out.length })).toBe(5000);      // the last page's granule survives
    for (let i = 0; i + 28 <= out.length;) {                                   // every page still checksums
      if (Buffer.from(out.subarray(i, i + 4)).toString("latin1") !== "OggS") throw new Error("page walk lost the framing");
      const nseg = out[i + 26]!;
      let len = 27 + nseg;
      for (let s = 0; s < nseg; s++) len += out[i + 27 + s]!;
      const page = Buffer.from(out.subarray(i, i + len));
      const stored = page.readUInt32LE(22);
      page.writeUInt32LE(0, 22);
      expect(crc32mpeg(page, 0, len)).toBe(stored);
      i += len;
    }
  });
  it("webm: Tags elements go; the Info the duration reader needs stays", () => {
    const out = stripMetadata(webmMemo(), "webm");
    expect(Buffer.from(out).toString("latin1")).not.toMatch(/at home/);
    expect(audioDurationMs({ head: out, size: out.length })).toBe(7500);
  });

  it("the inbox stores an audio upload without its recorder metadata", () => {
    const inbox = uploadInbox({ dir });
    const cap = { present: true as const, maxSeconds: 600 };
    const r = inbox.save(m4aMemo(), endpointId("ep1"), "memo.m4a", cap);
    if (!r.ok) throw new Error(r.error);
    const stored = readFileSync(r.value.path);
    expect(stored.includes(Buffer.from("©xyz", "latin1"))).toBe(false);
    expect(stored.includes(Buffer.from("the audio itself", "latin1"))).toBe(true);
    expect(r.value.mime).toBe("audio/mp4");
    expect(r.value.size).toBe(stored.length);
  });
});

describe("the inbox", () => {
  it("saves an image under its own name, readable by this user only, and remembers who uploaded it", () => {
    const inbox = uploadInbox({ dir, now: () => Date.UTC(2026, 9, 1, 12, 30) });
    const r = inbox.save(png(), endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.path).toMatch(new RegExp(`^${dir}/pasted-20261001-123000-[0-9a-f]{6}\\.png$`));
    expect(statSync(r.value.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.value.path).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(inbox.get(r.value.id)).toMatchObject({ endpointId: "ep1", mime: "image/png" });
  });
  it("refuses what isn't an image, whatever it claims (negative control)", () => {
    const inbox = uploadInbox({ dir });
    expect(inbox.save(Buffer.from("<svg><script>alert(1)</script></svg>"), endpointId("ep1"))).toEqual({ ok: false, error: "not_an_image" });
  });
  it("saves a markdown file under a safe name and refuses an executable, HTML, bad UTF-8, and a text file over 1 MB", () => {
    const inbox = uploadInbox({ dir });
    const md = inbox.save(Buffer.from("# Notes\n"), endpointId("ep1"), "My Notes.md");
    if (!md.ok) throw new Error(md.error);
    expect(md.value.path).toMatch(/My_Notes\.md$/);
    expect(md.value.mime).toBe("text/markdown");
    expect(readFileSync(md.value.path).toString("utf8")).toBe("# Notes\n");
    expect(inbox.save(Buffer.from("MZ"), endpointId("ep1"), "run.exe")).toEqual({ ok: false, error: "not_allowed" });
    expect(inbox.save(Buffer.from("<!doctype html>"), endpointId("ep1"), "page.html")).toEqual({ ok: false, error: "not_allowed" });
    expect(inbox.save(Buffer.from([0xff, 0xfe, 0x61]), endpointId("ep1"), "notes.md")).toEqual({ ok: false, error: "not_utf8" });
    expect(inbox.save(Buffer.alloc(1024 * 1024 + 1), endpointId("ep1"), "big.md")).toEqual({ ok: false, error: "too_big" });
    const pdf = inbox.save(Buffer.from("%PDF-1.7\n"), endpointId("ep1"), "spec.pdf");
    if (!pdf.ok) throw new Error(pdf.error);
    expect(pdf.value.mime).toBe("application/pdf");
    expect(readFileSync(pdf.value.path).subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
  it("removes files after a week", () => {
    let t = Date.now();
    const inbox = uploadInbox({ dir, now: () => t });
    const r = inbox.save(png(), endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    utimesSync(r.value.path, old, old);
    t += 8 * 24 * 3_600_000;
    inbox.sweep();
    expect(existsSync(r.value.path)).toBe(false);
    expect(inbox.get(r.value.id)).toBeUndefined();
  });
});
