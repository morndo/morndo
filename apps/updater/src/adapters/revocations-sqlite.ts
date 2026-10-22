// The Revocations adapter (RL10, design §11.5), until the revocation journals arrive (PR 5c): a restore must never
// bring back a revoked device, agent token or node. During a probation that may restore, the services still take
// revocations (RL9), and those rows live only in the database the restore would replace — so before any restore the
// rollback asks which ids are revoked in the live database and not in this update's Backup of it. Both files are
// opened read-only. The tables are the services' own: the hub's endpoints and agent_tokens (apps/hub's migrations),
// the fleet's nodes (apps/fleet's migrations), and the connections store's secrets and secret versions (its
// store-migrations.ts: status or state 'revoked') and its Connections, kept as JSON in the one-row directory table
// (body.connections[].status 'revoked'); a table a schema doesn't have yet holds no revocations.
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseName } from "@morndo/domain";
import type { Revocations } from "../application/ports.ts";
import type { DatabasePaths } from "./paths.ts";
import { absentMarker } from "./backup-sqlite.ts";

// Each revocation table: the id it is named by, and what marks a row revoked. Fixed SQL, no input in it.
type RevokedRows = { table: string; id: string; revoked: string };
const BY_TIME = "revoked_at IS NOT NULL";
const REVOKED: Partial<Record<DatabaseName, readonly RevokedRows[]>> = {
  hub: [{ table: "endpoints", id: "id", revoked: BY_TIME }, { table: "agent_tokens", id: "id", revoked: BY_TIME }],
  fleet: [{ table: "nodes", id: "name", revoked: BY_TIME }],
  connections: [
    { table: "secrets", id: "reference", revoked: "status = 'revoked'" },
    { table: "secret_versions", id: "reference || '#' || version", revoked: "state = 'revoked'" },
  ],
};

function revokedIn(path: string, tables: readonly RevokedRows[], directory: boolean): Set<string> {
  const out = new Set<string>();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    for (const { table, id, revoked } of tables) {
      const known = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (known === undefined) continue;
      for (const row of db.prepare(`SELECT ${id} AS id FROM ${table} WHERE ${revoked}`).all() as { id: string }[]) {
        out.add(`${table}:${row.id}`);
      }
    }
    if (directory) {
      const known = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'directory'").get();
      const row = known === undefined ? undefined : db.prepare("SELECT body FROM directory WHERE id = 1").get() as { body: string } | undefined;
      for (const name of revokedConnections(row?.body)) out.add(`directory:${name}`);
    }
  } finally {
    db.close();
  }
  return out;
}

// The Connections the directory JSON names revoked. A body that is not the shape the store writes counts as holding
// none here; the store itself refuses such a file when it opens it.
function revokedConnections(body: string | undefined): string[] {
  if (body === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  const list = typeof parsed === "object" && parsed !== null && "connections" in parsed ? parsed.connections : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap(c => typeof c === "object" && c !== null && "name" in c && "status" in c
    && typeof c.name === "string" && c.status === "revoked" ? [c.name] : []);
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
    // A Backup of a database that did not exist keeps no revocation: every one made since would be dropped.
    const absent = !existsSync(backup) && existsSync(absentMarker(this.#backups, updateId, db));
    if (tables === undefined || (!existsSync(backup) && !absent) || !existsSync(this.#paths[db])) return [];
    const directory = db === "connections";
    const kept = absent ? new Set<string>() : revokedIn(backup, tables, directory);
    return [...revokedIn(this.#paths[db], tables, directory)].filter(id => !kept.has(id)).sort();
  }
}
