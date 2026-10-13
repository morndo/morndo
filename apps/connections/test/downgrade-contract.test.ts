// The downgrade contract (§13): a build of the previous version opens a store this version migrated when the floor
// allows. The store has one migration, so there is no shorter previous list in-repo; the next version is played the
// way it will really be — this list plus one additive migration, the floor row written by the runner itself — and this
// version's list must open what it leaves. The store is additive forever (§11), so the floor never rises.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, type Migration } from "../src/adapters/store-migrations.ts";

const LATEST = MIGRATIONS.length;

describe("the downgrade contract (§13)", () => {
  it("this version's list opens what the next version's additive migration leaves", () => {
    const next: Migration[] = [...MIGRATIONS, {
      version: LATEST + 1,
      name: "the next version's additive migration",
      compat: "additive",
      up: db => db.exec("CREATE TABLE future_addition (x)"),
    }];
    const db = new Database(":memory:");
    expect(migrate(db, next)).toEqual({ from: 0, to: LATEST + 1 });      // the next version migrated it
    expect((db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get() as { floor: number }).floor).toBe(0);
    expect(migrate(db)).toEqual({ from: LATEST + 1, to: LATEST + 1 });   // this version opens it: runs nothing
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST + 1);
    db.close();
  });
});
