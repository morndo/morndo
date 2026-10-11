// Schema floors (ADR-0019, docs/design/updates/README.md §11.1): a service refuses a database whose floor — the highest
// breaking migration at or below its version, kept in the one-row `_morndo_schema` table — is above the schema it knows;
// a newer database whose migrations were all additive opens without running anything and leaves alone what it doesn't
// know. A database with no floor table counts as floor = its version: the old refusal, unchanged.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openPrivateDb, writeFloor, type Migration } from "../src/index.ts";

const M = (version: number): Migration => ({ version, name: `m${version}`, compat: "additive", up: db => { db.exec(`CREATE TABLE t${version} (x)`); } });
const future = (found: number, known: number) => new Error(`future ${found} ${known}`);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("schema floors in the runner", () => {
  it("opens a newer database whose floor it knows, runs nothing, and leaves what it doesn't know alone", () => {
    const db = new Database(":memory:");
    migrate(db, [M(1), M(2)], future);
    db.exec("CREATE TABLE t3 (x)");                       // the next version's additive migration 3 …
    writeFloor(db, 0);                                     // … additive: the floor stays where it was
    db.pragma("user_version = 3");
    expect(migrate(db, [M(1), M(2)], future)).toEqual({ from: 3, to: 3 });
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't3'").all()).toEqual([{ name: "t3" }]);
  });

  it("refuses a newer database whose floor is above the schema it knows", () => {
    const db = new Database(":memory:");
    migrate(db, [M(1), M(2)], future);
    writeFloor(db, 3);                                     // the next version's migration 3 was breaking
    db.pragma("user_version = 3");
    expect(() => migrate(db, [M(1), M(2)], future)).toThrow("future 3 2");
    expect(db.pragma("user_version", { simple: true })).toBe(3);
  });

  it("writes nothing when the database is already up to date: no floor rewrite, no version write", () => {
    const db = new Database(":memory:");
    migrate(db, [M(1), M(2)], future);
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    expect(migrate(db, [M(1), M(2)], future)).toEqual({ from: 2, to: 2 });
    expect(changes()).toBe(before);                       // the upsert used to move this: a write on every open
  });

  it("opens an up-to-date database read-only: a plain open takes no write lock", () => {
    const path = join(mkdtempSync(join(tmpdir(), "morndo-floor-")), "db");
    dirs.push(dirname(path));
    const made = new Database(path);
    migrate(made, [M(1), M(2)], future);
    made.close();
    const readonly = new Database(path, { readonly: true });
    expect(migrate(readonly, [M(1), M(2)], future)).toEqual({ from: 2, to: 2 });  // BEGIN IMMEDIATE would fail here
    readonly.close();
  });

  it("gives a database from before floors, already at this version, the floor row alone", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t1 (x); CREATE TABLE t2 (y)");   // as the pre-floor build at version 2 left it
    db.pragma("user_version = 2");
    const breaking: Migration = { version: 1, name: "m1", compat: "breaking", up: () => {} };
    expect(migrate(db, [breaking, M(2)], future)).toEqual({ from: 2, to: 2 });   // no migration runs
    expect(db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get()).toEqual({ floor: 1 });
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("counts a floor table with no row as floor = the version: the fail-safe refusal", () => {
    const db = new Database(":memory:");
    migrate(db, [M(1), M(2)], future);
    db.exec("DELETE FROM _morndo_schema");                 // the row is missing: as if the version before floors wrote it
    db.pragma("user_version = 3");
    expect(() => migrate(db, [M(1), M(2)], future)).toThrow("future 3 2");
  });
});

describe("schema floors at open (openPrivateDb)", () => {
  const options = () => ({
    synchronous: "NORMAL" as const,
    knownVersion: 2,
    refuseNewer: future,
    migrate: (db: Database.Database) => {
      if ((db.pragma("user_version", { simple: true }) as number) > 0) return;
      db.exec("CREATE TABLE t1 (x); CREATE TABLE t2 (y)");
      db.pragma("user_version = 2");
    },
  });
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

  it("opens a newer compatible database without touching its schema", () => {
    const path = join(mkdtempSync(join(tmpdir(), "morndo-floor-")), "db");
    dirs.push(dirname(path));
    const first = openPrivateDb(path, options());
    first.close();
    const raw = new Database(path);
    raw.exec("CREATE TABLE t3 (z)");                      // a newer version's additive migration
    writeFloor(raw, 0);
    raw.pragma("user_version = 3");
    raw.close();
    const again = openPrivateDb(path, options());
    expect(again.pragma("user_version", { simple: true })).toBe(3);
    expect(again.prepare("SELECT name FROM sqlite_master WHERE name = 't3'").all()).toEqual([{ name: "t3" }]);
    again.close();
  });

  it("refuses a newer breaking database before any write: the file byte for byte untouched", () => {
    const path = join(mkdtempSync(join(tmpdir(), "morndo-floor-")), "db");
    dirs.push(dirname(path));
    const first = openPrivateDb(path, options());
    first.close();
    const raw = new Database(path);
    raw.exec("CREATE TABLE t3 (z)");
    writeFloor(raw, 3);                                    // that migration was breaking
    raw.pragma("user_version = 3");
    raw.close();
    const before = sha(path);
    expect(() => openPrivateDb(path, options())).toThrow("future 3 2");
    expect(sha(path)).toBe(before);                       // the file itself: it is WAL-mode (openPrivateDb made it so),
    // and a read-only probe of a WAL database opens its -shm/-wal beside it; the database's bytes don't move.
  });
});
