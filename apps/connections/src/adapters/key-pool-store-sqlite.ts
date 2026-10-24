// A key pool in the Connections database (ADR-0037): one row per pool, a JSON body and a version. It opens the file the
// Connections store opens, with the same checks, and runs the same migrations. A save lands only on the version it read,
// as the directory's does: `UPDATE … WHERE version = ?` changes a row or it doesn't, inside one BEGIN IMMEDIATE transaction
// (better-sqlite3, "transaction(function) -> function", `.immediate`, https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).
// A deleted pool stays as a row, so its name cannot be inserted again.
import type Database from "better-sqlite3";
import type { KeyPool } from "@morndo/domain";
import type { KeyPoolStore } from "../application/ports.ts";
import { openConnectionsDb } from "./store-sqlite.ts";

type Row = { version: number; body: string };
type Named = { name: string; body: string };

function deleted(body: string): boolean {
  const value = JSON.parse(body) as { deleted?: unknown };
  return value.deleted === true;
}

function poolOf(body: string): KeyPool | null {
  return deleted(body) ? null : JSON.parse(body) as KeyPool;
}

export class SqliteKeyPoolStore implements KeyPoolStore {
  readonly #db: Database.Database;
  readonly #select: Database.Statement;
  readonly #insert: Database.Statement;
  readonly #update: Database.Statement;
  readonly #list: Database.Statement;
  #closed = false;

  constructor(path: string, uid?: number) {
    this.#db = openConnectionsDb(path, uid);
    this.#select = this.#db.prepare("SELECT version, body FROM key_pool WHERE name = ?");
    this.#insert = this.#db.prepare("INSERT INTO key_pool (name, version, body) VALUES (?, 1, ?) ON CONFLICT (name) DO NOTHING");
    this.#update = this.#db.prepare("UPDATE key_pool SET body = ?, version = version + 1 WHERE name = ? AND version = ?");
    this.#list = this.#db.prepare("SELECT name, body FROM key_pool ORDER BY name");
  }

  // A name with no row yet is version 0. A tombstone is a null pool at whatever version the delete reached.
  load(name: string): { pool: KeyPool | null; version: number } {
    const row = this.#select.get(name) as Row | undefined;
    return row ? { pool: poolOf(row.body), version: row.version } : { pool: null, version: 0 };
  }

  names(): { live: readonly string[]; deleted: readonly string[] } {
    const live: string[] = [];
    const gone: string[] = [];
    for (const row of this.#list.all() as Named[]) (deleted(row.body) ? gone : live).push(row.name);
    return { live, deleted: gone };
  }

  save(pool: KeyPool, version: number): boolean {
    const body = JSON.stringify(pool);
    return this.#db.transaction(() => {
      if (version === 0) return this.#insert.run(pool.name, body).changes === 1;
      const row = this.#select.get(pool.name) as Row | undefined;
      if (!row || row.version !== version || deleted(row.body)) return false;
      return this.#update.run(body, pool.name, version).changes === 1;
    }).immediate();
  }

  tombstone(name: string, version: number, at: number): boolean {
    const body = JSON.stringify({ deleted: true, at });
    return this.#db.transaction(() => {
      const row = this.#select.get(name) as Row | undefined;
      if (!row || row.version !== version || deleted(row.body)) return false;
      return this.#update.run(body, name, version).changes === 1;
    }).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
