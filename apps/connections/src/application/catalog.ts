// The catalog is data. Callers pass a vendor id; this file names none.
import type { Isolation } from "@morndo/domain";
import { BUILTIN_FIRST_PARTY_HOST, type VendorPreset } from "@morndo/protocol";
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

export { BUILTIN_FIRST_PARTY_HOST };

export function firstPartyHost(presets: readonly VendorPreset[]): string {
  for (const preset of presets) {
    for (const runtime of preset.runtimes) {
      if (runtime.firstParty !== true || runtime.baseUrl === null) continue;
      try {
        const host = new URL(runtime.baseUrl).host;
        if (host !== "") return host;
      } catch { /* a flagged row with an unusable base is ignored */ }
    }
  }
  return BUILTIN_FIRST_PARTY_HOST;
}
