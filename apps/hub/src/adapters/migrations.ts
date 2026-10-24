// Numbered schema migrations for the hub's SQLite database (ADR-0008, A1). Design reference, not code: Signal-Desktop
// ts/sql/migrations/index.node.ts. The schema version is SQLite's user_version; every pending migration runs in one
// transaction that also sets the version and the schema floor, so a failure leaves the database as it was; a database
// written by a newer hub is refused rather than guessed at, unless the floor (ADR-0019 §11.1) says every migration up
// to its version was additive — then it opens as it is.
import type Database from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

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
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "the schema of increment 1 (Access, audit, decisions)",
    compat: "additive",
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
    version: 2,
    name: "sessions.verified_at: a session's last user verification (ADR-0006, AC7)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sessions", "verified_at")) db.exec("ALTER TABLE sessions ADD COLUMN verified_at INTEGER"); },
  },
  {
    version: 3,
    name: "sends: each request id typed at most once, across restarts (ADR-0008 phase C, S5)",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS sends (
      key TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('started', 'done')), outcome TEXT, at INTEGER NOT NULL)`),
  },
  {
    version: 4,
    name: "uploads: the images the principal pasted, attachable after a restart (ADR-0008 phase C, S2)",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    version: 5,
    name: "read marks and mute per conversation, on the hub (ADR-0008 phase D, O7)",
    compat: "additive",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS read_marks (conversation TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_prefs (conversation TEXT PRIMARY KEY, muted INTEGER NOT NULL DEFAULT 0);
    `),
  },
  {
    version: 6,
    name: "a code on pairing tokens issued from an Endpoint, and Link requests (ADR-0008 phase E, AC10, AC11)",
    compat: "additive",
    up: db => {
      if (!hasColumn(db, "pairing_tokens", "code")) db.exec("ALTER TABLE pairing_tokens ADD COLUMN code TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS link_requests (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, token_secret_hash TEXT NOT NULL, code TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, requester TEXT NOT NULL,
        token_id TEXT, decided_by TEXT, pinned TEXT, proof TEXT)`);
    },
  },
  {
    version: 7,
    name: "one push subscription per Endpoint (ADR-0008 phase F, N4)",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint_id TEXT PRIMARY KEY, url TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    version: 8,
    name: "sends.typed_at: when the node typed it, on its own clock, for matching the echo (fleet core §3.1)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sends", "typed_at")) db.exec("ALTER TABLE sends ADD COLUMN typed_at INTEGER"); },
  },
  {
    version: 9,
    name: "ask_first_seen: when an ask without a message was first seen, so its answer key survives a hub restart",
    compat: "additive",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS ask_first_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)"),
  },
  {
    version: 10,
    name: "sends.node_store: the agent database a send in doubt went to, so a repeat can tell a lost key from a send never started (fleet core §3.1)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sends", "node_store")) db.exec("ALTER TABLE sends ADD COLUMN node_store TEXT"); },
  },
  {
    version: 11,
    name: "sends.worker_id and sends.request: an escalation answer in doubt keeps the worker it went to and the request that sent it, so its repeat asks that node (fleet core §3.1)",
    compat: "additive",
    up: db => {
      if (!hasColumn(db, "sends", "worker_id")) db.exec("ALTER TABLE sends ADD COLUMN worker_id TEXT");
      if (!hasColumn(db, "sends", "request")) db.exec("ALTER TABLE sends ADD COLUMN request TEXT");
      db.exec("CREATE INDEX IF NOT EXISTS sends_request ON sends (request)");
    },
  },
  {
    version: 12,
    name: "sends.node_store_seq: the store sequence a send or an answer in doubt saw from its store, so a repeat can tell that store's database put back from an older copy (fleet core §3.1, §5.3)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sends", "node_store_seq")) db.exec("ALTER TABLE sends ADD COLUMN node_store_seq INTEGER"); },
  },
  {
    version: 13,
    name: "the board (ADR-0015): tasks, their events with provenance, and the agent tokens the manager and the lanes change it with",
    compat: "additive",
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
    version: 14,
    name: "usage (ADR-0016): the latest state of each connected account, as the status lines reported it",
    compat: "additive",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS usage_accounts (account TEXT PRIMARY KEY, body TEXT NOT NULL, reported_at INTEGER NOT NULL)"),
  },
  {
    version: 15,
    name: "answers waiting in the manager's inbox, one row per inbox message (ADR-0010; code review B7)",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS pending_answers (
      key TEXT PRIMARY KEY, escalation_id TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)`),
  },
  {
    version: 16,
    name: "one board comment per job (ADR-0017): the job id is the idempotency key, so a replayed ev.job does not comment again",
    compat: "additive",
    up: db => db.exec("CREATE TABLE IF NOT EXISTS job_notices (id TEXT PRIMARY KEY, result TEXT NOT NULL)"),
  },
  {
    version: 17,
    name: "a board result waits until the fleet acknowledges it (ADR-0017)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "job_notices", "acked")) db.exec("ALTER TABLE job_notices ADD COLUMN acked INTEGER NOT NULL DEFAULT 0"); },
  },
  {
    // PR #34 (fleet-clients) merges first. 18 is that line's manager_deliveries, already running live.
    // A database at 18 runs only 19. Numbers stay contiguous, so this list and that one agree on 18.
    version: 18,
    name: "manager_deliveries (migration 18): the manager's answers and messages in the fleet's delivery queue, followed across hub restarts (fleet-clients §9.1)",
    compat: "additive",
    up: db => {
      db.exec(`CREATE TABLE IF NOT EXISTS manager_deliveries (
        delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('answer', 'command')),
        escalation_id TEXT, ask TEXT, choice TEXT, endpoint_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL,
        queued_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('sending', 'queued', 'typed', 'held', 'delivered', 'uncertain', 'given_up')),
        updated_at INTEGER NOT NULL)`);
      db.exec("CREATE INDEX IF NOT EXISTS manager_deliveries_request ON manager_deliveries (endpoint_id, request_id)");
      db.exec("CREATE INDEX IF NOT EXISTS manager_deliveries_answer ON manager_deliveries (escalation_id, queued_at)");
    },
  },
  {
    version: 19,
    name: "decision briefs (ADR-0023): one row per version, so a restate keeps the earlier brief; the counter lives in settings",
    compat: "additive",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS decision_briefs (
        id TEXT NOT NULL, version INTEGER NOT NULL, ref TEXT,
        asker_kind TEXT NOT NULL, asker_name TEXT NOT NULL, token_id TEXT NOT NULL,
        filed_by_kind TEXT NOT NULL, filed_by_name TEXT NOT NULL,
        brief TEXT NOT NULL, state TEXT NOT NULL, filed_at INTEGER NOT NULL,
        resolution TEXT, drafted_by TEXT, closed_at INTEGER,
        PRIMARY KEY (id, version));
      CREATE INDEX IF NOT EXISTS decision_briefs_state ON decision_briefs (state, asker_kind, asker_name);
    `),
  },
  {
    version: 20,
    name: "transcriptions (ADR-0021): one row per endpoint, recording and language, the body the domain already decided",
    compat: "additive",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id TEXT NOT NULL, recording_kind TEXT NOT NULL, recording_id TEXT NOT NULL, language TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        accepted_at INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (id, recording_kind, recording_id, language, endpoint_id));
      CREATE INDEX IF NOT EXISTS transcriptions_id ON transcriptions (id);
    `),
  },
  {
    // PR #50 (transcriptions) merged first, so 20 is that line's table, already running live; this column is 21.
    // A database at 20 runs only 21.
    version: 21,
    name: "sends.request_session: the session an escalation answer was sent under, so a row in doubt settled later is recorded with its own sender's provenance (A1; review of PR #55)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sends", "request_session")) db.exec("ALTER TABLE sends ADD COLUMN request_session TEXT"); },
  },
  {
    version: 22,
    name: "sends.label: the option label an escalation answer was typed with, so an answer found typed for an earlier version of its ask keeps that version's label (E9; review of PR #55)",
    compat: "additive",
    up: db => { if (!hasColumn(db, "sends", "label")) db.exec("ALTER TABLE sends ADD COLUMN label TEXT"); },
  },
  {
    version: 23,
    name: "board_tasks.state_changed_at: the last change of status, assignee or description, which the board's own moves compare a Run with (D6), so a comment no longer stops D1; a task already there takes its updated_at",
    compat: "additive",
    up: db => {
      if (hasColumn(db, "board_tasks", "state_changed_at")) return;
      db.exec("ALTER TABLE board_tasks ADD COLUMN state_changed_at INTEGER");
      db.exec("UPDATE board_tasks SET state_changed_at = updated_at");
    },
  },
  {
    version: 24,
    name: "board_merges (B11): one recorded merge of a task's PR (repo, sha, who, when), and the override when done was accepted while it was not live; a new table only, so an older hub opens the database as it is",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS board_merges (
      key TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, override TEXT,
      PRIMARY KEY (key, repo, sha))`),
  },
  {
    version: 25,
    name: "hub_store: the store id of this database file, renewed by every restore, so a Command stamped with another store is answered uncertain and never typed twice (RL10, amending S5)",
    compat: "additive",
    up: db => {
      db.exec(`CREATE TABLE IF NOT EXISTS hub_store (
        id INTEGER PRIMARY KEY CHECK (id = 1), store TEXT NOT NULL, identity TEXT NOT NULL)`);
      // Before the updater's PR 5c met main it numbered hub_store 24, main's number for board_merges: a dev hub that
      // ran that build stands at 24 without board_merges and would never get it. Migration 24's own up, run again,
      // makes it (CREATE ... IF NOT EXISTS: a hub that has it is unchanged). No released hub ever had that numbering.
      const known = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'board_merges'").get();
      if (known === undefined) MIGRATIONS.find(m => m.version === 24)!.up(db);
    },
  },
  {
    // Usage detection S2 (plan 4.2 to 4.5): one row per source and node (its health, its last reading and the one
    // before it), the notices the hub itself wrote, the plan/threshold/cycle watches, the seat record, and the lane
    // an account is used from (written by a later slice; the table and its store methods exist now).
    version: 26,
    name: "usage (S2): per-source health and readings, notices, watches and seat records (plan 4.2 to 4.5)",
    compat: "additive",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS usage_sources (account TEXT NOT NULL, source TEXT NOT NULL, node TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (account, source, node));
      CREATE TABLE IF NOT EXISTS usage_notices (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, signature TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_notices_at ON usage_notices (at);
      CREATE TABLE IF NOT EXISTS usage_watch (account TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (account, kind, key));
      CREATE TABLE IF NOT EXISTS usage_seats (account TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lane_accounts (node TEXT NOT NULL, lane TEXT NOT NULL, account TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (node, lane));
    `),
  },
  {
    // Usage detection S3 (plan 4.5 item 4, U15, U17): an agent token's scopes (comma-separated names of the closed
    // list, empty: none) and the seat records the accounts pool owns — the derived ones stay in usage_seats (S2). The
    // fix round on PR #127 (finding 4b) adds how a lane record was written: 'start' by a lane_account tap, 'report' by
    // a status-line report; every row before the column is a report. Fix round 2 on PR #127 (finding 1) adds which
    // token wrote or last confirmed a lane record (null for a hub-issued start) and until when a disagreement between
    // two tokens makes the record ambiguous; both null on every earlier row.
    version: 27,
    name: "usage (S3): agent token scopes, the pool-owned seat records, how a lane record was written and by which token (plan 4.5 item 4, U15, U17)",
    compat: "additive",
    up: db => {
      if (!hasColumn(db, "agent_tokens", "scopes")) db.exec("ALTER TABLE agent_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT ''");
      db.exec("CREATE TABLE IF NOT EXISTS usage_pool_seats (account TEXT PRIMARY KEY, body TEXT NOT NULL)");
      if (!hasColumn(db, "lane_accounts", "source")) db.exec("ALTER TABLE lane_accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'report'");
      if (!hasColumn(db, "lane_accounts", "token")) db.exec("ALTER TABLE lane_accounts ADD COLUMN token TEXT");
      if (!hasColumn(db, "lane_accounts", "conflict_until")) db.exec("ALTER TABLE lane_accounts ADD COLUMN conflict_until INTEGER");
    },
  },
  {
    version: 28,
    name: "board_proofs (B14): one row per reference of a task's brief, its state as the hub read it, kept in rows of their own so a re-check never touches the task or its events; a new table only, so an older hub opens the database as it is",
    compat: "additive",
    up: db => db.exec(`CREATE TABLE IF NOT EXISTS board_proofs (
      key TEXT NOT NULL, brief_rev INTEGER NOT NULL, ref TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, checked_at INTEGER NOT NULL,
      PRIMARY KEY (key, brief_rev, ref))`),
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

// Runs every migration newer than the database's user_version, in order, in one IMMEDIATE transaction that ends by
// setting user_version and the floor. Throws DatabaseFromFuture, changing nothing, if the database's floor is above
// this hub (§11.1). Every migration so far is additive, so the hub's floor is 0.
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
