// Publish and adopt go through EngineSettings. The CLI does not know which adapter sits behind the port.
import type { Directory } from "@morndo/domain";
import { err, ok, type Result } from "@morndo/domain";
import { findPreset } from "./catalog.ts";
import type { Catalog, EngineSettings, Failure, ModelLister, ProviderRegistration } from "./ports.ts";

type Added = { name: string; vendor: string; runtime: string; kind: "subscription" | "api-key" };

export function publishOwned(directory: Directory, catalog: Catalog, models: ModelLister, engines: EngineSettings): void {
  const entries: ProviderRegistration[] = [];
  for (const connection of directory.connections) {
    if (connection.custody !== "morndo" || connection.status === "revoked") continue;
    const preset = findPreset(catalog, connection.vendor);
    if (!preset) continue;
    const listed = models.models({ name: connection.name, vendor: connection.vendor }).map(row => row.id);
    if (listed.length === 0) continue;
    entries.push({
      name: connection.name,
      kind: "cli",
      adapter: adapterOf(connection.runtime, catalog),
      family: preset.family,
      bin: ["morndo-keys", "run", "--connection", connection.name, "--"],
      probe: ["morndo-keys", "check", "--connection", connection.name],
      models: listed,
      enabled: connection.status === "on" && connection.terms !== null,
      login: connection.status === "on" && connection.terms !== null ? "ok" : "missing",
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

export function gateCommand(name: string, value: string | readonly string[] | null): boolean {
  if (value === null) return false;
  const gate = gateBin(name);
  const matches = (command: readonly string[]) => typeof value === "string"
    ? value === command.join(" ")
    : value.length === command.length && value.every((item, index) => item === command[index]);
  return matches(gate.bin) || matches(gate.probe);
}

function adapterOf(runtime: string, catalog: Catalog): string {
  const known = catalog.presets().flatMap(preset => preset.runtimes.map(row => row.runtime));
  if (known.includes(runtime)) return runtime;
  return known[0] ?? runtime;
}
