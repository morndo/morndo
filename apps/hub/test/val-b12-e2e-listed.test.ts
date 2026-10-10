// Review B12: every e2e file runs in `npm run e2e` and in CI (.github/workflows/ci.yml), as all the others do.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const e2e = readdirSync(join(ROOT, "e2e")).filter(f => f.endsWith(".e2e.ts")).sort();
const script = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts.e2e ?? "";
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

describe("B12: e2e files that never run", () => {
  it("each e2e/*.e2e.ts is in `npm run e2e`", () => {
    expect(e2e.filter(f => !script.includes(`e2e/${f}`))).toEqual([]);
  });
  it("each e2e/*.e2e.ts is a CI step", () => {
    expect(e2e.filter(f => !ci.includes(`run: node e2e/${f}`))).toEqual([]);
  });
});
