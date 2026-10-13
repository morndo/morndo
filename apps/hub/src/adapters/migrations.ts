// Numbered schema migrations for the hub's SQLite database (ADR-0008, A1). Design reference, not code: Signal-Desktop
// ts/sql/migrations/index.node.ts. The schema version is SQLite's user_version; every pending migration runs in one
// transaction that also sets the version and the schema floor, so a failure leaves the database as it was; a database
// written by a newer hub is refused rather than guessed at, unless the floor (ADR-0019 §11.1) says every migration up
// to its version was additive — then it opens as it is.
import type Database from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";
import { MIGRATION_LIST } from "./migration-list.ts";

export type { Migration };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this hub knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

const hasColumn = (db: Database.Database, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);

// Each migration can run on a database that already has its change (a hub from before numbered migrations created
// these tables itself and left user_version at 0), so it checks before it changes anything.
const UPS: { up: Migration["up"] }[] = [
  {
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_tokens (
        id TEXT PRIMARY KEY, secret_hash TEXT UNIQUE NOT NULL, issued_by TEXT NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER, redeemed_by TEXT);
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_id TEXT UNIQUE NOT NULL, public_key BLOB NOT NULL,
        counter INTEGER NOT NULL, transports TEXT NOT NULL, paired_at INTEGER NOT NULL, paired_with TEXT NOT NULL,
        last_seen_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id), started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (escalation_id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);
    `),
  },
  {
    up: db => { if (!hasColumn(db, "sessions", "verified_at")) db.exec("ALTER TABLE sessions ADD COLUMN verified_at INTEGER"); },
  },
  {
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS sends (
      key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('started', 'done')), outcome TEXT, at INTEGER NOT NULL)`),
  },
  {
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS read_marks (conversation TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_prefs (conversation TEXT PRIMARY KEY, muted INTEGER NOT NULL DEFAULT 0);
    `),
  },
  {
    up: db => {
      if (!hasColumn(db, "pairing_tokens", "code")) db.exec("ALTER TABLE pairing_tokens ADD COLUMN code TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS link_requests (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, token_secret_hash TEXT NOT NULL, code TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, requester TEXT NOT NULL,
        token_id TEXT, decided_by TEXT, pinned TEXT, proof TEXT)`);
    },
  },
  {
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_id TEXT PRIMARY KEY, url TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    up: db => { if (!hasColumn(db, "sends", "typed_at")) db.exec("ALTER TABLE sends ADD COLUMN typed_at INTEGER"); },
  },
  {
    up: db => db.exec("CREATE TABLE IF NOT EXISTS ask_first_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)"),
  },
  {
    up: db => { if (!hasColumn(db, "sends", "node_store")) db.exec("ALTER TABLE sends ADD COLUMN node_store TEXT"); },
  },
  {
    up: db => {
      if (!hasColumn(db, "sends", "worker_id")) db.exec("ALTER TABLE sends ADD COLUMN worker_id TEXT");
      if (!hasColumn(db, "sends", "request")) db.exec("ALTER TABLE sends ADD COLUMN request TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS sends_request ON sends (request)");
    },
  },
  {
    up: db => { if (!hasColumn(db, "sends", "node_store_seq")) db.exec("ALTER TABLE sends ADD COLUMN node_store_seq INTEGER"); },
  },
  {
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS board_tasks (
        key TEXT PRIMARY KEY, n INTEGER UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
        assignee TEXT, priority TEXT NOT NULL, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        created_by TEXT NOT NULL, rev INTEGER NOT NULL, done_at INTEGER, comments INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS board_tasks_status ON board_tasks (status, assignee);
      CREATE TABLE IF NOT EXISTS board_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, rev INTEGER NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, change TEXT NOT NULL,
        UNIQUE (key, rev));
      CREATE TABLE IF NOT EXISTS agent_tokens (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, secret_hash TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
    `),
  },
  {
    up: db => db.exec("CREATE TABLE IF NOT EXISTS usage_accounts (account TEXT PRIMARY KEY, body TEXT NOT NULL, reported_at INTEGER NOT NULL)"),
  },
  {
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS pending_answers (
      key TEXT PRIMARY KEY, escalation_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    up: db => db.exec("CREATE TABLE IF NOT EXISTS job_notices (id TEXT PRIMARY KEY, result TEXT NOT NULL)"),
  },
  {
    up: db => { if (!hasColumn(db, "job_notices", "acked")) db.exec("ALTER TABLE job_notices ADD COLUMN acked INTEGER NOT NULL DEFAULT 0"); },
  },
];
if (UPS.length !== MIGRATION_LIST.length) throw new Error("migration list and up functions differ");
export const MIGRATIONS: readonly Migration[] = MIGRATION_LIST.map((row, i) => {
  const step = UPS[i];
  if (!step) throw new Error(`migration ${row.version} has no up function`);
  return { version: row.version, name: row.name, compat: row.compat, up: step.up };
});

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

// Runs every migration newer than the database's user_version, in order, in one IMMEDIATE transaction that ends by
// setting user_version and the floor. Throws DatabaseFromFuture, changing nothing, if the database's floor is above
// this hub (§11.1). Every migration so far is additive, so the hub's floor is 0.
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
