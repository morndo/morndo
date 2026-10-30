// The account pool in the Connections database (ADR-0029): one row per runtime, a JSON body and a version. It opens the file
// the Connections store opens, with the same checks, and runs the same migrations. A save lands only on the version it read,
// as the directory's does: `UPDATE … WHERE version = ?` changes a row or it doesn't, inside one BEGIN IMMEDIATE transaction
// (better-sqlite3, "transaction(function) -> function", `.immediate`, https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).
import type Database from "better-sqlite3";
import { emptyPool, POOL_DEFAULTS, type Pool } from "@morndo/domain";
import type { PoolStore } from "../application/ports.ts";
import { openConnectionsDb } from "./store-sqlite.ts";

type Row = { version: number; body: string };

export class SqlitePoolStore implements PoolStore {
  readonly #db: Database.Database;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;
  readonly #update: Database.Statement;
  #closed = false;

  constructor(path: string, uid?: number) {
    this.#db = openConnectionsDb(path, uid);
    this.#select = this.#db.prepare("SELECT version, body FROM pool WHERE runtime = ?");
    this.#insert = this.#db.prepare("INSERT INTO pool (runtime, version, body) VALUES (?, 1, ?) ON CONFLICT (runtime) DO NOTHING");
    this.#update = this.#db.prepare("UPDATE pool SET body = ?, version = version + 1 WHERE runtime = ? AND version = ?");
  }

  // A runtime with no row yet is an empty pool at version 0.
  // A pool saved before a setting existed loads with that setting's default.
  load(runtime: string): { pool: Pool; version: number } {
    const row = this.#select.get(runtime) as Row | undefined;
    if (!row) return { pool: emptyPool(runtime), version: 0 };
    const stored = JSON.parse(row.body) as Pool;
    return { pool: { ...stored, settings: { ...POOL_DEFAULTS, ...stored.settings } }, version: row.version };
  }

  save(pool: Pool, version: number): boolean {
    const body = JSON.stringify(pool);
    return this.#db.transaction(() => {
      const changed = version === 0 ? this.#insert.run(pool.runtime, body) : this.#update.run(body, pool.runtime, version);
      return changed.changes === 1;
    }).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
