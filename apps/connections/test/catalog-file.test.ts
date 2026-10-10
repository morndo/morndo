import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogRefused, FileCatalog } from "../src/adapters/catalog-file.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("catalog file", () => {
  it("loads the shipped catalog and refuses a file that is not one", () => {
    expect(new FileCatalog(catalog).presets().some(preset => preset.id === "anthropic")).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "morndo-catalog-"));
    dirs.push(dir);
    const bad = join(dir, "vendors.json");
    writeFileSync(bad, JSON.stringify({ id: "nope" }));
    expect(() => new FileCatalog(bad)).toThrow(CatalogRefused);
  });
});
