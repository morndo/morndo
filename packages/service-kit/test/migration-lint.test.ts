// The additive linter (§11.2): what a migration declared "additive" may do, and what fails the lint. The migration
// really runs, against a throwaway in-memory SQLite database, so what is linted is what would run — conditions and
// all. The fixtures create what they touch: the throwaway starts empty, and a statement that is only data (an INSERT
// into a table the migration never made) would fail to run before the lint could say anything about it.
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { additiveViolations, lintMigrations, migrationStatements, type Migration } from "../src/index.ts";

const M = (up: (db: Database.Database) => void, compat: "additive" | "breaking" = "additive"): Migration =>
  ({ version: 1, name: "m1", compat, up });

// A list with more than one migration in it, numbered the way a service's list is.
const N = (version: number, up: (db: Database.Database) => void, compat: "additive" | "breaking" = "additive"): Migration =>
  ({ version, name: `m${version}`, compat, up });

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
    const m = M(db => db.exec(`CREATE TABLE t (v); INSERT INTO t (v) VALUES ('a;b'); UPDATE t SET v = 'c'`));
    expect(migrationStatements(m)).toEqual(["CREATE TABLE t (v)", `INSERT INTO t (v) VALUES ('a;b')`, `UPDATE t SET v = 'c'`]);
  });
  it("runs the migration, so a statement a condition hides is recorded too", () => {
    const m = M(db => {
      db.exec("CREATE TABLE moved (x)");
      db.exec("INSERT INTO moved (x) VALUES (1)");
      if (db.prepare("SELECT x FROM moved").get() !== undefined) db.exec("INSERT INTO moved (x) VALUES (2)");
    });
    expect(migrationStatements(m)).toContain("INSERT INTO moved (x) VALUES (2)");
  });
});

describe("the additive linter", () => {
  it("accepts the additive shapes (§11.2): new tables and indexes, columns an older reader can leave alone, data", () => {
    expect(lintMigrations([
      M(db => db.exec(`
        CREATE TABLE t (x);
        CREATE TABLE IF NOT EXISTS t (x);
        CREATE INDEX t_x ON t (x);
        CREATE TABLE other (x);
        INSERT INTO t (x) SELECT x FROM other;
        UPDATE t SET x = 1;
        DELETE FROM t;
        ALTER TABLE t ADD COLUMN y INTEGER;                 -- nullable: an older service reads NULL
        ALTER TABLE t ADD COLUMN z INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE u (u);
        CREATE UNIQUE INDEX IF NOT EXISTS u_u ON u (u);
        WITH moved AS (SELECT x FROM t) INSERT INTO other (x) SELECT x FROM moved;
        PRAGMA foreign_keys = ON;
      `)),
    ])).toEqual([]);
  });

  it("fails a DROP a condition hides: the lint runs against a real database, not a stub that answers undefined", () => {
    const m = M(db => {
      db.exec("CREATE TABLE old (x)");
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'old'").get() !== undefined) db.exec("DROP TABLE old");
    });
    expect(additiveViolations(m)).toEqual([
      "migration 1 (m1): DROP TABLE old is not on the additive list (§11.2)",
    ]);
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
    expect(additiveViolations(M(db => db.exec("CREATE TABLE t (x); DROP TABLE t; CREATE TABLE t2 AS SELECT 1"), "breaking"))).toEqual([]);
    expect(lintMigrations([M(db => db.exec("CREATE TABLE t (x); DROP TABLE t"), "breaking"), M(db => db.exec("CREATE TABLE u (x)"))])).toEqual([]);
  });

  it("lints a whole list against one database, each migration meeting what the ones before it left", () => {
    expect(lintMigrations([
      M(db => db.exec("CREATE TABLE t (x)")),
      M(db => db.exec("INSERT INTO t (x) VALUES (1)")),                 // runs after migration 1, for real
    ])).toEqual([]);
  });

  it("fails a unique index on a table an older service writes, accepts one on a table this migration creates", () => {
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE jobs (lane TEXT)")),
      N(2, db => db.exec("CREATE UNIQUE INDEX jobs_lane ON jobs (lane)")),
    ])).toEqual([
      "migration 2 (m2): creates a unique index on an existing table: an older service's inserts could violate it",
    ]);
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE own (lane TEXT); CREATE UNIQUE INDEX own_lane ON own (lane)")),
    ])).toEqual([]);
  });

  it("fails a column with a CHECK, and keeps the words of string literals out of the judgement", () => {
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE t (x)")),
      N(2, db => db.exec("ALTER TABLE t ADD COLUMN y TEXT CHECK (y <> 'x')")),
    ])).toEqual([
      "migration 2 (m2): adds a column with a CHECK: an older service's writes could fail it",
    ]);
    // 'DEFAULT' in the data used to satisfy the default test and pass this lint.
    expect(additiveViolations(M(db => db.exec("CREATE TABLE t (x); ALTER TABLE t ADD COLUMN y TEXT NOT NULL CHECK (y <> 'DEFAULT')")))).toEqual([
      "migration 1 (m1): adds a column with a CHECK: an older service's writes could fail it",
    ]);
    expect(additiveViolations(M(db => db.exec("CREATE TABLE t (x); ALTER TABLE t ADD COLUMN y TEXT DEFAULT 'NOT NULL'")))).toEqual([]);  // nullable; the words are data
    expect(additiveViolations(M(db => db.exec("CREATE TABLE t (x); ALTER TABLE t ADD COLUMN y TEXT NOT NULL DEFAULT 'x'")))).toEqual([]);
  });

  it("fails a new table whose foreign key restricts or cascades deletes in a table an older service writes", () => {
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)")),
      N(2, db => db.exec("CREATE TABLE node_tags (node TEXT NOT NULL REFERENCES nodes (id) ON DELETE RESTRICT, tag TEXT NOT NULL)")),
    ])).toEqual([
      "migration 2 (m2): points a foreign key at the existing table nodes with ON DELETE RESTRICT: an older service's deletes would fail",
    ]);
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)")),
      N(2, db => db.exec(`
        CREATE TABLE node_tags (
          tag TEXT NOT NULL,
          node TEXT NOT NULL,
          FOREIGN KEY (node) REFERENCES nodes (id) ON DELETE CASCADE
        )`)),
    ])).toEqual([
      "migration 2 (m2): points a foreign key at the existing table nodes with ON DELETE CASCADE: an older service's deletes would silently drop rows",
    ]);
    expect(lintMigrations([
      N(1, db => db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY); CREATE TABLE node_tags (node TEXT NOT NULL REFERENCES nodes (id) ON DELETE RESTRICT)")),
    ])).toEqual([]);                    // into a table of this own migration: no older service writes either side
  });
});
