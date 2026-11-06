// The readers the tests share for a fake box's files: a line counts once its newline is there.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonLines, readSubmitted, wholeLines } from "./whole-lines.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-lines-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("wholeLines", () => {
  it("returns the lines that end in a newline and leaves a last line without one", () => {
    expect(wholeLines("")).toEqual([]);
    expect(wholeLines('"a"')).toEqual([]);
    expect(wholeLines('"a"\n')).toEqual(['"a"']);
    expect(wholeLines('"a"\n\n"b"\n"c')).toEqual(['"a"', '"b"']);       // an empty line is skipped
  });
});

describe("readJsonLines", () => {
  it("is empty without a file, and parses the whole lines and not the start of the last one", () => {
    const file = join(tempDir(), "t.jsonl");
    expect(readJsonLines(file)).toEqual([]);
    writeFileSync(file, '{"a":1}\n{"b":');
    expect(readJsonLines(file)).toEqual([{ a: 1 }]);                     // a plain split and parse threw on the half line
    appendFileSync(file, "2}\n");
    expect(readJsonLines(file)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("readSubmitted", () => {
  it("gives the strings the box in a directory has had submitted, whole lines only", () => {
    const dir = tempDir();
    expect(readSubmitted(dir)).toEqual([]);
    const file = join(dir, "submitted.jsonl");
    writeFileSync(file, `${JSON.stringify("one")}\n${JSON.stringify("two").slice(0, 3)}`);
    expect(readSubmitted(dir)).toEqual(["one"]);
    appendFileSync(file, `${JSON.stringify("two").slice(3)}\n`);
    expect(readSubmitted(dir)).toEqual(["one", "two"]);
  });
});
