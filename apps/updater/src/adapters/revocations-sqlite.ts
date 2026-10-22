// The Revocations adapter (RL10, design §11.5): a restore must never bring back a revoked device, agent token or
// node. During a probation that may restore, the services still take revocations (RL9), and those rows live only in
// the database the restore would replace — so before any restore the rollback asks which ids are revoked in the live
// database and not in this update's Backup of it, minus what the service's own journal beside that database holds
// (§11.5): the service re-applies its journal at every start, so a restore may drop those from the database without
// dropping the revocation. The connections store journals nothing, so its revocations still gate a restore. Both
// files are opened read-only. The tables are the services' own: the hub's endpoints and agent_tokens (apps/hub's
// migrations), the fleet's nodes (apps/fleet's migrations), and the connections store's secrets and secret versions
// (its store-migrations.ts: status or state 'revoked') and its Connections, kept as JSON in the one-row directory
// table (body.connections[].status 'revoked'); a table a schema doesn't have yet holds no revocations.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseName } from "@morndo/domain";
import { RevocationJournal, type RevocationKind } from "@morndo/service-kit";
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

// What each service's journal (§11.5) names by kind, as the `${table}:${id}` ids above are spelled: the hub's
// endpoints and agent tokens, the fleet's nodes. The connections store has no journal, so it is absent here too.
const JOURNALED: Partial<Record<DatabaseName, Partial<Record<RevocationKind, string>>>> = {
  hub: { endpoint: "endpoints", agent_token: "agent_tokens" },
  fleet: { node: "nodes" },
};

// The file in a Version's tree that applies a service's journal at its start (apps/<service>/src/application/
// revocations.ts): a Version without it (one from before the journals) applies nothing, so a rollback to it may
// excuse nothing by the journal. A later rename of the file only makes this stricter, never looser.
const APPLIER: Partial<Record<DatabaseName, string>> = {
  hub: "app/apps/hub/src/application/revocations.ts",
  fleet: "app/apps/fleet/src/application/revocations.ts",
};

// The ids the journal beside a service's database (revoked.log, read with the service's own reader) will revoke
// again at the service's next start over the restored `backup`. Hub ids are never reused. A node's entry revokes one
// enrolment, so it covers the node only when the row the backup brings back is that enrolment: a node revoked, joined
// again and revoked again is covered by the entry of the enrolment the backup holds, or by none. Bad lines cover
// nothing (the service skips them too).
function journaledIds(db: DatabaseName, path: string, backup: string | null): Set<string> {
  const byKind = JOURNALED[db];
  if (byKind === undefined) return new Set();
  const entries = new RevocationJournal(join(dirname(path), "revoked.log")).entries();
  const out = new Set<string>();
  // a Backup of a fleet.db that did not exist brings no node back: no enrolment to cover
  const enrolmentInBackup = db === "fleet" && backup !== null ? nodeEnrolments(backup) : new Map<string, string>();
  for (const entry of entries) {
    const table = byKind[entry.kind];
    if (table === undefined) continue;
    if (entry.kind === "node" && enrolmentInBackup.get(entry.id) !== entry.enrolment) continue;
    out.add(`${table}:${entry.id}`);
  }
  return out;
}

// Each node's enrolment as a fleet.db holds it; a database from before the enrolment column holds none.
function nodeEnrolments(path: string): Map<string, string> {
  const out = new Map<string, string>();
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const columns = db.prepare("SELECT name FROM pragma_table_info('nodes')").all() as { name: string }[];
    if (!columns.some(c => c.name === "enrolment")) return out;
    for (const r of db.prepare("SELECT name, enrolment FROM nodes WHERE enrolment IS NOT NULL").all() as { name: string; enrolment: string }[]) {
      out.set(r.name, r.enrolment);
    }
  } finally { db.close(); }
  return out;
}

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
  readonly #releases: string;

  // `backups` is the same directory SqliteBackup keeps its copies in: <backups>/<updateId>/<db>.db. `releases` holds
  // the Version trees (<releases>/<version>/), where the target's own code says whether it applies journals.
  constructor(o: { paths: DatabasePaths; backups: string; releases: string }) {
    this.#paths = o.paths;
    this.#backups = o.backups;
    this.#releases = o.releases;
  }

  droppedBy(updateId: string, db: DatabaseName, target: string): string[] {
    const tables = REVOKED[db];
    const backup = join(this.#backups, updateId, `${db}.db`);
    // A Backup of a database that did not exist keeps no revocation: every one made since would be dropped.
    const absent = !existsSync(backup) && existsSync(absentMarker(this.#backups, updateId, db));
    if (tables === undefined || (!existsSync(backup) && !absent) || !existsSync(this.#paths[db])) return [];
    const directory = db === "connections";
    const kept = absent ? new Set<string>() : revokedIn(backup, tables, directory);
    // The service's start re-applies these (RL10) — when the Version going back in applies journals at all.
    const applier = APPLIER[db];
    const journals = applier !== undefined && existsSync(join(this.#releases, target, applier));
    const journaled = journals ? journaledIds(db, this.#paths[db], absent ? null : backup) : new Set<string>();
    return [...revokedIn(this.#paths[db], tables, directory)].filter(id => !kept.has(id) && !journaled.has(id)).sort();
  }
}
