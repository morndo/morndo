import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, UPLOAD_TTL_MS, acceptUpload, attachable, commandText, endpointId, sniffImage, type Upload } from "../src/index.ts";

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
