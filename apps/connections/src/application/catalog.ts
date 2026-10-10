// The catalog is data. Callers pass a vendor id; this file names none.
import type { Isolation } from "@morndo/domain";
import type { VendorPreset } from "@morndo/protocol";
import type { Catalog } from "./ports.ts";

export function findPreset(catalog: Catalog, vendor: string): VendorPreset | null {
  return catalog.presets().find(p => p.id === vendor) ?? null;
}

export function floorOf(preset: VendorPreset): Isolation {
  return preset.isolation ?? "none";
}

export function dialectOf(preset: VendorPreset, runtime: string): string {
  return preset.runtimes.find(r => r.runtime === runtime)?.dialect ?? "";
}
