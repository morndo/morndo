// The downgrade contract (§13): a build of the previous version opens a database this version migrated when the floor
// allows, and refuses it otherwise. In-repo a previous build is its prefix of the list, run by the same runner; the
// fleet's floor is 7 (migration 7 rebuilt the jobs tables), so every build back to 7 opens this database and every
// build from before it refuses.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/adapters/migrations.ts";

const LATEST = MIGRATIONS.length;
const FLOOR = 7;

describe("the downgrade contract (§13)", () => {
  it("every build's list back to migration 7 opens this database; a build from before it refuses", () => {
    const floorOf = (db: Database.Database) =>
      (db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get() as { floor: number }).floor;
    for (let known = 1; known < LATEST; known++) {
      const db = new Database(":memory:");
      expect(migrate(db)).toEqual({ from: 0, to: LATEST });              // this version migrated it
      expect(floorOf(db)).toBe(FLOOR);                                   // and wrote the floor it owes (§11.1)
      if (known >= FLOOR) {
        expect(migrate(db, MIGRATIONS.slice(0, known))).toEqual({ from: LATEST, to: LATEST });   // opens, runs nothing
      } else {
        expect(() => migrate(db, MIGRATIONS.slice(0, known))).toThrow(DatabaseFromFuture);       // the floor refuses
      }
      db.close();
    }
  });
});
