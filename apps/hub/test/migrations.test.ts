// Numbered schema migrations (ADR-0008, A1; design reference: Signal-Desktop ts/sql/migrations/index.node.ts): the
// schema version lives in SQLite's user_version, pending migrations run in one transaction, and a database from a
// newer hub is refused. Real SQLite files in a temp dir.
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseFromFuture, MIGRATIONS, migrate, type Migration } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-migrate-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LATEST = MIGRATIONS.at(-1)?.version ?? 0;
const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const columns = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

// The schema exactly as the hub created it before numbered migrations (store.ts at 87353d6), user_version left at 0.
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS pairing_tokens (
    id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, issued_by TEXT NOT NULL,
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER, redeemed_by TEXT);
  CREATE TABLE IF NOT EXISTS endpoints (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_id TEXT UNIQUE NOT NULL, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL, transports TEXT NOT NULL, paired_at INTEGER NOT NULL, paired_with TEXT NOT NULL,
    last_seen_at INTEGER, revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id), started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT, verified_at INTEGER);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (escalation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);
`;
// The same, from before ADR-0006 added sessions.verified_at.
const LEGACY_V1_DDL = LEGACY_DDL.replace(", end_reason TEXT, verified_at INTEGER)", ", end_reason TEXT)");

function legacyDb(dir: string, ddl = LEGACY_DDL) {
  const db = new Database(join(dir, "morndo.db"));
  db.transaction(() => {                                               // one commit: a fixture, built fast on a busy disk
    db.exec(ddl);
    db.prepare("INSERT INTO endpoints VALUES ('e1', 'phone', 'cred', x'01', 3, '[]', 1, 't1', 2, NULL)").run();
    db.prepare("INSERT INTO audit (at, type, body) VALUES (1, 'EndpointPaired', '{}')").run();
  })();
  return db;
}

// One limit for the whole file: these open real database files and spawn a hub, and a busy box's disk syncs have
// stalled them past 5 s (taking under a second alone).
describe("numbered migrations (user_version)", { timeout: 30_000 }, () => {
  it("a fresh database gets every migration and ends at the latest version", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    expect(version(db)).toBe(0);
    expect(migrate(db)).toEqual({ from: 0, to: LATEST });
    expect(version(db)).toBe(LATEST);
    expect(tables(db)).toEqual(expect.arrayContaining(["audit", "decisions", "endpoints", "pairing_tokens", "sessions", "settings"]));
    expect(columns(db, "sessions")).toContain("verified_at");
    expect(migrate(db)).toEqual({ from: LATEST, to: LATEST });          // nothing pending: a no-op
  });

  it("migration 1 is today's schema and migration 2 is sessions.verified_at", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));    // numbered 1, 2, 3, … with no gaps
    expect(MIGRATIONS[0]?.name).toMatch(/schema/);
    expect(MIGRATIONS[1]?.name).toMatch(/verified_at/);
  });

  it("a legacy database with today's exact schema and user_version 0 migrates without losing a row", () => {
    const db = legacyDb(tempDir());
    expect(version(db)).toBe(0);
    expect(migrate(db)).toEqual({ from: 0, to: LATEST });              // migration 2 sees verified_at and changes nothing
    expect(version(db)).toBe(LATEST);
    expect(db.prepare("SELECT name, counter FROM endpoints").all()).toEqual([{ name: "phone", counter: 3 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit").get()).toEqual({ n: 1 });
  });

  it("a legacy database from before verified_at gets the column from migration 2", () => {
    const db = legacyDb(tempDir(), LEGACY_V1_DDL);
    expect(columns(db, "sessions")).not.toContain("verified_at");
    migrate(db);
    expect(columns(db, "sessions")).toContain("verified_at");
    expect(version(db)).toBe(LATEST);
  });

  it("refuses a database from a newer hub, and leaves it untouched", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    db.exec("CREATE TABLE future_thing (x)");
    db.pragma(`user_version = ${LATEST + 5}`);
    expect(() => migrate(db)).toThrow(DatabaseFromFuture);
    expect(() => migrate(db)).toThrow(new RegExp(`version ${LATEST + 5}.*up to ${LATEST}`));
    expect(version(db)).toBe(LATEST + 5);
    expect(tables(db)).toEqual(["future_thing"]);
  });

  it("a failing migration rolls back every migration of the run, user_version included", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    const failing: Migration[] = [
      ...MIGRATIONS,
      { version: LATEST + 1, name: "half done, then fails", compat: "additive", up: d => { d.exec("CREATE TABLE half (x)"); throw new Error("boom"); } },
    ];
    expect(() => migrate(db, failing)).toThrow(/boom/);
    expect(version(db)).toBe(0);
    expect(tables(db)).toEqual([]);                                    // not even migration 1's tables
  });

  // Final review C1: an escalation answer in doubt keeps the worker it went to and the request that sent it.
  it("migration 11 gives a database at 10 sends.worker_id and sends.request, keeps its rows, and changes nothing run again", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 10));
    expect(version(db)).toBe(10);
    db.prepare("INSERT INTO sends (key, state, at, node_store) VALUES ('ep1:r1', 'started', 5, 'store-a')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 11))).toEqual({ from: 10, to: 11 });
    expect(columns(db, "sends")).toEqual(expect.arrayContaining(["worker_id", "request"]));
    expect(db.prepare("SELECT key, node_store, worker_id, request FROM sends").all()).toEqual([{ key: "ep1:r1", node_store: "store-a", worker_id: null, request: null }]);
    expect(() => MIGRATIONS[10]?.up(db)).not.toThrow();               // guarded: its columns and index are there already
  });

  // Final review I2: a send or an answer in doubt keeps the store sequence its store's answer gave.
  it("migration 12 gives a database at 11 sends.node_store_seq, keeps its rows, and changes nothing run again", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 11));
    expect(version(db)).toBe(11);
    db.prepare("INSERT INTO sends (key, state, at, node_store, worker_id, request) VALUES ('answer:ny-7:m1:option:ship', 'started', 5, 'store-a', 'pc.aaaaaaaa.0', 'ep1:r1')").run();
    expect(migrate(db, MIGRATIONS.slice(0, 12))).toEqual({ from: 11, to: 12 });
    expect(columns(db, "sends")).toContain("node_store_seq");
    expect(db.prepare("SELECT key, node_store, node_store_seq, worker_id, request FROM sends").all())
      .toEqual([{ key: "answer:ny-7:m1:option:ship", node_store: "store-a", node_store_seq: null, worker_id: "pc.aaaaaaaa.0", request: "ep1:r1" }]);
    expect(() => MIGRATIONS[11]?.up(db)).not.toThrow();               // guarded: its column is there already
  });

  // ADR-0015: the board's tables and the agent tokens.
  it("migration 13 gives a database at 12 the board's tables, and changes nothing run again", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 12));
    expect(version(db)).toBe(12);
    expect(migrate(db, MIGRATIONS.slice(0, 13))).toEqual({ from: 12, to: 13 });
    expect(tables(db)).toEqual(expect.arrayContaining(["board_tasks", "board_events", "agent_tokens"]));
    expect(columns(db, "board_tasks")).toEqual(expect.arrayContaining(["key", "n", "status", "assignee", "rev", "done_at", "comments"]));
    expect(() => MIGRATIONS[12]?.up(db)).not.toThrow();
  });

  // ADR-0016: the accounts' usage.
  it("migration 14 gives a database at 13 usage_accounts, and changes nothing run again", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 13));
    expect(migrate(db, MIGRATIONS.slice(0, 14))).toEqual({ from: 13, to: 14 });
    expect(tables(db)).toContain("usage_accounts");
    expect(tables(db)).not.toContain("pending_answers");
    expect(() => MIGRATIONS[13]?.up(db)).not.toThrow();
  });

  it("migration 16 records one notice claim per job, and changes nothing run again", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 15));
    expect(migrate(db, MIGRATIONS.slice(0, 16))).toEqual({ from: 15, to: 16 });
    expect(tables(db)).toContain("job_notices");
    expect(() => MIGRATIONS[15]?.up(db)).not.toThrow();
  });

  it("migration 17 remembers which board results the fleet has not acknowledged", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 16));
    expect(migrate(db, MIGRATIONS.slice(0, 17))).toEqual({ from: 16, to: 17 });
    expect(columns(db, "job_notices")).toEqual(["id", "result", "acked"]);
    expect(() => MIGRATIONS[16]?.up(db)).not.toThrow();
  });

  it("the Store migrates the database it opens", () => {
    const dir = tempDir();
    legacyDb(dir).close();
    const store = new Store(dir);
    expect(version(store.db)).toBe(LATEST);
    store.close();
  });

  it("a database at main's version 14 gains pending_answers at 15, and a v14 hub opens that database: its floor is 0", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    const v14 = MIGRATIONS.slice(0, 14);
    expect(v14.at(-1)?.version).toBe(14);
    expect(migrate(db, v14)).toEqual({ from: 0, to: 14 });
    expect(tables(db)).toContain("usage_accounts");
    expect(tables(db)).not.toContain("pending_answers");
    expect(migrate(db, MIGRATIONS.slice(0, 15))).toEqual({ from: 14, to: 15 });
    expect(tables(db)).toContain("pending_answers");
    expect(version(db)).toBe(15);
    // Migration 15 is additive, so the floor stayed at 0 and the v14 hub opens the database without running anything
    // (§11.1); a database whose floor was above 14 is what schema-floors.test.ts refuses.
    expect(migrate(db, v14)).toEqual({ from: 15, to: 15 });
    expect(version(db)).toBe(15);
    expect(tables(db)).toContain("pending_answers");
  });

  it("the hub exits with a clear message when its database is from a newer hub", () => {
    const dir = tempDir();
    const db = new Database(join(dir, "morndo.db"));
    db.pragma(`user_version = ${LATEST + 1}`);
    db.close();
    const main = join(import.meta.dirname, "../src/main.ts");
    const r = spawnSync(process.execPath, ["--no-warnings", main, "devices"], { env: { ...process.env, MORNDO_HOME: dir }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(78);                                         // EX_CONFIG: not a crash to restart into (review L5)
    expect(r.stderr).toMatch(new RegExp(`newer Morndo.*version ${LATEST + 1}.*up to ${LATEST}`, "s"));
    expect(r.stderr).not.toMatch(/\n\s+at /);                         // a message, not a stack trace
  });
});
