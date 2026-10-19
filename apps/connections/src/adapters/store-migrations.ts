// Schema for the connections directory (with its events) and the routing policy (ADR-0008 A1, design section 5), from
// migration 2 the node's Secrets (ADR-0022; secret-requests design §6), and from migration 3 the account pool (ADR-0029).
// The store has no service that could be stopped for an update — its helper runs whenever an agent CLI needs a key —
// so its migrations are additive forever (ADR-0019 §11): the floor stays at 0 and any version's store opens.
import type Database from "better-sqlite3";
import { emptyDirectory, emptyPolicy } from "@morndo/domain";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

export type { Migration };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this store knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "connections directory, events and routing policy",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE cas (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
        CREATE TABLE directory (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
        CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO cas (id, version) VALUES (1, 0)").run();
      db.prepare("INSERT INTO directory (id, body) VALUES (1, ?)").run(JSON.stringify(emptyDirectory()));
      db.prepare("INSERT INTO policy (id, body) VALUES (1, ?)").run(JSON.stringify(emptyPolicy()));
    },
  },
  {
    version: 2,
    name: "secrets on the node: metadata, the fingerprint ledger, grants, uses, events and workspaces",
    compat: "additive",
    // Design §6, "Metadata"; §3.4 SC2. A held Secret is one row, its own versions (which restart after a Delete) a JSON
    // column. secret_versions is the fingerprint ledger: one row per version ever stored here, with its vault ref, kept
    // after a Delete. secret_uses waits for the broker (PR 3).
    up: db => {
      db.exec(`
        CREATE TABLE secrets (
          reference TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
          current INTEGER CHECK (current IS NULL OR current >= 1),
          expiry INTEGER,
          shape TEXT,
          warned TEXT NOT NULL,
          destinations TEXT NOT NULL,
          versions TEXT NOT NULL
        );
        CREATE UNIQUE INDEX secrets_reference ON secrets (reference);
        CREATE TABLE secret_versions (
          reference TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          keyed_fingerprint TEXT NOT NULL
            CHECK (length(keyed_fingerprint) = 12 AND keyed_fingerprint NOT GLOB '*[^0-9a-f]*'),
          state TEXT NOT NULL CHECK (state IN ('current', 'retired', 'revoked')),
          vault_ref TEXT
        );
        CREATE UNIQUE INDEX secret_versions_fingerprint ON secret_versions (reference, keyed_fingerprint);
        CREATE UNIQUE INDEX secret_versions_version ON secret_versions (reference, version);
        CREATE UNIQUE INDEX secret_versions_current ON secret_versions (reference) WHERE state = 'current';
        CREATE TABLE secret_grants (reference TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX secret_grants_reference ON secret_grants (reference);
        CREATE TABLE secret_uses (
          id TEXT NOT NULL PRIMARY KEY,
          reference TEXT NOT NULL,
          version INTEGER NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('exec', 'file', 'helper', 'inject')),
          lane TEXT,
          workspace TEXT,
          at INTEGER NOT NULL,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('exited', 'failed', 'lost'))
        );
        CREATE TABLE secret_events (
          seq INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          reference TEXT NOT NULL,
          at INTEGER NOT NULL,
          body TEXT NOT NULL
        );
        CREATE TABLE secret_workspaces (
          name TEXT NOT NULL UNIQUE,
          root TEXT NOT NULL UNIQUE,
          at INTEGER NOT NULL,
          command TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    name: "account pool: one versioned row per runtime",
    compat: "additive",
    // ADR-0029. The Pool aggregate is one JSON body per runtime; `version` is the compare-and-swap the service retries on.
    up: db => {
      db.exec("CREATE TABLE pool (runtime TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL);");
    },
  },
];

export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new DatabaseFromFuture(found, known));
}
