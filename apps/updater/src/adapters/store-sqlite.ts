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
import { compareVersions, parseVersion, type Channel, type KeySet } from "@morndo/domain";
import { errno, migrate as runMigrations, openPrivateDb, type Migration } from "@morndo/service-kit";
import type { CheckRecord, StagedRecord, TrustState, UpdateStore } from "../application/ports.ts";

const MIGRATIONS: readonly Migration[] = [
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

type VersionRow = { version: string; manifest_sha256: string; files_sha256: string; staged_at: number };
const stagedRecord = (row: VersionRow): StagedRecord =>
  ({ version: row.version, manifestSha256: row.manifest_sha256, filesSha256: row.files_sha256, at: row.staged_at });

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
  readonly #versions: Database.Statement;
  readonly #writeVersion: Database.Statement;
  readonly #insertCheck: Database.Statement;
  readonly #trimChecks: Database.Statement;
  readonly #writeLastFeed: Database.Statement;
  readonly #recordCheckTx: (r: CheckRecord) => void;
  readonly #checks: Database.Statement;
  readonly #lastFeedCheck: Database.Statement;
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
    this.#versions = this.#db.prepare("SELECT version, manifest_sha256, files_sha256, staged_at FROM versions");
    this.#writeVersion = this.#db.prepare(`INSERT INTO versions (version, manifest_sha256, files_sha256, staged_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(version) DO UPDATE SET manifest_sha256 = excluded.manifest_sha256,
      files_sha256 = excluded.files_sha256, staged_at = excluded.staged_at`);
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
    this.#writeVersion.run(r.version, r.manifestSha256, r.filesSha256, r.at);
  }

  versionRecord(version: string): StagedRecord | null {
    const row = (this.#versions.all() as VersionRow[]).find(r => r.version === version);
    return row === undefined ? null : stagedRecord(row);
  }

  // The newest staged record whose Version is above every committed one (or any, when nothing is committed yet):
  // what a boot unit or `--status` would apply, never a Version an older machine already passed.
  staged(): StagedRecord | null {
    const committed = this.highestCommitted();
    const ceiling = committed === null ? null : parseVersion(committed);
    return (this.#versions.all() as VersionRow[]).reduce<StagedRecord | null>((best, row) => {
      const v = parseVersion(row.version);
      if (v === null) return best;
      if (ceiling !== null && compareVersions(v, ceiling) <= 0) return best;
      return best !== null && compareVersions(v, parseVersion(best.version)!) <= 0 ? best : stagedRecord(row);
    }, null);
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
