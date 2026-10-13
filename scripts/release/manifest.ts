// manifest.json, the release key's document (design §9.6). Schema versions and floors come from
// the apps' MIGRATIONS arrays, read in a child process so this module does not load them itself.
// The child needs npm ci on the same Node (scripts/release/README.md). The floor is the highest
// breaking migration, or 0 when every migration so far is additive.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DatabaseName, Platform, ProtocolRange, SchemaInfo } from "@morndo/domain";
import { CLIENT_API, FLEET_PROTO, ManifestSchema } from "@morndo/protocol";
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
  const child = fileURLToPath(new URL("./schema-child.ts", import.meta.url));
  const run = spawnSync(process.execPath, [child], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || "schema read failed");
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isDeclared(parsed)) throw new Error("schema read was not the four databases");
  return parsed;
}

function isDeclared(value: unknown): value is Record<DatabaseName, SchemaInfo> {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return ["hub", "fleet", "node", "connections"].every(name => {
    const schema = row[name];
    return typeof schema === "object" && schema !== null
      && "version" in schema && typeof schema.version === "number"
      && "floor" in schema && typeof schema.floor === "number";
  });
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
