// manifest.json, the release key's document (design §9.6). Schema versions and floors come from
// the migration lists, the same rule service-kit uses: the floor is the highest breaking
// migration, or 0 when every migration so far is additive.
import type { DatabaseName, Platform, ProtocolRange, SchemaInfo } from "@morndo/domain";
import { CLIENT_API, FLEET_PROTO, ManifestSchema } from "@morndo/protocol";
import { MIGRATIONS as connectionMigrations } from "../../apps/connections/src/adapters/store-migrations.ts";
import { MIGRATIONS as fleetMigrations } from "../../apps/fleet/src/adapters/migrations.ts";
import { MIGRATIONS as hubMigrations } from "../../apps/hub/src/adapters/migrations.ts";
import { MIGRATIONS as nodeMigrations } from "../../apps/node-agent/src/db/migrations.ts";
import { canonicalJson, isoUtc } from "./json.ts";

type SchemaMigration = { version: number; compat: "additive" | "breaking" };

export function schemaFrom(migrations: readonly SchemaMigration[]): SchemaInfo {
  if (migrations.length === 0) throw new Error("no migrations");
  let version = 0;
  let floor = 0;
  for (const migration of migrations) {
    if (migration.version > version) version = migration.version;
    if (migration.compat === "breaking" && migration.version > floor) floor = migration.version;
  }
  return { version, floor };
}

export function declaredSchemas(): Record<DatabaseName, SchemaInfo> {
  return {
    hub: schemaFrom(hubMigrations),
    fleet: schemaFrom(fleetMigrations),
    node: schemaFrom(nodeMigrations),
    connections: schemaFrom(connectionMigrations),
  };
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
