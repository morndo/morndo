// The upload inbox on a temporary directory: what is saved, where, how, and what a photo or a recording loses on
// the way.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audioDurationMs, endpointId } from "@morndo/domain";
import { webmBytes } from "../../../packages/domain/test/audio-bytes.ts";
import { noteMissingFfmpeg, stripMetadata, uploadInbox } from "../src/adapters/uploads.ts";

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
  it("PNG: text, time and EXIF chunks go; the image chunks stay in order", async () => {
    const b = png(chunk("tEXt", Buffer.from("Author\0me")), chunk("eXIf", Buffer.from("gps")), chunk("tIME", Buffer.alloc(7)));
    expect(pngChunks(await stripMetadata(b, "image/png"))).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it("JPEG: EXIF/XMP (APP1), IPTC (APP13) and comments go; JFIF, tables and the scan stay", async () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, "JFIF\0\x01\x01"), seg(0xe1, "Exif\0\0GPSLatitude 52.5"), seg(0xed, "Photoshop 3.0"),
      seg(0xfe, "shot on my phone"), seg(0xdb, "quant"), Buffer.from([0xff, 0xda, 0, 2]), Buffer.from("scan-data"), Buffer.from([0xff, 0xd9])]);
    const out = Buffer.from(await stripMetadata(b, "image/jpeg")).toString("latin1");
    expect(out).not.toMatch(/Exif|GPS|Photoshop|my phone/);
    expect(out).toMatch(/JFIF/);
    expect(out).toMatch(/quant/);
    expect(out.endsWith("scan-data\xff\xd9")).toBe(true);
  });
});

describe("metadata a recording carries", () => {
  it("logs once at start that container metadata stays when ffmpeg is absent", () => {
    const lines: string[] = [];
    noteMissingFfmpeg(line => lines.push(line), () => true);
    expect(lines).toEqual([]);
    noteMissingFfmpeg(line => lines.push(line), () => false);
    noteMissingFfmpeg(line => lines.push(line), () => false);
    expect(lines).toEqual(["recordings keep their container metadata"]);
  });

  const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64le = (n: number) => Buffer.concat([u32le(n % 2 ** 32), u32le(Math.floor(n / 2 ** 32))]);
  const mp4Box = (type: string, ...body: Buffer[]) =>
    Buffer.concat([u32be(8 + body.reduce((n, p) => n + p.length, 0)), Buffer.from(type, "latin1"), ...body]);
  // An m4a the way a recorder writes one: moov with an mvhd (v0: 4 header bytes, two dates, 1000ths of a second)
  // and a udta holding the iOS location atom and a title.
  const m4aMemo = () => Buffer.concat([
    mp4Box("ftyp", Buffer.from("M4A ", "latin1")),
    mp4Box("moov", mp4Box("mvhd", Buffer.concat([Buffer.alloc(8), u32be(1000), u32be(5000)])),
      mp4Box("udta", mp4Box("©xyz", Buffer.from("52.5200;13.4050", "latin1")), mp4Box("©nam", Buffer.from("memo at home", "latin1")))),
    mp4Box("mdat", Buffer.from("the audio itself", "latin1")),
  ]);
  const syncsafe = (n: number) => Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
  const mp3Memo = () => {
    const frame = Buffer.concat([Buffer.from("TIT2", "latin1"), u32be(9), Buffer.from([0, 0]), Buffer.from("memo at home", "latin1"), Buffer.from([0])]);
    const tag = Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0]), syncsafe(frame.length), frame]);   // ver, rev, flags, size
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
  // A page the way a muxer writes one, checksum and all: the CRC field sits at offset 22 (RFC 3533 §5), computed
  // over the page with its own field zeroed.
  const oggCrc: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; oggCrc[n] = c >>> 0; }
  const crcOf = (b: Buffer) => { let c = 0; for (let i = 0; i < b.length; i++) c = (((c << 8) >>> 0) ^ oggCrc[((c >>> 24) ^ b[i]!) & 0xff]!) >>> 0; return c; };
  const oggPage = (type: number, granule: number, payload: Buffer) => {
    const page = Buffer.concat([
      Buffer.from("OggS", "latin1"), Buffer.from([0, type]), u64le(granule), Buffer.alloc(12), Buffer.from([1, payload.length]), payload,
    ]);
    page.writeUInt32LE(crcOf(page), 22);
    return page;
  };
  const opusMemo = () => Buffer.concat([
    oggPage(2, 0, Buffer.concat([Buffer.from([0x7f]), Buffer.from("OpusHead", "latin1"), Buffer.alloc(11)])),
    oggPage(0, 0, Buffer.concat([Buffer.from("OpusTags", "latin1"), u32le(8), Buffer.from("libtests", "latin1"), u32le(1), u32le(10), Buffer.from("where=home", "latin1")])),
    oggPage(4, 240_000, Buffer.from([0x7f])),
  ]);
  const webmMemo = () => Buffer.concat([
    webmBytes(7500),
    Buffer.concat([Buffer.from([0x12, 0x54, 0xc3, 0x67, 0x87]), Buffer.from("at home", "latin1")]),
  ]);

  it("kills a remux that outlives its timeout and keeps the bytes", async () => {
    const folder = mkdtempSync(join(tmpdir(), "morndo-slow-"));
    const sample = join(folder, "note.m4a");
    const made = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", "-c:a", "aac", sample], { encoding: "utf8" });
    expect(made.status).toBe(0);
    const bytes = readFileSync(sample);
    writeFileSync(join(folder, "ffmpeg"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${folder}:${path ?? ""}`;
    try {
      const started = Date.now();
      const out = await stripMetadata(bytes, "mp4", 200);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(Buffer.compare(Buffer.from(out), bytes)).toBe(0);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("a long m4a still reports its duration after the remux", async () => {
    const folder = mkdtempSync(join(tmpdir(), "morndo-long-"));
    try {
      const file = join(folder, "note.m4a");
      const made = spawnSync("ffmpeg", [
        "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=420",
        "-c:a", "aac", "-b:a", "16k", "-f", "mp4", file,
      ], { encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
      const out = Buffer.from(await stripMetadata(readFileSync(file), "mp4"));
      const headLen = Math.min(out.length, 256 * 1024);
      const tailLen = Math.min(out.length - headLen, 64 * 1024);
      const ms = audioDurationMs({
        head: out.subarray(0, headLen), tail: out.subarray(out.length - tailLen), tailAt: out.length - tailLen, size: out.length,
      });
      expect(ms).toBeGreaterThan(400_000);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("an m4a loses its cover and its chapter titles", async () => {
    const folder = mkdtempSync(join(tmpdir(), "morndo-cover-"));
    try {
      const meta = join(folder, "chapters.txt");
      const file = join(folder, "note.m4a");
      writeFileSync(meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=200\ntitle=Opening at home\n");
      const made = spawnSync("ffmpeg", [
        "-nostdin", "-v", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4",
        "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.4",
        "-i", meta, "-map_metadata", "2", "-map", "0:a", "-map", "1:v",
        "-c:a", "aac", "-c:v", "mjpeg", "-disposition:v", "attached_pic", "-f", "mp4", file,
      ], { encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
      const raw = readFileSync(file);
      expect(raw.includes("Opening at home")).toBe(true);
      const out = Buffer.from(await stripMetadata(raw, "mp4"));
      expect(out.includes("Opening at home")).toBe(false);
      const probed = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:chapter=id", "-of", "csv=p=0", "-i", file], { encoding: "utf8" });
      expect(probed.stdout).toContain("video");
      const kept = join(folder, "kept.m4a");
      writeFileSync(kept, out);
      const after = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:chapter=id", "-of", "csv=p=0", "-i", kept], { encoding: "utf8" });
      expect(after.status).toBe(0);
      expect(after.stdout.trim()).toBe("audio");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("mp4, ogg and webm that are not a real container stay byte for byte", async () => {
    // ffmpeg cannot remux these hand-built boxes, and a hand edit of their sizes would corrupt a real file.
    for (const [bytes, mime] of [[m4aMemo(), "mp4"], [opusMemo(), "ogg"], [webmMemo(), "webm"]] as const) {
      expect(Buffer.compare(Buffer.from(await stripMetadata(bytes, mime)), bytes)).toBe(0);
    }
  });
  it("mp3: the ID3v2 tag and the ID3v1 tail go; the frames stay", async () => {
    const out = await stripMetadata(mp3Memo(), "mp3");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/ID3|TIT2|memo at home|TAG/);
    expect(out[0]).toBe(0xff);
    expect(out.length).toBe(504);
  });
  it("wav: LIST INFO chunks go, the RIFF size matches the shorter file, and the data chunk keeps its duration", async () => {
    const out = await stripMetadata(wavMemo(), "wav");
    const latin = Buffer.from(out).toString("latin1");
    expect(latin).not.toMatch(/LIST|ICMT|at home/);
    expect(latin).toMatch(/fmt |data/);
    expect(Buffer.from(out).readUInt32LE(4)).toBe(out.length - 8);
    expect(audioDurationMs({ head: out, size: out.length })).toBe(1000);
  });
  it("mp3: a tag that does not leave a frame sync stays unchanged", async () => {
    const junk = Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 4]), Buffer.from("junk")]);
    expect(Buffer.compare(Buffer.from(await stripMetadata(junk, "mp3")), junk)).toBe(0);
  });
  it("the inbox stores a wav without its LIST chunk and with a RIFF size that matches", async () => {
    const inbox = uploadInbox({ dir });
    const cap = { present: true as const, maxSeconds: 600 };
    const r = await inbox.save(wavMemo(), endpointId("ep1"), "memo.wav", cap);
    if (!r.ok) throw new Error(r.error);
    const stored = readFileSync(r.value.path);
    expect(stored.includes(Buffer.from("at home", "latin1"))).toBe(false);
    expect(stored.includes(Buffer.from("data", "latin1"))).toBe(true);
    expect(stored.readUInt32LE(4)).toBe(stored.length - 8);
    expect(r.value.mime).toBe("audio/wav");
    expect(r.value.size).toBe(stored.length);
  });
});

const ffmpegOk = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;

function generatedAudio(ext: string, codec: string[]): Buffer {
  const folder = mkdtempSync(join(tmpdir(), "morndo-gen-"));
  try {
    const file = join(folder, `tone.${ext}`);
    const run = spawnSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
      ...codec, "-metadata", "title=memo at home", file,
    ], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(run.stderr || "ffmpeg could not write a sample");
    return readFileSync(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function decodes(bytes: Uint8Array, ext: string): boolean {
  const folder = mkdtempSync(join(tmpdir(), "morndo-dec-"));
  try {
    const file = join(folder, `tone.${ext}`);
    writeFileSync(file, bytes);
    return spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" }).status === 0;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe.skipIf(!ffmpegOk)("a stripped recording still decodes", () => {
  const samples = [
    ["m4a", "mp4", ["-c:a", "aac", "-movflags", "+faststart"]],
    ["ogg", "ogg", ["-c:a", "libvorbis"]],
    ["webm", "webm", ["-c:a", "libopus"]],
    ["wav", "wav", ["-c:a", "pcm_s16le"]],
    ["mp3", "mp3", ["-c:a", "libmp3lame", "-write_id3v1", "1"]],
  ] as const;
  for (const [ext, mime, codec] of samples) {
    it(`${ext}: the title is gone and ffmpeg decodes the stored bytes`, async () => {
      const raw = generatedAudio(ext, [...codec]);
      expect(raw.includes("memo at home")).toBe(true);
      const out = Buffer.from(await stripMetadata(raw, mime));
      expect(out.includes("memo at home")).toBe(false);
      expect(decodes(out, ext)).toBe(true);
    });
  }
});

describe("the inbox", () => {
  it("saves an image under its own name, readable by this user only, and remembers who uploaded it", async () => {
    const inbox = uploadInbox({ dir, now: () => Date.UTC(2026, 9, 1, 12, 30) });
    const r = await inbox.save(png(), endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    expect(r.value.path).toMatch(new RegExp(`^${dir}/pasted-20261001-123000-[0-9a-f]{6}\\.png$`));
    expect(statSync(r.value.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.value.path).subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(inbox.get(r.value.id)).toMatchObject({ endpointId: "ep1", mime: "image/png" });
  });
  it("refuses what isn't an image, whatever it claims (negative control)", async () => {
    const inbox = uploadInbox({ dir });
    expect(await inbox.save(Buffer.from("<svg><script>alert(1)</script></svg>"), endpointId("ep1"))).toEqual({ ok: false, error: "not_an_image" });
  });
  it("saves a markdown file under a safe name and refuses an executable, HTML, bad UTF-8, and a text file over 1 MB", async () => {
    const inbox = uploadInbox({ dir });
    const md = await inbox.save(Buffer.from("# Notes\n"), endpointId("ep1"), "My Notes.md");
    if (!md.ok) throw new Error(md.error);
    expect(md.value.path).toMatch(/My_Notes\.md$/);
    expect(md.value.mime).toBe("text/markdown");
    expect(readFileSync(md.value.path).toString("utf8")).toBe("# Notes\n");
    expect(await inbox.save(Buffer.from("MZ"), endpointId("ep1"), "run.exe")).toEqual({ ok: false, error: "not_allowed" });
    expect(await inbox.save(Buffer.from("<!doctype html>"), endpointId("ep1"), "page.html")).toEqual({ ok: false, error: "not_allowed" });
    expect(await inbox.save(Buffer.from([0xff, 0xfe, 0x61]), endpointId("ep1"), "notes.md")).toEqual({ ok: false, error: "not_utf8" });
    expect(await inbox.save(Buffer.alloc(1024 * 1024 + 1), endpointId("ep1"), "big.md")).toEqual({ ok: false, error: "too_big" });
    const pdf = await inbox.save(Buffer.from("%PDF-1.7\n"), endpointId("ep1"), "spec.pdf");
    if (!pdf.ok) throw new Error(pdf.error);
    expect(pdf.value.mime).toBe("application/pdf");
    expect(readFileSync(pdf.value.path).subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
  it("removes files after a week", async () => {
    let t = Date.now();
    const inbox = uploadInbox({ dir, now: () => t });
    const r = await inbox.save(png(), endpointId("ep1"));
    if (!r.ok) throw new Error(r.error);
    const old = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    utimesSync(r.value.path, old, old);
    t += 8 * 24 * 3_600_000;
    inbox.sweep();
    expect(existsSync(r.value.path)).toBe(false);
    expect(inbox.get(r.value.id)).toBeUndefined();
  });
});
