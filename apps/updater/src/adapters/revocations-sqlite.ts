// The Revocations adapter (RL10, design §11.5), until the revocation journals arrive (PR 5c): a restore must never
// bring back a revoked device, agent token or node. During a probation that may restore, the services still take
// revocations (RL9), and those rows live only in the database the restore would replace — so before any restore the
// rollback asks which ids are revoked in the live database and not in this update's Backup of it. Both files are
// opened read-only. The tables are the services' own: the hub's endpoints and agent_tokens (apps/hub's migrations),
// the fleet's nodes (apps/fleet's migrations); a table a schema doesn't have yet holds no revocations.
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseName } from "@morndo/domain";
import type { Revocations } from "../application/ports.ts";
import type { DatabasePaths } from "./paths.ts";

const REVOKED: Partial<Record<DatabaseName, readonly { table: string; id: string }[]>> = {
  hub: [{ table: "endpoints", id: "id" }, { table: "agent_tokens", id: "id" }],
  fleet: [{ table: "nodes", id: "name" }],
};

function revokedIn(path: string, tables: readonly { table: string; id: string }[]): Set<string> {
  const out = new Set<string>();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    for (const { table, id } of tables) {
      const known = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (known === undefined) continue;
      for (const row of db.prepare(`SELECT ${id} AS id FROM ${table} WHERE revoked_at IS NOT NULL`).all() as { id: string }[]) {
        out.add(`${table}:${row.id}`);
      }
    }
  } finally {
    db.close();
  }
  return out;
}

export class SqliteRevocations implements Revocations {
  readonly #paths: DatabasePaths;
  readonly #backups: string;

  // `backups` is the same directory SqliteBackup keeps its copies in: <backups>/<updateId>/<db>.db.
  constructor(o: { paths: DatabasePaths; backups: string }) {
    this.#paths = o.paths;
    this.#backups = o.backups;
  }

  droppedBy(updateId: string, db: DatabaseName): string[] {
    const tables = REVOKED[db];
    const backup = join(this.#backups, updateId, `${db}.db`);
    if (tables === undefined || !existsSync(backup) || !existsSync(this.#paths[db])) return [];
    const kept = revokedIn(backup, tables);
    return [...revokedIn(this.#paths[db], tables)].filter(id => !kept.has(id)).sort();
  }
}
