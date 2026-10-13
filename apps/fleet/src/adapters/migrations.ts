// Numbered schema migrations for fleet.db, in the style of the hub's (apps/hub/src/adapters/migrations.ts, ADR-0008
// A1): the version is SQLite's user_version; every pending migration runs in one IMMEDIATE transaction that also sets
// the version and the schema floor, so a failure leaves the database as it was; a database written by a newer fleet
// service is refused, unless the floor (ADR-0019 §11.1) says every migration up to its version was additive.
import type Database from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

export type { Migration };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this fleet service knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "the fleet schema: nodes, join codes, stream marks, lanes, the hook outbox, dead letters, audit (ADR-0012)",
    compat: "additive",
    up: db => db.exec(`
      -- conn_epoch: the number of the node's latest welcome, a fencing token that only grows, across restarts too.
      CREATE TABLE nodes (
        name TEXT PRIMARY KEY, public_key TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
        last_seen_at INTEGER, last_source TEXT, agent_version TEXT, conn_epoch INTEGER NOT NULL DEFAULT 0);
      -- Only the SHA-256 of a code is kept (spec 5.1).
      CREATE TABLE join_codes (hash TEXT PRIMARY KEY, node TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE stream_hwm (node TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (node, stream_id));
      CREATE TABLE lanes (
        name TEXT PRIMARY KEY, node TEXT NOT NULL, worker_id TEXT, registered_at INTEGER NOT NULL, conflict INTEGER NOT NULL DEFAULT 0);
      -- body: the whole hook event as JSON, exactly what each subscriber is sent.
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL,
        path TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (node, stream_id, seq));
      CREATE TABLE deliveries (
        outbox_id INTEGER NOT NULL REFERENCES outbox(id) ON DELETE CASCADE, subscriber TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead', 'dropped')), attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY (outbox_id, subscriber));
      CREATE INDEX deliveries_by_subscriber ON deliveries (subscriber, state);
      CREATE TABLE dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT, subscriber TEXT NOT NULL, node TEXT NOT NULL, stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, attempts INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, node TEXT, detail TEXT NOT NULL);
      -- alerts by kind (GET /v1/alerts) and the 90-day retention, without a scan of every op the audit keeps
      CREATE INDEX audit_by_action ON audit (action, seq);
      CREATE INDEX audit_by_at ON audit (at);
    `),
  },
  {
    version: 2,
    name: "hook events no subscriber takes, counted per path (final review I3; ADR-0012 decision 8)",
    compat: "additive",
    up: db => db.exec(`
      -- Acknowledged to the node and stored for no one: counted, so they are never lost silently (morndo-fleet status).
      CREATE TABLE hook_unrouted (path TEXT PRIMARY KEY, count INTEGER NOT NULL, latest_at INTEGER NOT NULL);
    `),
  },
  {
    version: 3,
    name: "the highest store sequence each agent database has shown, per node and store (fleet core §5.2, §5.3; the fix wave's follow-up)",
    compat: "additive",
    up: db => db.exec(`
      -- Sent in the welcome as storeSeqSeen: an agent whose database is behind it was put back from an older copy.
      CREATE TABLE IF NOT EXISTS store_seqs (
        node TEXT NOT NULL, store TEXT NOT NULL, seq INTEGER NOT NULL CHECK (seq >= 0), at INTEGER NOT NULL, PRIMARY KEY (node, store));
    `),
  },
  {
    version: 4,
    name: "the pending deliveries alone, per subscriber in outbox order, for the backlog cap (B6 EF3)",
    compat: "additive",
    up: db => db.exec(`
      -- A partial index (https://www.sqlite.org/partialindex.html): only rows still to deliver are in it, in outbox
      -- order, so the backlog cap finds a subscriber's oldest pending progress event without sorting its whole backlog.
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (subscriber, outbox_id) WHERE state = 'pending';
    `),
  },
  {
    version: 5,
    name: "a job row the fleet may show (ADR-0017, ADR-0014): state, never the command line",
    compat: "additive",
    up: db => db.exec(`
      -- No argv, command, cwd, env or token column. The tail is the redacted tail the node already sent.
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        node TEXT NOT NULL,
        lane TEXT NOT NULL,
        name TEXT NOT NULL,
        class TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        exit_code INTEGER,
        duration_sec REAL,
        notify TEXT NOT NULL,
        task TEXT,
        notice TEXT NOT NULL,
        at INTEGER NOT NULL,
        tail TEXT NOT NULL,
        position INTEGER,
        reason TEXT,
        error TEXT
      );
    `),
  },
  {
    version: 6,
    name: "one routed notice id per job (ADR-0014): the text stays on the node that types it",
    compat: "additive",
    up: db => db.exec(`
      -- The destination node stores the text. This row is only the id, the job and the node that types it.
      CREATE TABLE job_routes (
        notice_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        dest_node TEXT NOT NULL
      );
    `),
  },
  {
    version: 7,
    name: "a job is (node, id): two nodes may use the same id, and a notice id names the node that ran it",
    compat: "breaking",                                                // it drops and rebuilds the jobs tables (§11.2): the fleet's floor
    up: db => db.exec(`
      CREATE TABLE jobs_keyed (
        node TEXT NOT NULL,
        id TEXT NOT NULL,
        lane TEXT NOT NULL,
        name TEXT NOT NULL,
        class TEXT NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        exit_code INTEGER,
        duration_sec REAL,
        notify TEXT NOT NULL,
        task TEXT,
        notice TEXT NOT NULL,
        at INTEGER NOT NULL,
        tail TEXT NOT NULL,
        position INTEGER,
        reason TEXT,
        error TEXT,
        PRIMARY KEY (node, id)
      );
      INSERT INTO jobs_keyed (
        node, id, lane, name, class, state, outcome, exit_code, duration_sec, notify, task, notice, at, tail, position, reason, error
      ) SELECT
        node, id, lane, name, class, state, outcome, exit_code, duration_sec, notify, task, notice, at, tail, position, reason, error
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_keyed RENAME TO jobs;
      CREATE TABLE job_routes_keyed (
        notice_id TEXT PRIMARY KEY,
        node TEXT NOT NULL,
        job_id TEXT NOT NULL,
        dest_node TEXT NOT NULL
      );
      INSERT INTO job_routes_keyed (notice_id, node, job_id, dest_node)
        SELECT 'node:job:' || j.node || ':' || r.job_id || ':done', j.node, r.job_id, r.dest_node
        FROM job_routes r JOIN jobs j ON j.id = r.job_id;
      DROP TABLE job_routes;
      ALTER TABLE job_routes_keyed RENAME TO job_routes;
    `),
  },
  {
    version: 8,
    name: "one job_failed alert per (node, id) (ADR-0017): a replay of ev.job does not raise it again",
    compat: "additive",
    up: db => db.exec("CREATE TABLE job_alerts (node TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (node, id));"),
  },
  {
    version: 9,
    name: "a job's real end time, separate from the observation stamp (ADR-0017)",
    compat: "additive",
    up: db => db.exec("ALTER TABLE jobs ADD COLUMN ended INTEGER;"),
  },
  {
    version: 10,
    name: "job_failed starts when this fleet learned to alert, not from jobs that already ended (ADR-0017)",
    compat: "additive",
    up: db => {
      db.exec("CREATE TABLE job_alert_since (at INTEGER NOT NULL);");
      db.prepare("INSERT INTO job_alert_since (at) VALUES (?)").run(Date.now());
    },
  },
  {
    version: 11,
    name: "one job_unnoticed alert per (node, id) (ADR-0017): a given_up notice raises it once",
    compat: "additive",
    up: db => db.exec("CREATE TABLE job_unnoticed (node TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (node, id));"),
  },
  {
    version: 12,
    name: "an index for the notice retry: which job a route belongs to",
    compat: "additive",
    up: db => { db.exec("CREATE INDEX job_routes_job ON job_routes(node, job_id)"); },
  },
  {
    version: 13,
    name: "the node a job notice was aimed at when the job finished",
    compat: "additive",
    up: db => { db.exec("ALTER TABLE jobs ADD COLUMN notice_dest TEXT"); },
  },
  {
    version: 14,
    name: "the notice the node has already confirmed, so a welcome does not send it again",
    compat: "additive",
    up: db => { db.exec("ALTER TABLE jobs ADD COLUMN node_notice TEXT"); },
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

// Runs every migration newer than the database's user_version, in order, in one IMMEDIATE transaction that ends by
// setting user_version and the floor. Throws DatabaseFromFuture, changing nothing, if the database's floor is above
// this service (§11.1). Migration 7 is the newest breaking one, so the fleet's floor is 7.
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
