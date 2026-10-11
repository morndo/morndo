// Schema floors for fleet.db (ADR-0019, docs/design/updates/README.md §11.1): the fleet's migrations since 7 are
// additive, so a newer fleet service's database opens here with its floor (7, set when migration 7 rebuilt the jobs
// tables) as long as this service knows schema 7 or newer; a breaking migration raises the floor above what this
// service knows and the database is refused before any write (exit 78 in main.ts, RL8). Until the runner writes floors
// itself, these tests build the one-row `_morndo_schema` table by hand, exactly as a newer version leaves it.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb } from "../src/adapters/db.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { tempDir } from "./helpers/temp.ts";

const LATEST = MIGRATIONS.length;
// Migration 7 (a job is (node, id)) rebuilt the jobs tables: the last breaking fleet migration, so the fleet's floor.
const FLOOR = 7;
const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function withFloor(db: Database.Database, floor: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS _morndo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), floor INTEGER NOT NULL)");
  db.prepare("INSERT INTO _morndo_schema (id, floor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET floor = excluded.floor").run(floor);
}

// A database as the next version leaves it: this service's schema, plus that version's migration LATEST+1.
function newerDb(floor: number): string {
  const path = join(tempDir(), "fleet.db");
  const raw = new Database(path);
  migrate(raw);
  raw.exec("CREATE TABLE future_addition (x)");          // the next version's migration LATEST+1 …
  withFloor(raw, floor);
  raw.pragma(`user_version = ${LATEST + 1}`);
  raw.close();
  return path;
}

describe("fleet.db's schema floor", () => {
  it("a newer, compatible database opens without migrating: the floor (7) is at or below what this service knows", () => {
    const path = newerDb(FLOOR);                         // every migration after 7 was additive: the floor stayed
    const db = openFleetDb(path);                        // the real open path
    expect(version(db)).toBe(LATEST + 1);                // nothing ran: neither back nor forward
    expect(tables(db)).toContain("future_addition");
    expect(db.prepare("SELECT name FROM nodes").all()).toEqual([]);   // the service works on what it knows
    db.close();
  });

  it("a newer, breaking database is refused before any write: byte for byte untouched, no -wal or -shm", () => {
    const path = newerDb(LATEST + 1);                    // migration LATEST+1 was breaking
    const before = sha(path);
    let caught: unknown;
    try { openFleetDb(path); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseFromFuture);
    expect(String(caught)).toMatch(
      new RegExp(`version ${LATEST + 1}, but this fleet service knows migrations only up to ${LATEST}`),
    );
    expect(sha(path)).toBe(before);                      // journal_mode=WAL alone would change the header
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });
});
