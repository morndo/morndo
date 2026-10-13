// Loads the apps' real MIGRATIONS arrays. Those import the service-kit barrel, which loads
// better-sqlite3, so this process needs the repo's npm ci on the same Node (scripts/release/README.md).
import { MIGRATIONS as connectionMigrations } from "../../apps/connections/src/adapters/store-migrations.ts";
import { MIGRATIONS as fleetMigrations } from "../../apps/fleet/src/adapters/migrations.ts";
import { MIGRATIONS as hubMigrations } from "../../apps/hub/src/adapters/migrations.ts";
import { MIGRATIONS as nodeMigrations } from "../../apps/node-agent/src/db/migrations.ts";
import { schemaFrom } from "./schema.ts";

const schemas = {
  hub: schemaFrom(hubMigrations),
  fleet: schemaFrom(fleetMigrations),
  node: schemaFrom(nodeMigrations),
  connections: schemaFrom(connectionMigrations),
};
process.stdout.write(`${JSON.stringify(schemas)}\n`);
