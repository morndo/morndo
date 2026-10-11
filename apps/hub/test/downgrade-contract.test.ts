// The downgrade contract (§13): a build of the previous version opens a database this version migrated when the floor
// allows, and refuses it otherwise. Until the first Release exists, "the previous build" is a build of the parent
// commit, and here it is the real one: the runner as it is on this branch's base, loaded from git
// (scripts/previous-runner.ts), not a prefix of this list behind this runner. That runner predates floors — the
// version alone is its rule — which is the one-time consequence §11.1 states: the floor row this version writes
// protects only builds that know it, and every build from before this PR refuses a database above its list, floor or
// not. This PR adds no hub migration, so the parent build's list is this one and it opens; the first PR after this
// one that adds a migration leaves the parent build refusing.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { previousRunner, type PreviousRunner } from "../../../scripts/previous-runner.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/adapters/migrations.ts";

const LATEST = MIGRATIONS.length;
const refuse = (found: number, known: number) => new DatabaseFromFuture(found, known);

let cleanup: (() => void) | null = null;
afterEach(() => { cleanup?.(); cleanup = null; });

async function previousRun(): Promise<PreviousRunner> {
  const { migrate, done } = await previousRunner();
  cleanup = done;
  return migrate;
}

describe("the downgrade contract (§13)", () => {
  it("the parent build opens a database this version migrated: this PR adds no migration, only the floor row", async () => {
    const db = new Database(":memory:");
    const parent = await previousRun();
    expect(migrate(db)).toEqual({ from: 0, to: LATEST });              // this version migrated it, floor row and all
    expect(db.prepare("SELECT floor FROM _morndo_schema WHERE id = 1").get()).toEqual({ floor: 0 });
    expect(parent(db, MIGRATIONS, refuse)).toEqual({ from: LATEST, to: LATEST });   // the parent build opens, runs nothing
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);  // as it was: it leaves the floor row alone, unread
    db.close();
  });

  it("a build from before the floors refuses a database above its list, whatever the floor row says (§11.1)", async () => {
    const db = new Database(":memory:");
    const parent = await previousRun();
    expect(migrate(db)).toEqual({ from: 0, to: LATEST });
    const older = MIGRATIONS.slice(0, LATEST - 1);                     // a hub that knows one migration less
    expect(migrate(db, older)).toEqual({ from: LATEST, to: LATEST });  // this runner opens it: the floor (0) allows
    expect(() => parent(db, older, refuse)).toThrow(DatabaseFromFuture);
    expect(() => parent(db, older, refuse)).toThrow(
      new RegExp(`version ${LATEST}, but this hub knows migrations only up to ${LATEST - 1}`),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);  // the refusal changed nothing
    db.close();
  });
});
