// Numbered schema migrations for a service's SQLite database (ADR-0008 A1), the one runner the hub, the fleet service and
// the node agent share. The schema version is SQLite's user_version; every pending migration runs in one IMMEDIATE
// transaction that also sets the version and the schema floor, so a failure leaves the database as it was. A database
// written by a newer service is not guessed at: it is refused (`refuse` makes that service's own error) unless the
// floor — the newest breaking migration at or below its version, kept in the one-row _morndo_schema table (ADR-0019
// §11.1) — is one this program knows; then it opens as it is and nothing runs, forward or back.
import type Database from "better-sqlite3";

export type Migration = {
  version: number;
  name: string;
  /** "additive" (§11.2): an older service can still read the database this migration leaves. "breaking" raises the floor. */
  compat: "additive" | "breaking";
  up(db: Database.Database): void;
};

/** The floor of a database at `version`, read from the database itself: no _morndo_schema table, or a table with no
 *  row, counts as the version, so a database from before floors keeps the old refusal — fail-safe (§11.1). */
export function schemaFloor(db: Database.Database, version: number): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_morndo_schema'").get();
  if (!table) return version;
  const row = db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get() as { floor: number } | undefined;
  return row?.floor ?? version;
}

// The floor moves in the same transaction as user_version, so a failure moves neither (§11.1).
function writeFloor(db: Database.Database, floor: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS _morndo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), floor INTEGER NOT NULL)");
  db.prepare("INSERT INTO _morndo_schema (id, floor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET floor = excluded.floor").run(floor);
}

export function migrate(
  db: Database.Database, migrations: readonly Migration[], refuse: (found: number, known: number) => Error,
): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is numbered ${m.version}, expected ${i + 1}`);
  });
  const known = migrations.length;
  // What a run of these migrations leaves behind: the newest breaking one. Additive ones never raise the floor (§11.1).
  const ownFloor = migrations.reduce((floor, m) => (m.compat === "breaking" && m.version > floor ? m.version : floor), 0);
  const version = () => db.pragma("user_version", { simple: true }) as number;
  const first = version();
  if (schemaFloor(db, first) > known) throw refuse(first, known);
  if (first > known) return { from: first, to: first };            // only additive migrations are ahead: open, run nothing
  // The version is read again under the write lock IMMEDIATE takes: a service and a console command opening an old
  // database at once must not both run the same migrations.
  return db.transaction(() => {
    const from = version();
    if (schemaFloor(db, from) > known) throw refuse(from, known);
    if (from > known) return { from, to: from };
    for (const m of migrations.slice(from)) m.up(db);
    writeFloor(db, ownFloor);
    db.pragma(`user_version = ${known}`);
    return { from, to: known };
  }).immediate();
}
