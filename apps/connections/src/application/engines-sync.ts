// Publish and adopt go through EngineSettings. The CLI does not know which adapter sits behind the port.
import { findConnection, type Directory } from "@morndo/domain";
import { err, ok, type Result } from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { Catalog, EngineSettings, Failure, ModelLister, PoolNames, ProviderRegistration } from "./ports.ts";

type Added = { name: string; vendor: string; runtime: string; kind: "subscription" | "api-key" };

export function publishOwned(
  directory: Directory, catalog: Catalog, models: ModelLister, engines: EngineSettings, pools: readonly PoolNames[] = [],
): void {
  const memberOf = new Set(pools.flatMap(pool => pool.members));
  const entries: ProviderRegistration[] = [];
  for (const connection of directory.connections) {
    if (connection.custody !== "morndo" || connection.status === "revoked") continue;
    const preset = findPreset(catalog, connection.vendor);
    if (!preset) continue;
    const listed = models.models({ name: connection.name, vendor: connection.vendor }).map(row => row.id);
    if (listed.length === 0) continue;
    const pooled = memberOf.has(connection.name);
    const ready = connection.status === "on" && connection.terms !== null;
    const gate = gateBin(connection.name);
    entries.push({
      name: connection.name,
      kind: "cli",
      adapter: adapterOf(connection.runtime, catalog),
      family: preset.family,
      bin: gate.bin,
      probe: gate.probe,
      models: listed,
      enabled: pooled ? false : ready,
      login: pooled || !ready ? "missing" : "ok",
    });
  }
  const seen = new Set([...entries.map(entry => entry.name), ...directory.connections.map(connection => connection.name)]);
  for (const pool of pools) {
    if (seen.has(pool.name)) continue;
    const source = poolSource(directory, catalog, models, pool);
    if (!source) continue;
    seen.add(pool.name);
    const gate = poolBin(pool.name);
    entries.push({
      name: pool.name,
      kind: "cli",
      adapter: adapterOf(source.runtime, catalog),
      family: source.family,
      bin: gate.bin,
      probe: gate.probe,
      models: source.models,
      enabled: source.ready,
      login: source.ready ? "ok" : "missing",
    });
  }
  engines.register(entries);
}

export function adoptLayer(
  directory: Directory, catalog: Catalog, engines: EngineSettings,
  add: (input: Added) => Result<void, Failure>,
): Result<readonly string[], Failure> {
  const have = new Set(directory.connections.map(connection => connection.name));
  const added: string[] = [];
  for (const name of engines.providerNames()) {
    if (have.has(name)) continue;
    const preset = findPreset(catalog, name);
    if (!preset || preset.custody !== "engine-layer") continue;
    const kind = preset.kinds[0];
    const runtime = preset.runtimes[0]?.runtime;
    if ((kind !== "subscription" && kind !== "api-key") || !runtime) continue;
    const result = add({ name, vendor: name, runtime, kind });
    if (!result.ok) return err(result.error);
    added.push(name);
    have.add(name);
  }
  return ok(added);
}

export function gateBin(name: string): { bin: string[]; probe: string[] } {
  return {
    bin: ["morndo-keys", "run", "--connection", name, "--"],
    probe: ["morndo-keys", "check", "--connection", name],
  };
}

export function poolBin(name: string): { bin: string[]; probe: string[] } {
  return {
    bin: ["morndo-keys", "run", "--pool", name, "--"],
    probe: ["morndo-keys", "check", "--pool", name],
  };
}

export function gateCommand(name: string, value: string | readonly string[] | null): boolean {
  if (value === null) return false;
  const gate = gateBin(name);
  const matches = (command: readonly string[]) => typeof value === "string"
    ? value === command.join(" ")
    : value.length === command.length && value.every((item, index) => item === command[index]);
  return matches(gate.bin) || matches(gate.probe);
}

// The first non-revoked member with a known preset and a non-empty model list speaks for the pool.
function poolSource(
  directory: Directory, catalog: Catalog, models: ModelLister, pool: PoolNames,
): { runtime: string; family: string; models: string[]; ready: boolean } | null {
  let chosen: { runtime: string; family: string; models: string[] } | null = null;
  let ready = false;
  for (const name of pool.members) {
    const connection = findConnection(directory, name);
    if (!connection || connection.status === "revoked") continue;
    if (connection.status === "on" && connection.terms !== null) ready = true;
    if (chosen) continue;
    const preset = findPreset(catalog, connection.vendor);
    if (!preset) continue;
    const listed = models.models({ name: connection.name, vendor: connection.vendor }).map(row => row.id);
    if (listed.length === 0) continue;
    chosen = { runtime: connection.runtime, family: preset.family, models: listed };
  }
  return chosen ? { ...chosen, ready } : null;
}

function adapterOf(runtime: string, catalog: Catalog): string {
  const known = catalog.presets().flatMap(preset => preset.runtimes.map(row => row.runtime));
  if (known.includes(runtime)) return runtime;
  return known[0] ?? runtime;
}
