// The ApplyingMarker adapter's contract (design §5): one file, <state>/applying, whose presence is what the
// recovery unit runs on (§5: it runs only while the mark exists) — present from the drain until the Update ends,
// private to its owner, and written atomically like every state the updater owns, so a machine that looks for it
// never sees half of one and a write that cannot land leaves the mark that is already there.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplyingFileMarker } from "../src/adapters/applying-file.ts";

let scratch = "";

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const marker = (): { path: string; m: ApplyingFileMarker } => {
  const state = mkdtempSync(join(scratch, "state-"));
  return { path: join(state, "applying"), m: new ApplyingFileMarker({ state }) };
};

describe("ApplyingFileMarker (§5)", () => {
  it("is absent until set, and names its update", () => {
    const t = marker();
    expect(t.m.present()).toBe(false);
    t.m.set("upd-1");
    expect(t.m.present()).toBe(true);
    expect(readFileSync(t.path, "utf8")).toBe("upd-1\n");
  });

  it("clear() removes the mark, and clearing nothing is fine", () => {
    const t = marker();
    t.m.clear();
    expect(t.m.present()).toBe(false);
    t.m.set("upd-1");
    t.m.clear();
    expect(t.m.present()).toBe(false);
  });

  it("the mark is private to its owner (0600)", () => {
    const t = marker();
    t.m.set("upd-1");
    expect((statSync(t.path).mode & 0o777).toString(8)).toBe("600");
  });

  it("a write that cannot land leaves the mark that is already there (atomic: temp, rename)", () => {
    const t = marker();
    t.m.set("upd-1");
    mkdirSync(`${t.path}.tmp`);                          // a directory where the temp file goes: the rename cannot run
    expect(() => t.m.set("upd-2")).toThrow();
    expect(t.m.present()).toBe(true);
    expect(readFileSync(t.path, "utf8"), "the first mark stands").toBe("upd-1\n");
    rmSync(`${t.path}.tmp`, { recursive: true, force: true });
    t.m.set("upd-2");                                   // and it recovers
    expect(readFileSync(t.path, "utf8")).toBe("upd-2\n");
  });
});
