// Numbered schema migrations for the agent's database, in the hub's pattern (apps/hub/src/adapters/migrations.ts,
// ADR-0008 A1): the schema version is SQLite's user_version; every pending migration runs in one IMMEDIATE transaction
// that ends by setting the version and the schema floor, so a failure leaves the database as it was; a database
// written by a newer agent is refused rather than guessed at, unless the floor (ADR-0019 §11.1) says every migration
// up to its version was additive — then it opens as it is.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

export type { Migration };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this agent knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "the agent's schema: meta (streamId), done keys, the hook stream, relay file copies (fleet-core spec §5.3–5.5, §6)",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE done_keys (
          key TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started', 'done')),
          outcome TEXT, at INTEGER NOT NULL);
        CREATE TABLE stream (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, path TEXT NOT NULL, session TEXT, window TEXT,
          coalesce_key TEXT, body TEXT NOT NULL, size INTEGER NOT NULL);
        CREATE INDEX stream_coalesce ON stream (coalesce_key) WHERE coalesce_key IS NOT NULL;
        CREATE TABLE relay_files (
          ref TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL,
          seq INTEGER, acked_at INTEGER);
      `);
      // The hook stream's identity is born with the database: a reset or reinstalled agent starts a new stream, so the
      // fleet never takes its first events for duplicates of the old stream's (spec §5.4).
      db.prepare("INSERT INTO meta (key, value) VALUES ('streamId', ?)").run(randomUUID());
    },
  },
  {
    version: 2,
    name: "store_seq: how many keyed ops this database has started, never lowered (fleet core §5.3; final review I2, the store sequence)",
    compat: "additive",
    // One row. It goes up by one in the transaction that commits each keyed op's `started` (done-keys.ts), and every
    // answer carries it, so a caller that saw a higher number from this store can tell a database put back from an older
    // copy in place (cp over the file, a VM snapshot), which keeps the file's identity and the stream id.
    up: db => {
      db.exec("CREATE TABLE store_seq (one INTEGER PRIMARY KEY CHECK (one = 1), seq INTEGER NOT NULL CHECK (seq >= 0))");
      db.exec("INSERT INTO store_seq (one, seq) VALUES (1, 0)");
    },
  },
  {
    version: 3,
    name: "jobs: one row per background job, hashes only, no command (ADR-0017)",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL,
          name TEXT NOT NULL,
          job_class TEXT NOT NULL,
          notify TEXT NOT NULL,
          command_hash TEXT NOT NULL,
          cwd_hash TEXT NOT NULL,
          accepted_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'exited', 'timed_out', 'cancelled', 'lost', 'refused')),
          position INTEGER CHECK (position IS NULL OR position >= 1),
          reason TEXT CHECK (reason IS NULL OR reason IN ('class', 'load', 'memory', 'guard_unknown')),
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('exited', 'timed_out', 'cancelled', 'lost', 'refused')),
          exit_code INTEGER CHECK (exit_code IS NULL OR (exit_code >= 0 AND exit_code <= 255)),
          duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          notice TEXT NOT NULL CHECK (notice IN ('none', 'pending', 'queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up', 'commented')),
          notice_id TEXT,
          error TEXT CHECK (error IS NULL OR error = 'did_not_start'),
          ended_at INTEGER,
          started_at INTEGER,
          CHECK (state != 'running' OR started_at IS NOT NULL),
          CHECK (state NOT IN ('queued', 'starting', 'running') OR (outcome IS NULL AND ended_at IS NULL AND notice = 'none' AND notice_id IS NULL)),
          CHECK (state IN ('queued', 'starting', 'running') OR (outcome = state AND ended_at IS NOT NULL AND notice_id IS NOT NULL AND notice != 'none'))
        );
      `);
    },
  },
  {
    version: 4,
    name: "job notices: one lane.deliver per notice id (ADR-0017)",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE job_deliveries (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL,
          text TEXT NOT NULL,
          typed INTEGER NOT NULL CHECK (typed IN (0, 1))
        );
      `);
    },
  },
  {
    version: 5,
    name: "job token cache: the lane and the hash only, for 24 hours (ADR-0017 decision 7)",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE token_cache (
          lane TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          checked_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 6,
    name: "a job keeps the notice text it showed, so a later notice change still has it",
    compat: "additive",
    up: db => { db.exec("ALTER TABLE jobs ADD COLUMN notice_text TEXT"); },
  },
  {
    version: 7,
    name: "deliveries: the delivery queue (fleet clients spec §4; plan Contracts, Databases; agent.db migration 7, after the jobs' 3 to 6)",
    compat: "additive",
    // One row per delivery, the text included (the fleet's mirror never holds it, spec §4.6). Storing a row is synced to
    // the disk (deliveries/store.ts, fleet core §16.4); every later change is an ordinary commit. rowid is the order
    // stored, so the table keeps SQLite's rowid (not WITHOUT ROWID).
    up: db => {
      db.exec(`
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          target_lane TEXT, target_worker TEXT, sticky INTEGER NOT NULL CHECK (sticky IN (0, 1)), bound_session TEXT,
          text TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up')),
          waiting_reason TEXT CHECK (waiting_reason IN ('menu_open', 'draft_present', 'no_input_box', 'busy', 'no_pane', 'no_session', 'earlier', 'unavailable')),
          waiting_since INTEGER, queued_at INTEGER NOT NULL, not_after INTEGER NOT NULL,
          typed_at INTEGER, typed_session TEXT, delivered_at INTEGER,
          why TEXT CHECK (why IN ('expired', 'cancelled', 'gone', 'refused')), note TEXT,
          retyped INTEGER NOT NULL DEFAULT 0 CHECK (retyped IN (0, 1)),
          updated_at INTEGER NOT NULL,
          CHECK ((target_lane IS NULL) <> (target_worker IS NULL)));
        CREATE INDEX deliveries_by_state ON deliveries (state, updated_at);
        CREATE INDEX deliveries_by_lane ON deliveries (target_lane) WHERE target_lane IS NOT NULL;
        CREATE INDEX deliveries_by_worker ON deliveries (target_worker) WHERE target_worker IS NOT NULL;
      `);
    },
  },
];

export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
