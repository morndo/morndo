// The vendor catalog is a JSON file validated by the protocol schema (design section 8).
import { readFileSync } from "node:fs";
import { parseVendorCatalog, type VendorPreset } from "@morndo/protocol";
import type { Catalog } from "../application/ports.ts";

export class CatalogRefused extends Error {
  constructor(path: string) {
    super(`${path} is not a vendor catalog`);
    this.name = "CatalogRefused";
  }
}

export class FileCatalog implements Catalog {
  readonly #presets: readonly VendorPreset[];
  constructor(path: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new CatalogRefused(path); }
    const presets = parseVendorCatalog(parsed);
    if (!presets) throw new CatalogRefused(path);
    this.#presets = presets;
  }
  presets(): readonly VendorPreset[] { return this.#presets; }
}
