// The attach loop checks the name and the size, and reserves a slot, before it reads a file.
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, TEXT_MAX_BYTES } from "@morndo/domain";
import { beginAttachments, fileType, refusalMessage } from "../src/lib/attach.ts";

const file = (name: string, size: number): File => ({ name, size, arrayBuffer: async () => { throw new Error("read"); } }) as unknown as File;

describe("beginAttachments", () => {
  it("refuses an executable and an oversized text file without reading them", () => {
    const { taken, note } = beginAttachments(0, [file("clip.mov", 3 * 1024 * 1024 * 1024), file("big.md", TEXT_MAX_BYTES + 1)]);
    expect(taken).toEqual([]);
    expect(note).toMatch(/clip\.mov can't be attached/);
  });

  it("reserves only the room left under six", () => {
    const many = Array.from({ length: 7 }, (_, i) => file(`n${i}.md`, 4));
    const first = beginAttachments(0, many);
    expect(first.taken).toHaveLength(6);
    expect(first.note).toMatch(/At most 6/);
    expect(first.taken.every(t => t.row.status === "uploading")).toBe(true);
    const second = beginAttachments(first.taken.length, [file("extra.md", 4)]);
    expect(second.taken).toHaveLength(0);
    expect(second.note).toMatch(/At most 6/);
  });
});

describe("an HTML page in the composer", () => {
  it("is taken as a page up to 10 MB, shown as HTML", () => {
    const { taken, note } = beginAttachments(0, [file("report.html", 2 * 1024 * 1024), file("old.htm", 10)]);
    expect(note).toBeNull();
    expect(taken.map(t => [t.row.name, t.row.kind])).toEqual([["report.html", "html"], ["old.htm", "html"]]);
    expect(fileType("report.html", "html")).toBe("HTML");
  });

  it("is refused over 10 MB, in words that say so", () => {
    const { taken, note } = beginAttachments(0, [file("huge.html", MAX_UPLOAD_BYTES + 1)]);
    expect(taken).toEqual([]);
    expect(note).toBe("huge.html is over 10 MB.");
  });

  it("is named in the list of what can be attached", () => {
    expect(refusalMessage("run.exe", "not_allowed")).toMatch(/an HTML page/);
    expect(refusalMessage("pic.svg", "not_allowed")).toMatch(/^pic\.svg can't be attached/);
  });
});
