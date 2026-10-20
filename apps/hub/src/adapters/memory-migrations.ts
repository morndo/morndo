// Numbered schema migrations for Memory's own SQLite file, memory.db (ADR-0031, docs/design/memory/README.md
// "Storage"), beside the hub's morndo.db and never in it. The runner is the kit's (ADR-0008 A1, ADR-0019 §11.1): the
// version is the file's user_version, and the file keeps its own schema floor, so a Memory migration never blocks a hub
// rollback and Memory can be reset alone (move memory.db away). A hub from before Memory never opens this file.
import type Database from "better-sqlite3";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

export class MemoryFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`memory.db is at schema version ${found}, but this hub knows Memory's migrations only up to ${known}.`);
    this.name = "MemoryFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    // Breaking only because of notes_fts: the additive list (§11.2) has no virtual table, since a reader without FTS5
    // could not use it. The floor it raises is 1, and nothing that opens memory.db is below 1 (this migration creates
    // the file), so it blocks no rollback. Later migrations are additive unless they say otherwise.
    version: 1,
    name: "Memory's notes, their events, the full-text index over them, and its settings (ADR-0031)",
    compat: "breaking",
    up: db => db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, body TEXT NOT NULL,
        tier INTEGER NOT NULL, provenance_by TEXT NOT NULL, provenance_node TEXT, provenance_ref TEXT, provenance_untrusted INTEGER NOT NULL,
        created_at INTEGER NOT NULL, last_confirmed_at INTEGER NOT NULL, recheck_at INTEGER,
        approved_at INTEGER, approved_by TEXT, invalidated_at INTEGER, invalidated_by TEXT, invalid_reason TEXT,
        supersedes TEXT, superseded_by TEXT);
      CREATE INDEX IF NOT EXISTS notes_scope ON notes (scope, invalidated_at);
      CREATE TABLE IF NOT EXISTS note_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, change TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS note_events_note ON note_events (note, seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, title, summary, body, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS memory_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `),
  },
];

export const MEMORY_SCHEMA_VERSION = MEMORY_MIGRATIONS.length;

// Every migration newer than the file's user_version, in one IMMEDIATE transaction with the version and the floor;
// throws MemoryFromFuture, changing nothing, if the file's floor is above this hub.
export function migrateMemory(db: Database.Database, migrations: readonly Migration[] = MEMORY_MIGRATIONS): { from: number; to: number } {
  return runMigrations(db, migrations, (found, known) => new MemoryFromFuture(found, known));
}
