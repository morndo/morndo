// A revoked engine-layer provider is disabled at once, and dropped once no chain names it.
import { stillNamed, type Directory, type Policy } from "@morndo/domain";
import type { EngineSettings } from "./ports.ts";

export function chainHolders(outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[], name: string): string[] {
  return outside.flatMap(row => {
    const named = [...row.chain, ...(row.risk ?? [])].some(entry => entry === name || entry.startsWith(`${name}:`));
    return named ? [row.role] : [];
  });
}

// A removal the engine layer would refuse. Callers check this before they persist anything.
// `outside` is the chains already read for this command, so a save does not spawn the CLI again.
export function blockedRemoval(
  directory: Directory, policy: Policy, engines: EngineSettings,
  outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[] = engines.chains(),
): { name: string; roles: readonly string[] } | null {
  for (const connection of directory.connections) {
    if (connection.custody !== "engine-layer" || connection.status !== "revoked") continue;
    if (stillNamed(policy, connection.name)) continue;
    const roles = chainHolders(outside, connection.name);
    if (roles.length > 0) return { name: connection.name, roles };
  }
  return null;
}

export function syncRevoked(directory: Directory, policy: Policy, engines: EngineSettings): void {
  for (const connection of directory.connections) {
    if (connection.custody !== "engine-layer" || connection.status !== "revoked") continue;
    if (stillNamed(policy, connection.name)) engines.putProvider({ name: connection.name, enabled: false });
    else engines.removeProvider(connection.name);
  }
}
