// The build's own checks (ADR-0008 phase G): the gallery's absence and the bundle budget, on made-up builds.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GALLERY_MARKER, entryFiles, galleryTraces, measure, overBudget, verdict } from "../scripts/check-build.ts";

let build: string;
beforeEach(() => {
  build = mkdtempSync(join(tmpdir(), "morndo-build-check-"));
  mkdirSync(join(build, "_app/immutable/entry"), { recursive: true });
  mkdirSync(join(build, "_app/immutable/nodes"), { recursive: true });
});
afterEach(() => rmSync(build, { recursive: true, force: true }));

const html = (...js: string[]) => `<head>\n${js.map(f => `<link href="/${f}" rel="modulepreload">`).join("\n\t\t")}\n<link href="/_app/immutable/assets/0.css" rel="stylesheet"></head>`;

describe("the dev-only gallery", () => {
  it("finds its marker in any built file, and nothing in a build without it", () => {
    writeFileSync(join(build, "_app/immutable/entry/app.js"), "export const a = 1;");
    expect(galleryTraces(build)).toEqual([]);
    writeFileSync(join(build, "_app/immutable/nodes/7.js"), `const x = "<div data-${GALLERY_MARKER}>";`);
    expect(galleryTraces(build)).toEqual(["_app/immutable/nodes/7.js"]);
  });
});

describe("the bundle budget", () => {
  it("the entry is the JS 200.html preloads, not its stylesheets or other routes", () => {
    expect(entryFiles(html("_app/immutable/entry/start.A.js", "_app/immutable/chunks/B.js"))).toEqual(["_app/immutable/entry/start.A.js", "_app/immutable/chunks/B.js"]);
    writeFileSync(join(build, "200.html"), html("_app/immutable/entry/start.A.js"));
    const body = "export const s = 'start';".repeat(40);
    writeFileSync(join(build, "_app/immutable/entry/start.A.js"), body);
    writeFileSync(join(build, "_app/immutable/nodes/2.js"), "export const page = 'a route, loaded later';");
    const m = measure(build);
    expect(m.entry).toEqual(["_app/immutable/entry/start.A.js"]);
    expect(m.entryGzipBytes).toBe(gzipSync(body, { level: 9 }).length);
    expect(m.allJs).toBe(2);
  });
  it("a build whose page preloads nothing can't be measured", () => {
    writeFileSync(join(build, "200.html"), "<head></head>");
    expect(() => measure(build)).toThrow(/preloads no JS/);
  });
  it("up to 15% more passes; beyond it fails", () => {
    expect(overBudget(1150, 1000)).toBe(false);
    expect(overBudget(1151, 1000)).toBe(true);
    expect(overBudget(900, 1000)).toBe(false);
  });
  it("a baseline that is missing or not a size fails, never compares as NaN and passes", () => {
    expect(verdict(1000, 1000)).toBe("within");
    expect(verdict(1151, 1000)).toBe("over");
    for (const b of [undefined, null, 0, -5, Number.NaN, "1000"]) expect(verdict(1000, b)).toBe("no_baseline");
  });
});
