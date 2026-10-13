// Version and floor from a migration list. No app imports: the child that reads the real
// MIGRATIONS arrays is the only process that loads them.
export function schemaFrom(migrations: readonly { version: number; compat: "additive" | "breaking" }[]): { version: number; floor: number } {
  if (migrations.length === 0) throw new Error("no migrations");
  let version = 0;
  let floor = 0;
  for (const migration of migrations) {
    if (migration.version > version) version = migration.version;
    if (migration.compat === "breaking" && migration.version > floor) floor = migration.version;
  }
  return { version, floor };
}
