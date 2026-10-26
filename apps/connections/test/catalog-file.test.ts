import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelClassOf, ownModelOf } from "@morndo/domain";
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
    const rules = new FileCatalog(catalog).autoRouting("zai");
    expect(rules?.class).toBeDefined();
    if (!rules) return;
    expect(modelClassOf("glm-5.3", rules.class)).toBe("flagship");
    expect(modelClassOf("glm-5.3-flash", rules.class)).toBe("fast");
  });

  it("has auto-routing rules for every preset and none for a name it does not know", () => {
    const file = new FileCatalog(catalog);
    for (const preset of file.presets()) expect(file.autoRouting(preset.id), preset.id).not.toBeNull();
    expect(file.autoRouting("nobody")).toBeNull();
  });

  it("reads a catalog without the sibling file as one with no Auto rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-catalog-"));
    dirs.push(dir);
    writeFileSync(join(dir, "vendors.json"), readFileSync(catalog, "utf8"));
    const file = new FileCatalog(join(dir, "vendors.json"));
    expect(file.presets().length).toBeGreaterThan(0);
    expect(file.autoRouting("zai")).toBeNull();
  });

  it("cursor and cursor-cloud may run only grok- and composer- models", () => {
    const file = new FileCatalog(catalog);
    for (const id of ["cursor", "cursor-cloud"]) {
      const rules = file.autoRouting(id);
      expect(rules, id).not.toBeNull();
      if (!rules) continue;
      expect(ownModelOf("grok-4.7", rules.ownModels), id).toBe(true);
      expect(ownModelOf("composer-2.5", rules.ownModels), id).toBe(true);
      for (const model of ["claude-sonnet-5.5", "claude-opus-5.5", "gpt-6-astra", "auto", "anthropic/claude-sonnet-5.5"]) {
        expect(ownModelOf(model, rules.ownModels), `${id} ${model}`).toBe(false);
      }
      for (const row of [...rules.families, ...rules.class]) expect(row.pattern, `${id} ${row.pattern}`).not.toMatch(/claude-|gpt-/);
    }
  });

  it("every preset whose family is cursor has an ownModels list", () => {
    const file = new FileCatalog(catalog);
    const cursors = file.presets().filter(preset => preset.family === "cursor");
    expect(cursors.length).toBeGreaterThan(0);
    for (const preset of cursors) {
      const rules = file.autoRouting(preset.id);
      expect(rules?.ownModels, preset.id).toBeDefined();
      expect(rules?.ownModels?.length, preset.id).toBeGreaterThan(0);
    }
  });
});
