// The additive linter (§11.2): what a migration declared "additive" may do, and what fails the lint. The SQL comes
// from the migration's own up(), through the recorder, so what is linted is what would run.
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { additiveViolations, lintMigrations, migrationStatements, type Migration } from "../src/index.ts";

const M = (up: (db: Database.Database) => void, compat: "additive" | "breaking" = "additive"): Migration =>
  ({ version: 1, name: "m1", compat, up });

describe("migrationStatements", () => {
  it("records what exec and prepare would run, statements split and comments dropped", () => {
    const m = M(db => {
      db.exec(`
        -- one table, two statements
        CREATE TABLE a (x);
        CREATE TABLE b (y); -- the second
      `);
      db.prepare("INSERT INTO a (x) VALUES (1)").run();
    });
    expect(migrationStatements(m)).toEqual(["CREATE TABLE a (x)", "CREATE TABLE b (y)", "INSERT INTO a (x) VALUES (1)"]);
  });
  it("does not split on a semicolon inside a string", () => {
    const m = M(db => db.exec(`INSERT INTO t (v) VALUES ('a;b'); UPDATE t SET v = 'c'`));
    expect(migrationStatements(m)).toEqual([`INSERT INTO t (v) VALUES ('a;b')`, `UPDATE t SET v = 'c'`]);
  });
});

describe("the additive linter", () => {
  it("accepts the additive shapes (§11.2): new tables and indexes, columns an older reader can leave alone, data", () => {
    expect(lintMigrations([
      M(db => db.exec("CREATE TABLE t (x)")),
      M(db => db.exec("CREATE TABLE IF NOT EXISTS t (x)")),
      M(db => db.exec("CREATE INDEX t_x ON t (x)")),
      M(db => db.exec("CREATE UNIQUE INDEX IF NOT EXISTS t_x ON t (x)")),
      M(db => db.exec("ALTER TABLE t ADD COLUMN y INTEGER")),                 // nullable: an older service reads NULL
      M(db => db.exec("ALTER TABLE t ADD COLUMN y INTEGER NOT NULL DEFAULT 0")),
      M(db => db.exec("INSERT INTO t (x) SELECT x FROM other")),
      M(db => db.exec("UPDATE t SET x = 1")),
      M(db => db.exec("DELETE FROM t")),
      M(db => db.exec("WITH moved AS (SELECT x FROM t) INSERT INTO u SELECT x FROM moved")),
      M(db => db.exec("PRAGMA foreign_keys = ON")),
    ])).toEqual([]);
  });

  it("fails a DROP, whatever it drops", () => {
    expect(additiveViolations(M(db => db.exec("DROP TABLE jobs")))).toEqual([
      "migration 1 (m1): DROP TABLE jobs is not on the additive list (§11.2)",
    ]);
    expect(additiveViolations(M(db => db.exec("DROP INDEX t_x")))).toHaveLength(1);
  });

  it("fails a rename, a dropped column and any ALTER that is not adding a column", () => {
    expect(additiveViolations(M(db => db.exec("ALTER TABLE jobs_keyed RENAME TO jobs")))).toEqual([
      "migration 1 (m1): changes a table other than by adding a column",
    ]);
    expect(additiveViolations(M(db => db.exec("ALTER TABLE t DROP COLUMN y")))).toHaveLength(1);
  });

  it("fails a NOT NULL column with no default, and a table rebuilt as CREATE TABLE … AS SELECT", () => {
    expect(additiveViolations(M(db => db.exec("ALTER TABLE t ADD COLUMN y INTEGER NOT NULL")))).toEqual([
      "migration 1 (m1): adds a NOT NULL column with no default: an older service could not insert",
    ]);
    expect(additiveViolations(M(db => db.exec("CREATE TABLE t2 AS SELECT * FROM t")))).toEqual([
      "migration 1 (m1): rebuilds a table (CREATE TABLE … AS SELECT)",
    ]);
  });

  it("fails a view or a trigger: an older service may not know what they mean", () => {
    expect(additiveViolations(M(db => db.exec("CREATE VIEW v AS SELECT 1")))).toEqual([
      "migration 1 (m1): creates a view, which an older service may not know",
    ]);
    // A trigger's body splits into statements of its own — the splitter knows no BEGIN…END — but the lint fails all the same.
    const trigger = additiveViolations(M(db => db.exec("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END")));
    expect(trigger[0]).toBe("migration 1 (m1): creates a trigger, which an older service may not know");
  });

  it("holds a migration declared breaking to nothing: it owes the floor, not the list", () => {
    expect(additiveViolations(M(db => db.exec("DROP TABLE t; CREATE TABLE t2 AS SELECT 1"), "breaking"))).toEqual([]);
    expect(lintMigrations([M(db => db.exec("DROP TABLE t"), "breaking"), M(db => db.exec("CREATE TABLE u (x)"))])).toEqual([]);
  });
});
