// Schema floors for the connections store (ADR-0019, docs/design/updates/README.md §11.1): the store has no service
// that could be stopped for an update — its helper runs whenever an agent CLI needs a key — so its migrations are
// additive forever and the floor stays at 0: a newer version's store opens here; a breaking one (which must never
// exist, see the additive linter) is refused before any write.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFloor } from "@morndo/service-kit";
import { DatabaseFromFuture, MIGRATIONS } from "../src/adapters/store-migrations.ts";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";

const LATEST = MIGRATIONS.length;
const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A store as the next version leaves it: this version's schema, plus that version's migration LATEST+1.
function newerStore(floor: number): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-connections-floors-"));
  dirs.push(dir);
  const file = join(dir, "connections.db");
  const made = new SqliteStore(file);                    // the real open path builds today's schema
  made.close();
  const raw = new Database(file);
  raw.exec("CREATE TABLE future_addition (x)");          // the next version's migration LATEST+1 …
  writeFloor(raw, floor);
  raw.pragma(`user_version = ${LATEST + 1}`);
  raw.close();
  return file;
}

describe("the connections store's schema floor", () => {
  it("a newer, compatible database opens without migrating, and the helper can still read the store", () => {
    const file = newerStore(0);                          // every migration up to LATEST+1 was additive
    const seen: number[] = [];                           // afterOpen sees the database as it was found
    const store = new SqliteStore(file, undefined, { afterOpen: db => seen.push(version(db)) });
    expect(seen).toEqual([LATEST + 1]);                  // opened at the newer version, no refusal
    expect(store.load().directory.connections).toEqual([]);
    store.close();
    const raw = new Database(file);
    expect(version(raw)).toBe(LATEST + 1);               // and it stayed: nothing migrated, neither back nor forward
    raw.close();
  });

  it("a newer, breaking database is refused before any write: the file byte for byte untouched", () => {
    const file = newerStore(LATEST + 1);                 // migration LATEST+1 was breaking
    const before = sha(file);
    let caught: unknown;
    try { new SqliteStore(file); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseFromFuture);
    expect(String(caught)).toMatch(
      new RegExp(`version ${LATEST + 1}, but this store knows migrations only up to ${LATEST}`),
    );
    expect(sha(file)).toBe(before);                      // the file itself: the store is WAL-mode, and a read-only
    // probe of a WAL database opens its -shm/-wal beside it; the bytes of the database don't move.
  });
});
