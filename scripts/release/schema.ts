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

// A migration list must run 1, 2, 3 ... with no gap, repeat or swap: a database's user_version is the
// last one applied, so the version the Manifest announces is only true if the list is complete and in order.
export function orderProblems(migrations: readonly { version: number }[]): string[] {
  const problems: string[] = [];
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version !== previous + 1) problems.push(`version ${migration.version} follows ${previous}`);
    previous = migration.version;
  }
  return problems;
}
