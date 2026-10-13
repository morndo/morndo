// manifest.json, the release key's document (design §9.6). Schema versions and floors are read
// from the migration sources, the same rule service-kit uses: the floor is the highest breaking
// migration, or 0 when every migration so far is additive. Importing those modules would load
// better-sqlite3 through the service-kit barrel; the sources are enough, and the test pins the numbers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseName, Platform, ProtocolRange, SchemaInfo } from "@morndo/domain";
import { CLIENT_API, FLEET_PROTO, ManifestSchema } from "@morndo/protocol";
import { canonicalJson, isoUtc } from "./json.ts";

const SOURCES: Record<DatabaseName, string> = {
  hub: "apps/hub/src/adapters/migrations.ts",
  fleet: "apps/fleet/src/adapters/migrations.ts",
  node: "apps/node-agent/src/db/migrations.ts",
  connections: "apps/connections/src/adapters/store-migrations.ts",
};

const MIGRATION = /version:\s*(\d+),[\s\S]*?compat:\s*"(additive|breaking)"/g;

export function declaredSchemas(root = join(import.meta.dirname, "../..")): Record<DatabaseName, SchemaInfo> {
  return {
    hub: schemaOf(readFileSync(join(root, SOURCES.hub), "utf8")),
    fleet: schemaOf(readFileSync(join(root, SOURCES.fleet), "utf8")),
    node: schemaOf(readFileSync(join(root, SOURCES.node), "utf8")),
    connections: schemaOf(readFileSync(join(root, SOURCES.connections), "utf8")),
  };
}

export function schemaOf(source: string): SchemaInfo {
  const found = [...source.matchAll(MIGRATION)];
  if (found.length === 0) throw new Error("no migrations in source");
  let version = 0;
  let floor = 0;
  for (const match of found) {
    const n = Number(match[1]);
    const compat = match[2];
    if (!Number.isInteger(n) || (compat !== "additive" && compat !== "breaking")) throw new Error("migration source");
    version = n;
    if (compat === "breaking" && n > floor) floor = n;
  }
  return { version, floor };
}

export function protocolRange(): ProtocolRange {
  return {
    agent: [Math.max(1, FLEET_PROTO - 1), FLEET_PROTO],
    clientApi: [Math.max(1, CLIENT_API - 1), CLIENT_API],
  };
}

export function artifactName(version: string, platform: Platform): string {
  return `morndo-${version}-${platform}.tar.gz`;
}

export type ArtifactInput = {
  platform: Platform; name: string; size: number; sha256: string; filesSha256: string; node: string;
};

export function buildManifest(p: {
  version: string; commit: string; publishedAt: number; repository: string;
  protocol: ProtocolRange; schemas: Record<DatabaseName, SchemaInfo>; artifacts: readonly ArtifactInput[];
}): string {
  const artifacts = [...p.artifacts].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
  const doc = {
    schema: 1,
    product: "morndo",
    version: p.version,
    commit: p.commit,
    publishedAt: isoUtc(p.publishedAt),
    notes: `https://github.com/${p.repository}/releases/tag/v${p.version}`,
    protocol: { agent: p.protocol.agent, clientApi: p.protocol.clientApi },
    schemas: {
      hub: p.schemas.hub, fleet: p.schemas.fleet, node: p.schemas.node, connections: p.schemas.connections,
    },
    artifacts: artifacts.map(a => ({
      platform: a.platform, name: a.name, size: a.size, sha256: a.sha256, filesSha256: a.filesSha256,
      node: a.node,
    })),
  };
  const parsed = ManifestSchema.safeParse(doc);
  if (!parsed.success) throw new Error("manifest is not the wire's shape");
  return canonicalJson(doc);
}
