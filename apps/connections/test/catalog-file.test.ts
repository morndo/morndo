import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelClassOf } from "@morndo/domain";
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

  it("classes the glm models as the design's table states", () => {
    const zai = new FileCatalog(catalog).presets().find(preset => preset.id === "zai");
    expect(zai?.class).toBeDefined();
    if (!zai?.class) return;
    expect(modelClassOf("glm-5.3", zai.class)).toBe("flagship");
    expect(modelClassOf("glm-5.3-flash", zai.class)).toBe("fast");
  });
});
