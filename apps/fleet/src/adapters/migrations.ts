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
  {
    version: 15,
    name: "fleet clients: the deliveries' mirror, sticky lane names, lane events (fleet clients spec §4.6, §7)",
    compat: "additive",
    up: db => db.exec(`
      -- The latest state of each delivery its node reported (ev.delivery, or the answer to lane.deliver and
      -- delivery.cancel): never its text. target: {"lane":…} or {"workerId":…} as JSON; body: the Delivery as JSON.
      -- alerted: how many of LIMITS.deliveryAlertMs's thresholds raised delivery_waiting for it (0 to 3).
      -- Not synced (spec §6). Named lane_deliveries: the hook bus's own table is deliveries (migration 1).
      CREATE TABLE IF NOT EXISTS lane_deliveries (
        id TEXT PRIMARY KEY, node TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
        updated_at INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS lane_deliveries_by_updated ON lane_deliveries (updated_at);
      -- The node that last reported a window of each sticky lane name (stickyLanes). Not synced.
      CREATE TABLE IF NOT EXISTS sticky_lanes (name TEXT PRIMARY KEY, node TEXT NOT NULL, at INTEGER NOT NULL);
      -- Lane events (spec §7), written in the synced intake with the hooks they come from. at: the hook's time on its
      -- node; body: the event's own fields as JSON. to_manager: 0 waiting for the manager, 1 in a delivery its node
      -- stored, NULL not for the manager. delivery_id: the delivery that carries it while to_manager is 1.
      CREATE TABLE IF NOT EXISTS lane_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, window TEXT, lane TEXT, session_id TEXT, event TEXT NOT NULL,
        at INTEGER NOT NULL, body TEXT NOT NULL, to_manager INTEGER CHECK (to_manager IN (0, 1)), delivery_id TEXT);
      CREATE INDEX IF NOT EXISTS lane_events_waiting ON lane_events (seq) WHERE to_manager = 0;
      CREATE INDEX IF NOT EXISTS lane_events_by_delivery ON lane_events (delivery_id) WHERE delivery_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS lane_events_by_at ON lane_events (at);
      -- A session's latest lane event (a needs_input repeated after an agent restart is dropped).
      CREATE INDEX IF NOT EXISTS lane_events_by_session ON lane_events (session_id, seq) WHERE session_id IS NOT NULL;
    `),
  },
  {
    version: 16,
    name: "the Rollout the fleet carries (updates §4.2, §7): one row per Version, the halted state durable",
    compat: "additive",
    up: db => db.exec(`
      -- The Rollout of each Version the control plane committed (rollouts). halt_* are set when a node's rollback
      -- stopped it (RL12) and cleared by a resume; they are synced (a halt must outlive the machine), so the fleet
      -- answers GET /v1/rollout with the same Rollout after a restart. resumed_at: the last resume, for the audit's
      -- story. No CHECK constraints (the additive lint's rule) — the application service holds the words.
      CREATE TABLE IF NOT EXISTS rollouts (
        version TEXT PRIMARY KEY, control_plane_committed_at INTEGER, soak_minutes INTEGER NOT NULL DEFAULT 30,
        halted INTEGER NOT NULL DEFAULT 0, halted_by TEXT, halt_reason TEXT, halted_at INTEGER, resumed_at INTEGER,
        updated_at INTEGER NOT NULL DEFAULT 0);
      -- Every attempt id the fleet issued (rollout_attempts, review of #107 round 4): one per machine and Version it
      -- offered (a Rollout a node may follow, an update.apply forwarded to it, the control plane's own announced
      -- apply), random, spent (used_at) when a rollback report under it is accepted. A report halts only under an
      -- issued, unspent id for that machine and Version. Pruned after 30 days, the newest offer of each kept.
      CREATE TABLE IF NOT EXISTS rollout_attempts (attempt TEXT PRIMARY KEY, machine TEXT NOT NULL, version TEXT NOT NULL,
        issued_at INTEGER NOT NULL DEFAULT 0, used_at INTEGER);
    `),
  },
  {
    version: 17,
    name: "a node's last hello protocols (review of #111): the skew gate counts an offline node too",
    compat: "additive",
    up: db => db.exec(`
      -- The agent protocols a node's last hello named, as JSON (nodes.last_proto): an offline node still depends on
      -- them, so GET /v1/nodes reports them when it is offline and the control plane's skew gate counts them (RL11).
      ALTER TABLE nodes ADD COLUMN last_proto TEXT;
    `),
  },
  {
    version: 18,
    name: "a node's enrolment: which join made its key, so a revocation names the enrolment it revoked (RL10)",
    compat: "additive",
    // A node keeps its name across a revoke and a join again; the revocation journal (updates design §11.5) keys a
    // node's revocation by this, so it never revokes the next enrolment under the same name. Rows from before get one
    // of their own now, as if each had joined once.
    up: db => db.exec(`
      ALTER TABLE nodes ADD COLUMN enrolment TEXT;
      UPDATE nodes SET enrolment = lower(hex(randomblob(16))) WHERE enrolment IS NULL;`),
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

// Runs every migration newer than the database's user_version, in order, in one IMMEDIATE transaction that ends by
// setting user_version and the floor. Throws DatabaseFromFuture, changing nothing, if the database's floor is above
// this service (§11.1). Migration 7 is the newest breaking one, so the fleet's floor is 7.
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
