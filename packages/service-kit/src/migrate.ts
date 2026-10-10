// Numbered schema migrations for a service's SQLite database (ADR-0008 A1), the one runner the hub, the fleet service and
// the node agent share. The schema version is SQLite's user_version; every pending migration runs in one IMMEDIATE
// transaction that also sets the version, so a failure leaves the database as it was; a database written by a newer
// service is refused (`refuse` makes that service's own error) rather than guessed at.
import type Database from "better-sqlite3";

export type Migration = { version: number; name: string; up(db: Database.Database): void };

export function migrate(
  db: Database.Database, migrations: readonly Migration[], refuse: (found: number, known: number) => Error,
): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is numbered ${m.version}, expected ${i + 1}`);
  });
  const known = migrations.length;
  const version = () => db.pragma("user_version", { simple: true }) as number;
  const first = version();
  if (first > known) throw refuse(first, known);
  if (first === known) return { from: first, to: first };
  // The version is read again under the write lock IMMEDIATE takes: a service and a console command opening an old
  // database at once must not both run the same migrations.
  return db.transaction(() => {
    const from = version();
    if (from > known) throw refuse(from, known);
    for (const m of migrations.slice(from)) m.up(db);
    db.pragma(`user_version = ${known}`);
    return { from, to: known };
  }).immediate();
}
