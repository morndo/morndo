// Schema floors for the agent's database (ADR-0019, docs/design/updates/README.md §11.1): every agent migration so far
// is additive, so a newer agent's database opens here with its floor at 0; a breaking migration raises the floor above
// what this agent knows and the database is refused before any write (exit 78 in main.ts, RL8).
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFloor } from "@morndo/service-kit";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "../src/db/migrations.ts";
import { openAgentDb } from "../src/db/open.ts";
import { tempHome } from "./helpers.ts";

const LATEST = MIGRATIONS.length;
const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

// A database as the next version leaves it: this agent's schema, plus that version's migration LATEST+1.
function newerDb(floor: number): string {
  const home = tempHome();
  homes.push(home);
  const path = join(home.home, "state", "agent.db");
  mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  migrate(raw);
  raw.exec("CREATE TABLE future_addition (x)");          // the next version's migration LATEST+1 …
  writeFloor(raw, floor);
  raw.pragma(`user_version = ${LATEST + 1}`);
  raw.close();
  return path;
}

describe("the agent database's schema floor", () => {
  it("a newer, compatible database opens without migrating: its stream and keys keep working", () => {
    const path = newerDb(0);                             // every migration up to LATEST+1 was additive
    const a = openAgentDb(path);                         // the real open path
    expect(version(a.db)).toBe(LATEST + 1);              // nothing ran: neither back nor forward
    expect(tables(a.db)).toContain("future_addition");
    expect(a.db.prepare("SELECT one, seq FROM store_seq").all()).toEqual([{ one: 1, seq: 0 }]);
    expect(a.streamId).toMatch(/^[0-9a-f-]{36}$/);       // the agent works on what it knows
    a.close();
  });

  it("a newer, breaking database is refused before any write: byte for byte untouched, no -wal or -shm", () => {
    const path = newerDb(LATEST + 1);                    // migration LATEST+1 was breaking
    const before = sha(path);
    let caught: unknown;
    try { openAgentDb(path); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(DatabaseFromFuture);
    expect(String(caught)).toMatch(
      new RegExp(`version ${LATEST + 1}, but this agent knows migrations only up to ${LATEST}`),
    );
    expect(sha(path)).toBe(before);                      // journal_mode=WAL alone would change the header
    expect(existsSync(`${path}-wal`) || existsSync(`${path}-shm`)).toBe(false);
  });
});
