// The UpdateStore adapter (design §4.6, §5): one private SQLite file for the trust state, the staged Versions,
// the committed and bad ones, the newest hundred checks and the feed's last verified word in a row of its own,
// plus the apply lock on a file of its own (RL4). The
// lock is an exclusive SQLite lock — the operating system releases it when the process dies, which is the whole
// recovery story (SQLite's locks are POSIX advisory locks; https://www.sqlite.org/lockingv3.html and
// https://www.sqlite.org/pragma.html#pragma_locking_mode, read 2026-10-21). update.db's migrations are additive
// forever (§4.6, §11.2), so an older updater can open what a newer one wrote.
import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  compareVersions, formatVersion, parseVersion, TERMINAL_UPDATE_STATES,
  type Channel, type KeySet, type Update, type Version,
} from "@morndo/domain";
import { errno, migrate as runMigrations, openPrivateDb, type Migration } from "@morndo/service-kit";
import type { AlertKind, CheckRecord, StagedRecord, StoredUpdate, TrustState, UpdateHistory, UpdateStore } from "../application/ports.ts";

// update.db's migrations, additive forever (§4.6, §11.2): an older updater must open what a newer one wrote —
// the whole rollback story — so each one only adds. Exported for the additive linter's test.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "trust, staged versions, committed and bad versions, checks",
    compat: "additive",
    // committed and bad are written from PR 5 on; this step only reads them. checks keeps its own id order, so
    // "newest" is the highest id without trusting the clock inside one batch.
    up: db => {
      db.exec(`
        CREATE TABLE trust (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          key_set TEXT,
          seq_stable INTEGER NOT NULL DEFAULT 0,
          seq_latest INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE versions (
          version TEXT PRIMARY KEY,
          manifest_sha256 TEXT NOT NULL,
          files_sha256 TEXT NOT NULL,
          staged_at INTEGER NOT NULL
        );
        CREATE TABLE committed (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE bad (version TEXT PRIMARY KEY, at INTEGER NOT NULL);
        CREATE TABLE checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          channel TEXT NOT NULL,
          outcome TEXT NOT NULL,
          detail TEXT NOT NULL,
          version TEXT,
          feed_seq INTEGER,
          feed_expires_at INTEGER
        );
      `);
    },
  },
  {
    version: 2,
    name: "last_feed: the feed's last verified word, past the kept checks",
    compat: "additive",
    // checks keeps its newest hundred rows only; after a hundred checks without the feed's word — a long outage, a
    // stale feed — that word would leave with the trim. One row of its own keeps it, filled from what checks already
    // holds, so an update.db written before keeps its word across the upgrade.
    up: db => {
      db.exec(`
        CREATE TABLE last_feed (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          at INTEGER NOT NULL,
          channel TEXT NOT NULL,
          outcome TEXT NOT NULL,
          detail TEXT NOT NULL,
          version TEXT,
          feed_seq INTEGER NOT NULL,
          feed_expires_at INTEGER NOT NULL
        );
      `);
      db.prepare(`INSERT INTO last_feed (id, at, channel, outcome, detail, version, feed_seq, feed_expires_at)
        SELECT 1, at, channel, outcome, detail, version, feed_seq, feed_expires_at FROM checks
        WHERE feed_seq IS NOT NULL AND feed_expires_at IS NOT NULL ORDER BY id DESC LIMIT 1`).run();
    },
  },
  {
    version: 3,
    name: "the step record (RL4) and the staged Manifest's text",
    compat: "additive",
    // §6.2's step record: one row per attempt, the Update's own fields inside record — an older updater that
    // cannot read the table still leaves it whole — and the queried bits beside it. versions.manifest keeps the
    // verified Manifest's own text, what the apply's plan re-parses (§6.2 step 1); rows from before this
    // migration carry none, and read as absent until the next check stages their Version again.
    up: db => {
      db.exec(`
        ALTER TABLE versions ADD COLUMN manifest TEXT;
        CREATE TABLE updates (
          id TEXT PRIMARY KEY,
          format INTEGER NOT NULL,
          record TEXT NOT NULL,
          state TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
      `);
    },
  },
  {
    version: 4,
    name: "the Rollout halts a rollback records (RL12)",
    compat: "additive",
    // A rollback here halts its Version's Rollout (RL12); the fleet reads and acts on the record (PR 6). One row per
    // halt, kept: a halt is lifted by the principal's word, never by this table.
    up: db => {
      db.exec("CREATE TABLE rollout_halts (version TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)");
    },
  },
  {
    version: 5,
    name: "the health baseline a commit records (§6.7)",
    compat: "additive",
    // A boot apply judges the services against the last commit's recorded baseline — what passed then must pass
    // after — so every commit writes it beside its Version, and a boot apply (or a recovery that finishes the
    // walk) reads it back. Rows from before carry none, and read as "judge fresh".
    up: db => {
      db.exec("ALTER TABLE committed ADD COLUMN baseline TEXT");
    },
  },
  {
    version: 6,
    name: "the Alerts an open record has raised (§6.6)",
    compat: "additive",
    // The recovery unit runs every 5 minutes while a record stays open; a record it cannot act on would raise
    // the same Alert each time. One row per record and kind: the first raise writes it, every later one finds it.
    up: db => {
      db.exec("CREATE TABLE alerts_sent (update_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (update_id, kind))");
    },
  },
  {
    version: 7,
    name: "each Version's drawn node jitter (§7)",
    compat: "additive",
    // A node's own delay past the soak, drawn once per Version and kept across ticks (§7): the draw is persisted
    // here so a restart does not redraw it, and INSERT OR IGNORE keeps the first forever.
    up: db => {
      db.exec("CREATE TABLE rollout_jitter (version TEXT PRIMARY KEY, until INTEGER NOT NULL)");
    },
  },
];

export class UpdateDbFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`update.db is at schema version ${found}, but this updater knows migrations only up to ${known}.`);
    this.name = "UpdateDbFromFuture";
    this.found = found;
    this.known = known;
  }
}

type VersionRow = { version: string; manifest_sha256: string; files_sha256: string; staged_at: number; manifest: string | null };
// A staged row from before manifests were kept (migration 2's shape) has no Manifest text, so no apply can be
// planned from it: it reads as absent, and the next check that stages the Version re-records it whole.
const stagedRecord = (row: VersionRow): StagedRecord | null =>
  row.manifest === null ? null
    : {
      version: row.version, manifestSha256: row.manifest_sha256, filesSha256: row.files_sha256,
      at: row.staged_at, manifest: row.manifest,
    };

// The updates table's row (RL4, §6.2): the record column holds the Update's own fields plus its doneMarks; the
// columns carry what the queries need without parsing it — which attempt is open, when attempts began and ended.
type UpdateRow = { id: string; format: number; record: string; started_at: number; finished_at: number | null };

const updateText = (u: StoredUpdate): string => JSON.stringify({
  id: u.id, kind: u.kind, target: u.target, preUpdate: u.preUpdate, state: u.state, mark: u.mark,
  backups: u.backups, migrations: u.migrations, doneMarks: u.doneMarks,
  judgeBaseline: u.judgeBaseline ?? null, backupOf: u.backupOf ?? null, attempt: u.attempt ?? null,
});

// A Version as it comes back from JSON, re-parsed through the domain, so a row some other build wrote cannot
// smuggle in a shape the domain never made.
const readVersion = (value: unknown, what: string): Version => {
  const asFields = value as Version | null;
  if (typeof asFields !== "object" || asFields === null
    || ![asFields.major, asFields.minor, asFields.patch].every(n => typeof n === "number")) {
    throw new Error(`${what}: not a Version`);
  }
  const again = parseVersion(formatVersion(asFields));
  if (again === null) throw new Error(`${what}: not a Version`);
  return again;
};

// A record read back (§6.6's recovery reads exactly this). A state or a mark this build does not know passes
// through as it is: recovery's answer to the unknown is to act on nothing (§6.6), which needs the name, not a
// parse. Anything structurally broken throws with the attempt's id in the message.
const storedUpdate = (row: UpdateRow): StoredUpdate => {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(row.record) as Record<string, unknown>; }
  catch { throw new Error(`update ${row.id}: the record is not JSON`); }
  if (parsed.kind !== "update" && parsed.kind !== "rollback") throw new Error(`update ${row.id}: not a kind`);
  if (typeof parsed.state !== "string") throw new Error(`update ${row.id}: no state`);
  if (parsed.mark !== null && typeof parsed.mark !== "string") throw new Error(`update ${row.id}: not a mark`);
  if (!Array.isArray(parsed.backups)) throw new Error(`update ${row.id}: no backups list`);
  if (!Array.isArray(parsed.doneMarks) || !parsed.doneMarks.every(m => typeof m === "string")) {
    throw new Error(`update ${row.id}: no done-marks list`);
  }
  const pre = parsed.preUpdate as { current: unknown; previous: unknown } | null;
  if (typeof pre !== "object" || pre === null) throw new Error(`update ${row.id}: no pre-update pair`);
  if (parsed.backupOf !== null && parsed.backupOf !== undefined && typeof parsed.backupOf !== "string") {
    throw new Error(`update ${row.id}: not a backup owner`);
  }
  if (parsed.attempt !== null && parsed.attempt !== undefined && typeof parsed.attempt !== "string") {
    throw new Error(`update ${row.id}: not an attempt id`);
  }
  return {
    id: row.id,
    kind: parsed.kind,
    target: readVersion(parsed.target, `update ${row.id}: target`),
    preUpdate: {
      current: readVersion(pre.current, `update ${row.id}: pre-update current`),
      previous: pre.previous === null ? null : readVersion(pre.previous, `update ${row.id}: pre-update previous`),
    },
    state: parsed.state as Update["state"],
    mark: parsed.mark as Update["mark"],
    backups: parsed.backups as Update["backups"],
    migrations: (parsed.migrations ?? null) as Update["migrations"],
    format: row.format,
    startedAt: row.started_at,
    doneMarks: parsed.doneMarks,
    // §6.7's two: the baseline this attempt was judged against, and the rollback's Backup owner. A record from
    // before either existed carries neither, and both read as none. §5.4's attempt id is the same: a record from
    // before it was carried reads as none, and its endings state their own.
    judgeBaseline: readBaseline(parsed.judgeBaseline, `update ${row.id}: baseline`),
    backupOf: parsed.backupOf === undefined || parsed.backupOf === null ? null : parsed.backupOf,
    attempt: parsed.attempt === undefined || parsed.attempt === null ? null : parsed.attempt,
  };
};

// The baseline is a service-to-checks table (§6.4); anything else on a record is a wiring bug, named loudly.
const readBaseline = (value: unknown, what: string): Record<string, string[]> | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}: not the shape`);
  const out: Record<string, string[]> = {};
  for (const [service, checks] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(checks) || !checks.every(c => typeof c === "string")) throw new Error(`${what}: not the shape`);
    out[service] = checks;
  }
  return out;
};

const storedHistory = (row: UpdateRow): UpdateHistory => ({ ...storedUpdate(row), finishedAt: row.finished_at });

type CheckRow = { at: number; channel: string; outcome: string; detail: string; version: string | null;
  feed_seq: number | null; feed_expires_at: number | null };
const checkRecord = (row: CheckRow): CheckRecord =>
  ({ at: row.at, channel: row.channel as Channel, outcome: row.outcome, detail: row.detail, version: row.version,
    feedSeq: row.feed_seq, feedExpiresAt: row.feed_expires_at });

// The wire's own cap on a check row's detail (packages/protocol CheckRowSchema, 500): a refusal naming a long path
// is kept to what --status can carry — the start, and "…" where it was cut. Rows written before this cap are
// clipped again on their way out (status-service), so an old store cannot break a new reader either.
const DETAIL_MAX = 500;
const clipDetail = (detail: string): string =>
  detail.length <= DETAIL_MAX ? detail : `${detail.slice(0, DETAIL_MAX - 1)}…`;

export class SqliteUpdateStore implements UpdateStore {
  readonly #db: Database.Database;
  readonly #lockPath: string;
  readonly #readTrust: Database.Statement;
  readonly #writeTrust: Database.Statement;
  readonly #committed: Database.Statement;
  readonly #bad: Database.Statement;
  readonly #writeHalt: Database.Statement;
  readonly #halts: Database.Statement;
  readonly #writeJitter: Database.Statement;
  readonly #jitterOf: Database.Statement;
  readonly #writeAlertSent: Database.Statement;
  readonly #versions: Database.Statement;
  readonly #writeVersion: Database.Statement;
  readonly #dropVersion: Database.Statement;
  readonly #insertCheck: Database.Statement;
  readonly #trimChecks: Database.Statement;
  readonly #writeLastFeed: Database.Statement;
  readonly #recordCheckTx: (r: CheckRecord) => void;
  readonly #checks: Database.Statement;
  readonly #lastFeedCheck: Database.Statement;
  readonly #manifestOf: Database.Statement;
  readonly #writeCommitted: Database.Statement;
  readonly #lastCommitted: Database.Statement;
  readonly #writeBad: Database.Statement;
  readonly #writeUpdate: Database.Statement;
  readonly #readUpdate: Database.Statement;
  readonly #endUpdate: Database.Statement;
  readonly #openUpdate: Database.Statement;
  readonly #recentUpdates: Database.Statement;
  readonly #saveUpdateTx: (u: StoredUpdate) => void;
  readonly #finishUpdateTx: (id: string, state: "committed" | "abandoned" | "rolled_back" | "rollback_failed", at: number) => void;
  #closed = false;

  constructor(o: { db: string; lock: string }) {
    this.#lockPath = o.lock;
    // the state directory is the store's own (§5): created private, before either file in it is opened
    mkdirSync(dirname(o.db), { recursive: true, mode: 0o700 });
    this.#db = openPrivateDb(o.db, {
      synchronous: "FULL",
      knownVersion: MIGRATIONS.length,
      refuseNewer: (found, known) => new UpdateDbFromFuture(found, known),
      migrate: db => runMigrations(db, MIGRATIONS, (found, known) => new UpdateDbFromFuture(found, known)),
    });
    this.#readTrust = this.#db.prepare("SELECT key_set, seq_stable, seq_latest FROM trust WHERE id = 1");
    this.#writeTrust = this.#db.prepare(`INSERT INTO trust (id, key_set, seq_stable, seq_latest) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET key_set = excluded.key_set, seq_stable = excluded.seq_stable, seq_latest = excluded.seq_latest`);
    this.#committed = this.#db.prepare("SELECT version FROM committed");
    this.#bad = this.#db.prepare("SELECT version FROM bad ORDER BY at");
    this.#writeHalt = this.#db.prepare("INSERT INTO rollout_halts (version, reason, at) VALUES (?, ?, ?)");
    this.#halts = this.#db.prepare("SELECT version, reason, at FROM rollout_halts ORDER BY at DESC, rowid DESC");
    this.#writeJitter = this.#db.prepare("INSERT OR IGNORE INTO rollout_jitter (version, until) VALUES (?, ?)");
    this.#jitterOf = this.#db.prepare("SELECT until FROM rollout_jitter WHERE version = ?");
    this.#writeAlertSent = this.#db.prepare("INSERT OR IGNORE INTO alerts_sent (update_id, kind, at) VALUES (?, ?, ?)");
    this.#versions = this.#db.prepare("SELECT version, manifest_sha256, files_sha256, staged_at, manifest FROM versions");
    this.#writeVersion = this.#db.prepare(`INSERT INTO versions (version, manifest_sha256, files_sha256, staged_at, manifest)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(version) DO UPDATE SET manifest_sha256 = excluded.manifest_sha256,
      files_sha256 = excluded.files_sha256, staged_at = excluded.staged_at, manifest = excluded.manifest`);
    this.#dropVersion = this.#db.prepare("DELETE FROM versions WHERE version = ?");
    this.#manifestOf = this.#db.prepare("SELECT manifest FROM versions WHERE version = ?");
    this.#insertCheck = this.#db.prepare(`INSERT INTO checks (at, channel, outcome, detail, version, feed_seq, feed_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.#trimChecks = this.#db.prepare("DELETE FROM checks WHERE id NOT IN (SELECT id FROM checks ORDER BY id DESC LIMIT 100)");
    this.#writeLastFeed = this.#db.prepare(`INSERT INTO last_feed (id, at, channel, outcome, detail, version, feed_seq, feed_expires_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, channel = excluded.channel,
      outcome = excluded.outcome, detail = excluded.detail, version = excluded.version, feed_seq = excluded.feed_seq,
      feed_expires_at = excluded.feed_expires_at`);
    this.#recordCheckTx = this.#db.transaction((r: CheckRecord) => {
      this.#insertCheck.run(r.at, r.channel, r.outcome, clipDetail(r.detail), r.version, r.feedSeq, r.feedExpiresAt);
      this.#trimChecks.run();
      // the feed's word moves to its own row in the same step as the trim that would otherwise drop it
      if (r.feedSeq !== null && r.feedExpiresAt !== null)
        this.#writeLastFeed.run(r.at, r.channel, r.outcome, clipDetail(r.detail), r.version, r.feedSeq, r.feedExpiresAt);
    });
    this.#checks = this.#db.prepare("SELECT at, channel, outcome, detail, version, feed_seq, feed_expires_at FROM checks ORDER BY id DESC LIMIT ?");
    this.#lastFeedCheck = this.#db.prepare("SELECT at, channel, outcome, detail, version, feed_seq, feed_expires_at FROM last_feed WHERE id = 1");
    this.#writeCommitted = this.#db.prepare(`INSERT INTO committed (version, at, baseline) VALUES (?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET at = excluded.at, baseline = excluded.baseline`);
    this.#lastCommitted = this.#db.prepare("SELECT baseline FROM committed ORDER BY at DESC, rowid DESC LIMIT 1");
    this.#writeBad = this.#db.prepare("INSERT INTO bad (version, at) VALUES (?, ?) ON CONFLICT(version) DO UPDATE SET at = excluded.at");
    this.#writeUpdate = this.#db.prepare(`INSERT INTO updates (id, format, record, state, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET format = excluded.format, record = excluded.record, state = excluded.state,
      started_at = excluded.started_at`);
    this.#readUpdate = this.#db.prepare("SELECT id, format, record, started_at, finished_at FROM updates WHERE id = ?");
    this.#endUpdate = this.#db.prepare("UPDATE updates SET record = ?, state = ?, finished_at = ? WHERE id = ?");
    // newest first by when the attempt began; the rowid breaks a tie the way the writes happened
    this.#openUpdate = this.#db.prepare(`SELECT id, format, record, started_at, finished_at FROM updates
      WHERE state NOT IN (${TERMINAL_UPDATE_STATES.map(() => "?").join(", ")})
      ORDER BY started_at DESC, rowid DESC LIMIT 1`);
    this.#recentUpdates = this.#db.prepare("SELECT id, format, record, started_at, finished_at FROM updates ORDER BY started_at DESC, rowid DESC LIMIT ?");
    this.#saveUpdateTx = this.#db.transaction((u: StoredUpdate) => {
      this.#writeUpdate.run(u.id, u.format, updateText(u), u.state, u.startedAt);
    });
    this.#finishUpdateTx = this.#db.transaction((id: string, state: "committed" | "abandoned" | "rolled_back" | "rollback_failed", at: number) => {
      const row = this.#readUpdate.get(id) as UpdateRow | undefined;
      if (row === undefined) throw new Error(`${id}: no update to finish`);
      this.#endUpdate.run(updateText({ ...storedUpdate(row), state }), state, at, id);
    });
  }

  trust(): TrustState {
    const row = this.#readTrust.get() as { key_set: string | null; seq_stable: number; seq_latest: number } | undefined;
    return {
      keySet: row?.key_set === null || row?.key_set === undefined ? null : JSON.parse(row.key_set) as KeySet,
      highestFeedSeq: { stable: row?.seq_stable ?? 0, latest: row?.seq_latest ?? 0 },
    };
  }

  // RL3: the stored key set version and feed numbers never move backwards, whatever this is given — an older key
  // set, an empty one, a stale feed number. Trust ratchets up or stays.
  saveTrust(t: TrustState): void {
    const stored = this.trust();
    const keySet = stored.keySet !== null && (t.keySet === null || t.keySet.version < stored.keySet.version)
      ? stored.keySet
      : t.keySet;
    this.#writeTrust.run(
      keySet === null ? null : JSON.stringify(keySet),
      Math.max(stored.highestFeedSeq.stable, t.highestFeedSeq.stable),
      Math.max(stored.highestFeedSeq.latest, t.highestFeedSeq.latest),
    );
  }

  highestCommitted(): string | null {
    const rows = this.#committed.all() as { version: string }[];
    return rows.map(row => row.version).reduce<string | null>((best, version) => {
      const v = parseVersion(version);
      if (v === null) return best;                            // not a Version: never ours (PR 5 writes it), never a winner
      return best !== null && compareVersions(v, parseVersion(best)!) <= 0 ? best : version;
    }, null);
  }

  badVersions(): string[] {
    return (this.#bad.all() as { version: string }[]).map(row => row.version);
  }

  recordStaged(r: StagedRecord): void {
    this.#writeVersion.run(r.version, r.manifestSha256, r.filesSha256, r.at, r.manifest);
  }

  versionRecord(version: string): StagedRecord | null {
    const row = (this.#versions.all() as VersionRow[]).find(r => r.version === version);
    return row === undefined ? null : stagedRecord(row);
  }

  // The newest staged record whose Version is above every committed one (or any, when nothing is committed yet):
  // what a boot unit or `--status` would apply, never a Version an older machine already passed.
  // A named `--to` is what stands staged. Only a Version above both the named one and the highest committed one
  // can shadow it; a row at or below the highest this machine has run stays, history staged() still reads.
  retireStagedAbove(version: string): void {
    const keep = parseVersion(version);
    if (keep === null) return;
    const committed = this.highestCommitted();
    const ceiling = committed === null ? null : parseVersion(committed);
    const floor = ceiling !== null && compareVersions(ceiling, keep) > 0 ? ceiling : keep;
    for (const row of this.#versions.all() as VersionRow[]) {
      const v = parseVersion(row.version);
      if (v !== null && compareVersions(v, floor) > 0) this.#dropVersion.run(row.version);
    }
  }

  staged(): StagedRecord | null {
    const committed = this.highestCommitted();
    const ceiling = committed === null ? null : parseVersion(committed);
    return (this.#versions.all() as VersionRow[]).reduce<StagedRecord | null>((best, row) => {
      const v = parseVersion(row.version);
      if (v === null) return best;
      if (ceiling !== null && compareVersions(v, ceiling) <= 0) return best;
      const record = stagedRecord(row);                 // a row from before manifests were kept reads as absent
      if (record === null) return best;
      return best !== null && compareVersions(v, parseVersion(best.version)!) <= 0 ? best : record;
    }, null);
  }

  manifestOf(version: string): string | null {
    const row = this.#manifestOf.get(version) as { manifest: string | null } | undefined;
    return row === undefined ? null : row.manifest;
  }

  recordCheck(r: CheckRecord): void {
    this.#recordCheckTx(r);
  }

  checks(limit: number): CheckRecord[] {
    return (this.#checks.all(limit) as CheckRow[]).map(checkRecord);
  }

  // The feed's last verified word from its own row (§4.5), not from the kept hundred checks: a machine refused a
  // hundred times in a row — a long outage, a stale feed — still carries it, and the status and the doctor both
  // read it from here.
  lastFeedCheck(): CheckRecord | null {
    const row = this.#lastFeedCheck.get() as CheckRow | undefined;
    return row === undefined ? null : checkRecord(row);
  }

  // ---- the step record (RL4, §6.2) and the apply's own writes

  recordCommitted(version: string, at: number, baseline: Record<string, string[]> | null): void {
    this.#writeCommitted.run(version, at, baseline === null ? null : JSON.stringify(baseline));
  }

  // §6.7: the newest commit's recorded baseline, or null (nothing committed, or a row from before the column).
  // Anything the JSON will not give back as the shape it was written in reads as none, never a guess.
  commitBaseline(): Record<string, string[]> | null {
    const row = this.#lastCommitted.get() as { baseline: string | null } | undefined;
    if (row === undefined || row.baseline === null) return null;
    try { return readBaseline(JSON.parse(row.baseline), "the committed baseline"); }
    catch { return null; }
  }

  recordBad(version: string, at: number): void {
    this.#writeBad.run(version, at);
  }

  recordHalt(version: string, reason: string, at: number): void {
    this.#writeHalt.run(version, reason, at);
  }

  halts(): { version: string; reason: string; at: number }[] {
    return this.#halts.all() as { version: string; reason: string; at: number }[];
  }

  jitterOf(version: string): number | null {
    const row = this.#jitterOf.get(version) as { until: number } | undefined;
    return row === undefined ? null : row.until;
  }

  recordJitter(version: string, until: number): void {
    this.#writeJitter.run(version, until);
  }

  firstAlert(updateId: string, kind: AlertKind, at: number): boolean {
    return this.#writeAlertSent.run(updateId, kind, at).changes === 1;
  }

  saveUpdate(u: StoredUpdate): void {
    this.#saveUpdateTx(u);
  }

  openUpdate(): StoredUpdate | null {
    const row = this.#openUpdate.get(...TERMINAL_UPDATE_STATES) as UpdateRow | undefined;
    return row === undefined ? null : storedUpdate(row);
  }

  finishUpdate(id: string, state: "committed" | "abandoned" | "rolled_back" | "rollback_failed", at: number): void {
    this.#finishUpdateTx(id, state, at);
  }

  recentUpdates(limit: number): UpdateHistory[] {
    return (this.#recentUpdates.all(limit) as UpdateRow[]).map(storedHistory);
  }

  // The apply lock (RL4, §5): open the lock file as a SQLite database, hold it exclusively. BEGIN EXCLUSIVE under
  // locking_mode = EXCLUSIVE takes the lock and keeps it past the transaction's end, until the connection closes —
  // so release() closes, and a process that dies mid-apply drops it with the file descriptor, which is what lets
  // recovery take over. timeout 0, so a held lock answers null at once instead of waiting out a retry.
  tryLock(): { release(): void } | null {
    const lock = new Database(this.#lockPath, { timeout: 0 });
    try {
      lock.pragma("locking_mode = EXCLUSIVE");
      lock.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      lock.close();
      if (errno(error) === "SQLITE_BUSY") return null;
      throw error;
    }
    chmodSync(this.#lockPath, 0o600);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        lock.exec("ROLLBACK");
        lock.close();
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

export function openUpdateStore(o: { db: string; lock: string }): SqliteUpdateStore {
  return new SqliteUpdateStore(o);
}
