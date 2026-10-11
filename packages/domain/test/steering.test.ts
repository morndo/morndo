import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, TEXT_MAX_BYTES, UPLOAD_TTL_MS, acceptNamedUpload, acceptUpload, attachable, commandText, endpointId, sniffImage, type Upload } from "../src/index.ts";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
const T0 = Date.UTC(2026, 9, 1, 12);
const up = (id: string, over: Partial<Upload> = {}): Upload => ({ id, endpointId: endpointId("ep1"), path: `/inbox/${id}.png`, mime: "image/png", size: 10, at: T0, ...over });

describe("S1: an upload is an image by its own bytes", () => {
  it("knows PNG, JPEG, GIF and WebP", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif");
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp");
  });
  it("refuses SVG, HTML, PDF, a ZIP, RIFF that isn't WebP, and anything too big (negative controls)", () => {
    for (const text of ["<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>", "<!doctype html>", "%PDF-1.4"]) expect(sniffImage(new TextEncoder().encode(text))).toBeNull();
    expect(sniffImage(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(acceptUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1))).toEqual({ ok: false, error: "too_big" });
    expect(acceptUpload(new TextEncoder().encode("hello"))).toEqual({ ok: false, error: "not_an_image" });
  });
});

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const text = (s: string) => new TextEncoder().encode(s);

describe("S1: a named upload is allowed only when its extension and its bytes agree", () => {
  it("accepts markdown, text, json, csv, yaml, yml and a log when they are UTF-8", () => {
    expect(acceptNamedUpload(text("# Notes\n"), "notes.md")).toEqual({ ok: true, value: { kind: "text", mime: "text/markdown", name: "notes.md" } });
    expect(acceptNamedUpload(text("hello"), "plain.txt")).toEqual({ ok: true, value: { kind: "text", mime: "text/plain", name: "plain.txt" } });
    expect(acceptNamedUpload(text("{\"a\":1}\n"), "data.json")).toEqual({ ok: true, value: { kind: "text", mime: "application/json", name: "data.json" } });
    expect(acceptNamedUpload(text("a,b\n1,2\n"), "rows.csv")).toEqual({ ok: true, value: { kind: "text", mime: "text/csv", name: "rows.csv" } });
    expect(acceptNamedUpload(text("a: 1\n"), "cfg.yaml")).toEqual({ ok: true, value: { kind: "text", mime: "application/yaml", name: "cfg.yaml" } });
    expect(acceptNamedUpload(text("a: 1\n"), "cfg.yml")).toEqual({ ok: true, value: { kind: "text", mime: "application/yaml", name: "cfg.yml" } });
    expect(acceptNamedUpload(text("line\n"), "run.log")).toEqual({ ok: true, value: { kind: "text", mime: "text/plain", name: "run.log" } });
  });
  it("accepts a PDF by its magic bytes and an image only when the extension matches the bytes", () => {
    expect(acceptNamedUpload(text("%PDF-1.7\n"), "spec.pdf")).toEqual({ ok: true, value: { kind: "pdf", mime: "application/pdf", name: "spec.pdf" } });
    expect(acceptNamedUpload(png(), "shot.png").ok && acceptNamedUpload(png(), "shot.png").value).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png" });
    expect(acceptNamedUpload(jpeg(), "photo.jpg")).toMatchObject({ ok: true, value: { kind: "image", mime: "image/jpeg" } });
    expect(acceptNamedUpload(jpeg(), "photo.jpeg")).toMatchObject({ ok: true, value: { mime: "image/jpeg" } });
  });
  it("keeps a safe file name and drops a path", () => {
    expect(acceptNamedUpload(text("hi\n"), "../../My Notes.md")).toMatchObject({ ok: true, value: { name: "My_Notes.md" } });
    expect(acceptNamedUpload(text("hi\n"), ".hidden.md")).toMatchObject({ ok: true, value: { name: "hidden.md" } });
  });
  it("refuses executables, archives, HTML, SVG, a mismatched type, bad UTF-8, and a file over its limit", () => {
    expect(acceptNamedUpload(text("MZ"), "run.exe")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), "a.zip")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(text("<!doctype html><script>"), "page.html")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(text("<svg xmlns='http://www.w3.org/2000/svg'/>"), "pic.svg")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(text("<svg xmlns='http://www.w3.org/2000/svg'/>"), "notes.md")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(png(), "notes.md")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(jpeg(), "shot.png")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(text("not a pdf"), "spec.pdf")).toEqual({ ok: false, error: "not_allowed" });
    expect(acceptNamedUpload(new Uint8Array([0xff, 0xfe, 0x61]), "notes.md")).toEqual({ ok: false, error: "not_utf8" });
    expect(acceptNamedUpload(new Uint8Array(TEXT_MAX_BYTES + 1), "notes.md")).toEqual({ ok: false, error: "too_big" });
    expect(acceptNamedUpload(new Uint8Array(MAX_UPLOAD_BYTES + 1), "spec.pdf")).toEqual({ ok: false, error: "too_big" });
    expect(acceptNamedUpload(text("hi"), "")).toEqual({ ok: false, error: "not_allowed" });
  });
});

describe("S2: a Command attaches only its own Endpoint's uploads, within a day, at most six", () => {
  const known = new Map([["a", up("a")], ["b", up("b")], ["theirs", up("theirs", { endpointId: endpointId("ep2") })]]);
  const find = (id: string) => known.get(id);
  it("takes its own uploads once each", () => {
    const r = attachable(["a", "b", "a"], find, endpointId("ep1"), T0 + 1000);
    expect(r.ok && r.value.map(u => u.id)).toEqual(["a", "b"]);
  });
  it("refuses another device's upload, an unknown one, an expired one, and more than six", () => {
    expect(attachable(["theirs"], find, endpointId("ep1"), T0)).toEqual({ ok: false, error: "not_yours" });
    expect(attachable(["nope"], find, endpointId("ep1"), T0)).toEqual({ ok: false, error: "unknown_upload" });
    expect(attachable(["a"], find, endpointId("ep1"), T0 + UPLOAD_TTL_MS)).toEqual({ ok: false, error: "expired" });
    expect(attachable(["a"], find, endpointId("ep1"), T0 + UPLOAD_TTL_MS - 1).ok).toBe(true);
    expect(attachable(["1", "2", "3", "4", "5", "6", "7"], () => up("x"), endpointId("ep1"), T0)).toEqual({ ok: false, error: "too_many" });
  });
});

describe("S3: the notes follow the principal's text", () => {
  it("text, a blank line, one note per image; only notes when there is no text", () => {
    expect(commandText(" look at this ", ["[note a]", "[note b]"])).toBe("look at this\n\n[note a]\n[note b]");
    expect(commandText("", ["[note a]"])).toBe("[note a]");
    expect(commandText("just text", [])).toBe("just text");
  });
});
