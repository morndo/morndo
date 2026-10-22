// The Revocations adapter (RL10 before the journals): which ids a restore of an update's Backup would bring back.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databasePaths } from "../src/adapters/paths.ts";
import { SqliteRevocations } from "../src/adapters/revocations-sqlite.ts";
import { SqliteBackup } from "../src/adapters/backup-sqlite.ts";
import { wipe } from "./helpers/fakes.ts";

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

const db = (path: string, sql: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  const d = new Database(path);
  try { d.exec(sql); } finally { d.close(); }
};

describe("SqliteRevocations", () => {
  it("names what is revoked live and not in the backup, for the hub's endpoints and tokens and the fleet's nodes", () => {
    const home = join(scratch, "a");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    const tables = `CREATE TABLE endpoints (id TEXT PRIMARY KEY, revoked_at INTEGER);
      CREATE TABLE agent_tokens (id TEXT PRIMARY KEY, revoked_at INTEGER);`;
    db(join(backups, "upd-1", "hub.db"), `${tables}
      INSERT INTO endpoints VALUES ('phone-a', 5), ('phone-b', NULL); INSERT INTO agent_tokens VALUES ('tok-a', NULL);`);
    db(paths.hub, `${tables}
      INSERT INTO endpoints VALUES ('phone-a', 5), ('phone-b', 9); INSERT INTO agent_tokens VALUES ('tok-a', 9);`);
    db(join(backups, "upd-1", "fleet.db"), "CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER); INSERT INTO nodes VALUES ('node-a', NULL);");
    db(paths.fleet, "CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER); INSERT INTO nodes VALUES ('node-a', 9);");
    const r = new SqliteRevocations({ paths, backups });
    expect(r.droppedBy("upd-1", "hub")).toEqual(["agent_tokens:tok-a", "endpoints:phone-b"]);
    expect(r.droppedBy("upd-1", "fleet")).toEqual(["nodes:node-a"]);
  });

  it("finds nothing without a backup, for a database with no revocations, or a schema without the tables", () => {
    const home = join(scratch, "b");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    db(paths.hub, "CREATE TABLE lanes (id TEXT);");
    db(join(backups, "upd-2", "hub.db"), "CREATE TABLE lanes (id TEXT);");
    const r = new SqliteRevocations({ paths, backups });
    expect(r.droppedBy("upd-2", "hub")).toEqual([]);
    expect(r.droppedBy("upd-missing", "hub")).toEqual([]);
    expect(r.droppedBy("upd-2", "node")).toEqual([]);
  });

  it("names the connections store's revoked secrets and secret versions", () => {
    const home = join(scratch, "c");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    const tables = `CREATE TABLE secrets (reference TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE secret_versions (reference TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL);`;
    db(join(backups, "upd-3", "connections.db"), `${tables}
      INSERT INTO secrets VALUES ('vendor-key', 'active'); INSERT INTO secret_versions VALUES ('vendor-key', 1, 'current');`);
    db(paths.connections, `${tables}
      INSERT INTO secrets VALUES ('vendor-key', 'revoked'); INSERT INTO secret_versions VALUES ('vendor-key', 1, 'revoked');`);
    const r = new SqliteRevocations({ paths, backups });
    expect(r.droppedBy("upd-3", "connections")).toEqual(["secret_versions:vendor-key#1", "secrets:vendor-key"]);
  });


  it("names a connection revoked in the directory the connections store keeps as JSON", () => {
    // The connections store keeps its Connections in one row, directory.body, as JSON (apps/connections'
    // store-migrations.ts): a revoked Connection is status "revoked" there, not a row of its own.
    const home = join(scratch, "d");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    const directory = (status: string) => JSON.stringify({
      connections: [{ name: "vendor-a", status }, { name: "vendor-b", status: "on" }], events: [], seq: 3,
    });
    const table = "CREATE TABLE directory (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);";
    db(join(backups, "upd-4", "connections.db"), `${table} INSERT INTO directory VALUES (1, '${directory("on")}');`);
    db(paths.connections, `${table} INSERT INTO directory VALUES (1, '${directory("revoked")}');`);
    const r = new SqliteRevocations({ paths, backups });
    expect(r.droppedBy("upd-4", "connections")).toEqual(["directory:vendor-a"]);
  });

  it("against a Backup of a database that did not exist, every revocation made since would be dropped", async () => {
    const home = join(scratch, "absent");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    expect(await new SqliteBackup({ paths, backups }).take("upd-9", "connections")).toEqual({ ok: true, schema: 0 });
    db(paths.connections, `CREATE TABLE secrets (reference TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO secrets VALUES ('vendor-key', 'revoked'), ('other-key', 'active');`);
    expect(new SqliteRevocations({ paths, backups }).droppedBy("upd-9", "connections")).toEqual(["secrets:vendor-key"]);
  });
});
