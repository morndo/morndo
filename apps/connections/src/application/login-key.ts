// A runtime we keep, which the engine layer also runs as a key, is a browser login. An API key
// in our custody would run on that login. The engine layer's own provider is not that key.
import type { VendorPreset } from "@morndo/protocol";

export function loginKeyRefused(presets: readonly VendorPreset[], runtime: string, kind: string, custody: string): boolean {
  if (custody !== "morndo" || kind !== "api-key") return false;
  const ours = presets.some(preset => preset.custody === "morndo" && preset.runtimes.some(row => row.runtime === runtime));
  const layerKey = presets.some(preset => preset.custody === "engine-layer" && preset.kinds.includes("api-key") && preset.runtimes.some(row => row.runtime === runtime));
  return ours && layerKey;
}
