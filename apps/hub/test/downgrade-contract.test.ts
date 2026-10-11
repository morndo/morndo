// The downgrade contract (§13): a build of the previous version opens a database this version migrated when the floor
// allows, and refuses it otherwise. In-repo a previous build is its prefix of the list, run by the same runner; every
// hub migration is additive, so this version's database carries floor 0 and every build back to the first opens it.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";

const LATEST = MIGRATIONS.length;

describe("the downgrade contract (§13)", () => {
  it("every previous build's list opens this version's database: the floor is 0, so nothing runs", () => {
    for (let known = 1; known < LATEST; known++) {
      const db = new Database(":memory:");
      expect(migrate(db)).toEqual({ from: 0, to: LATEST });              // this version migrated it, floor row and all
      expect(migrate(db, MIGRATIONS.slice(0, known))).toEqual({ from: LATEST, to: LATEST });   // the previous build opens
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST);  // as it was: nothing ran, forward or back
      db.close();
    }
  });
});
