// Review F7: what a key pool needs from the catalog is its own file, so a build that came before it, whose strict vendor schema
// refuses a field it does not know, still reads vendors.json. The file sits next to the catalog; without it there are no key pools.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKeyPoolCatalog, VendorCatalog } from "@morndo/protocol";
import { FileCatalog } from "../src/adapters/catalog-file.ts";
import { builtinClassifiers } from "../src/adapters/classifiers.ts";
import { anthropicClassifier } from "../src/adapters/outcome-anthropic.ts";

const dir = join(import.meta.dirname, "../../../packages/protocol/catalog");
const vendors = join(dir, "vendors.json");
const pools = join(dir, "key-pools.json");
const tmp: string[] = [];
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }); });

// The keys a preset had before key pools: the strict schema of the build that is already installed knows exactly these.
const OLDER_PRESET_KEYS = ["balance", "custody", "defaultPicks", "family", "id", "idPatterns", "isolation", "keyShapes", "kinds", "label", "models", "prices", "runtimes", "spend", "terms"];

describe("vendors.json stays readable by the build that came before", () => {
  it("every preset uses only the keys of the older strict schema", () => {
    const presets = JSON.parse(readFileSync(vendors, "utf8")) as Record<string, unknown>[];
    for (const preset of presets) {
      const extra = Object.keys(preset).filter(key => !OLDER_PRESET_KEYS.includes(key));
      expect(extra, String(preset.id)).toEqual([]);
    }
  });
  it("the preset schema has no key-pool field", () => {
    const [first] = JSON.parse(readFileSync(vendors, "utf8")) as Record<string, unknown>[];
    expect(VendorCatalog.safeParse([{ ...first, keyPool: { errorDialect: "x", termsRevision: "r", termsLine: "l" } }]).success).toBe(false);
  });
});

describe("key-pools.json", () => {
  const entries = parseKeyPoolCatalog(JSON.parse(readFileSync(pools, "utf8")));
  it("parses, and only the first-party preset hosts a key pool, with a dated terms revision and a terms line", () => {
    expect(entries?.map(entry => entry.vendor)).toEqual(["anthropic"]);
    const [entry] = entries ?? [];
    expect(entry?.errorDialect).toBe("anthropic");
    expect(entry?.termsRevision).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(entry?.termsLine).toMatch(/spend limit/);
    expect(entry?.termsLine).toMatch(/hold/);
    expect((entry?.termsLine ?? "").length).toBeGreaterThan(100);
  });
  it("names a vendor that has a preset, and a dialect this build can read", () => {
    const presets = VendorCatalog.parse(JSON.parse(readFileSync(vendors, "utf8")));
    for (const entry of entries ?? []) {
      expect(presets.some(preset => preset.id === entry.vendor), entry.vendor).toBe(true);
      expect(builtinClassifiers.for(entry.errorDialect), entry.vendor).not.toBeNull();
    }
    expect(builtinClassifiers.for("anthropic")).toBe(anthropicClassifier);
    expect(builtinClassifiers.for("openai-responses")).toBeNull();
  });
  it("refuses a file with an unknown field, a blank line or a duplicate vendor", () => {
    const one = { vendor: "v", errorDialect: "d", termsRevision: "2026-01-01", termsLine: "a line" };
    expect(parseKeyPoolCatalog([one])).not.toBeNull();
    expect(parseKeyPoolCatalog([{ ...one, extra: 1 }])).toBeNull();
    expect(parseKeyPoolCatalog([{ ...one, termsLine: "" }])).toBeNull();
    expect(parseKeyPoolCatalog([one, one])).toBeNull();
    expect(parseKeyPoolCatalog({ vendor: "v" })).toBeNull();
  });
});

describe("FileCatalog reads it from beside the catalog", () => {
  it("answers for the vendor it lists, and for no other", () => {
    const catalog = new FileCatalog(vendors);
    expect(catalog.keyPool("anthropic")).toMatchObject({ errorDialect: "anthropic" });
    expect(catalog.keyPool("deepseek")).toBeNull();
    expect(catalog.keyPool("nobody")).toBeNull();
  });
  it("has no key pools when the file is not there, or is not a key-pool catalog", () => {
    const d = mkdtempSync(join(tmpdir(), "morndo-kpcat-"));
    tmp.push(d);
    writeFileSync(join(d, "vendors.json"), readFileSync(vendors));
    expect(new FileCatalog(join(d, "vendors.json")).keyPool("anthropic")).toBeNull();
    writeFileSync(join(d, "key-pools.json"), "{ not json");
    expect(new FileCatalog(join(d, "vendors.json")).keyPool("anthropic")).toBeNull();
    writeFileSync(join(d, "key-pools.json"), readFileSync(pools));
    expect(new FileCatalog(join(d, "vendors.json")).keyPool("anthropic")).not.toBeNull();
  });
});
