// Vendors are data (ADR-0018 §4). Preset ids and labels from the catalog must not appear in the domain sources.
// Token shapes are data too (ADR-0022, design §14 test 4): a shape's id, label and vendor must not appear there either.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const CATALOG = join(ROOT, "packages/protocol/catalog/vendors.json");
const SHAPES = join(ROOT, "packages/protocol/catalog/secret-shapes.json");

type Preset = { id: string; label: string };

export function vendorNames(presets: readonly Preset[]): string[] {
  return [...new Set(presets.flatMap(p => [p.id, p.label]))];
}

export function vendorHits(code: string, names: readonly string[]): string[] {
  return names.filter(name => code.includes(name));
}

function sources(): string[] {
  const files = [
    join(ROOT, "packages/domain/src/connections.ts"),
    join(ROOT, "packages/domain/src/routing.ts"),
    join(ROOT, "packages/domain/src/secrets.ts"),
    join(ROOT, "packages/domain/src/pool.ts"),
  ];
  const app = join(ROOT, "apps/connections/src/application");
  if (existsSync(app)) {
    for (const f of readdirSync(app)) if (f.endsWith(".ts")) files.push(join(app, f));
  }
  return files;
}

describe("no vendor names in the domain", () => {
  const presets = JSON.parse(readFileSync(CATALOG, "utf8")) as Preset[];
  const names = vendorNames(presets);

  it("fails on a planted literal", () => {
    expect(vendorHits("const id = \"deepseek\";", names)).toContain("deepseek");
  });

  it("connections.ts and routing.ts name no preset", () => {
    expect(names).toContain("deepseek");
    for (const file of sources()) {
      expect(vendorHits(readFileSync(file, "utf8"), names), file).toEqual([]);
    }
  });
});

type Shape = { id: string; label: string; vendor: string };

export function shapeNames(shapes: readonly Shape[]): string[] {
  return [...new Set(shapes.flatMap(s => [s.id, s.label, s.vendor]))];
}

describe("no token-shape names in the domain", () => {
  const names = shapeNames(JSON.parse(readFileSync(SHAPES, "utf8")) as Shape[]);

  it("fails on a planted shape id or vendor", () => {
    expect(names.length).toBeGreaterThan(0);
    const [first] = JSON.parse(readFileSync(SHAPES, "utf8")) as Shape[];
    if (!first) throw new Error("empty shape catalog");
    expect(vendorHits(`const shape = "${first.id}";`, names)).toContain(first.id);
    expect(vendorHits(`// a ${first.vendor} token`, names)).toContain(first.vendor);
  });

  it("secrets.ts and the other domain and application sources name no shape", () => {
    expect(sources().some(f => f.endsWith("secrets.ts"))).toBe(true);
    for (const file of sources()) {
      expect(vendorHits(readFileSync(file, "utf8"), names), file).toEqual([]);
    }
  });
});
