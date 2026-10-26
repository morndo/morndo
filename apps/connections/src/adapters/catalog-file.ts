// The vendor catalog is a JSON file validated by the protocol schema (design section 8). Key-pool terms are the
// sibling file key-pools.json, and probe models are key-pool-probes.json. Missing, unreadable or invalid: there
// are no key pools, or no probes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseKeyPoolCatalog, parseKeyPoolProbeCatalog, parseVendorCatalog, type KeyPoolProbe, type KeyPoolTerms, type VendorPreset } from "@morndo/protocol";
import type { Catalog } from "../application/ports.ts";

export class CatalogRefused extends Error {
  constructor(path: string) {
    super(`${path} is not a vendor catalog`);
    this.name = "CatalogRefused";
  }
}

function readKeyPools(path: string): ReadonlyMap<string, KeyPoolTerms> {
  try {
    const parsed = parseKeyPoolCatalog(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return new Map();
    return new Map(parsed.map(entry => [entry.vendor, {
      errorDialect: entry.errorDialect, termsRevision: entry.termsRevision, termsLine: entry.termsLine,
    }]));
  } catch {
    return new Map();
  }
}

function readKeyPoolProbes(path: string): ReadonlyMap<string, KeyPoolProbe> {
  try {
    const parsed = parseKeyPoolProbeCatalog(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed) return new Map();
    return new Map(parsed.map(entry => [entry.vendor, { model: entry.model }]));
  } catch {
    return new Map();
  }
}

export class FileCatalog implements Catalog {
  readonly #presets: readonly VendorPreset[];
  readonly #pools: ReadonlyMap<string, KeyPoolTerms>;
  readonly #probes: ReadonlyMap<string, KeyPoolProbe>;
  constructor(path: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new CatalogRefused(path); }
    const presets = parseVendorCatalog(parsed);
    if (!presets) throw new CatalogRefused(path);
    this.#presets = presets;
    const dir = dirname(path);
    this.#pools = readKeyPools(join(dir, "key-pools.json"));
    this.#probes = readKeyPoolProbes(join(dir, "key-pool-probes.json"));
  }
  presets(): readonly VendorPreset[] { return this.#presets; }
  keyPool(vendor: string): KeyPoolTerms | null { return this.#pools.get(vendor) ?? null; }
  keyPoolProbe(vendor: string): KeyPoolProbe | null { return this.#probes.get(vendor) ?? null; }
}
