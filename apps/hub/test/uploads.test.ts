// The upload inbox on a temporary directory: what is saved, where, how, and what a photo loses on the way.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
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
