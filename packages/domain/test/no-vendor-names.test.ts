// Vendors are data (ADR-0018 §4). Preset ids and labels from the catalog must not appear in the domain sources.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
const CATALOG = join(ROOT, "packages/protocol/catalog/vendors.json");

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
