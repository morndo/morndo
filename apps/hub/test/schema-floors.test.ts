// Schema floors for the hub's database (ADR-0019, docs/design/updates/README.md §11.1): a newer hub's additive
// migrations leave the floor where it was, so this hub opens what they wrote, runs no migration and leaves alone what
// it doesn't know; a breaking migration raises the floor, and this hub refuses the database (exit 78 in main.ts)
// rather than guess at a schema it doesn't know (RL8). Until the runner writes floors itself, these tests build the
// one-row `_morndo_schema` table by hand, exactly as a newer version leaves it.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";

const LATEST = MIGRATIONS.at(-1)?.version ?? 0;
const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tableNames = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);

// The floor row a newer hub leaves behind: every hub migration so far is additive, so the floor stays at 0.
function withFloor(db: Database.Database, floor: number): void {
  db.exec("CREATE TABLE IF NOT EXISTS _morndo_schema (id INTEGER PRIMARY KEY CHECK (id = 1), floor INTEGER NOT NULL)");
  db.prepare("INSERT INTO _morndo_schema (id, floor) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET floor = excluded.floor").run(floor);
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A database as the next version leaves it: this hub's schema, plus that version's migration LATEST+1.
function newerDb(floor: number): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-hub-floors-"));
  dirs.push(dir);
  const raw = new Database(join(dir, "morndo.db"));
  migrate(raw);
  raw.exec("CREATE TABLE future_addition (x)");          // the next version's migration LATEST+1 …
  withFloor(raw, floor);
  raw.pragma(`user_version = ${LATEST + 1}`);
  raw.close();
  return dir;
}

describe("the hub's schema floor", () => {
  it("a newer, compatible database opens without migrating, and what this hub doesn't know is left alone", () => {
    const dir = newerDb(0);                              // every migration up to LATEST+1 was additive
    const store = new Store(dir);                        // the real open path
    expect(version(store.db)).toBe(LATEST + 1);          // nothing ran: neither back nor forward
    expect(tableNames(store.db)).toContain("future_addition");
    expect(store.setting("nothing-set")).toBeNull();     // the hub works on what it knows
    store.close();
  });

  it("a newer, breaking database is refused with one clear line, and left as it was", () => {
    const dir = newerDb(LATEST + 1);                     // migration LATEST+1 was breaking
    let caught: unknown;
    try { new Store(dir); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseFromFuture);
    expect(String(caught)).toMatch(
      new RegExp(`version ${LATEST + 1}, but this hub knows migrations only up to ${LATEST}`),
    );
    const after = new Database(join(dir, "morndo.db"));
    expect(version(after)).toBe(LATEST + 1);
    expect(tableNames(after)).toContain("future_addition");
    after.close();
  });
});
