// The Revocations adapter (RL10): which ids a restore of an update's Backup would bring back — with the revocation
// journals subtracted, what the service re-applies at its start is no longer dropped.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { RevocationJournal } from "@morndo/service-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databasePaths } from "../src/adapters/paths.ts";
import { SqliteRevocations } from "../src/adapters/revocations-sqlite.ts";
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

  it("leaves out what the service's journal beside its database holds, since its start re-applies it", () => {
    // The hub's journal, as the hub writes it beside morndo.db: the endpoint's revocation is in it, the token's is
    // not (the hub re-applies the first at its start, so a restore may drop it; the second still gates).
    const home = join(scratch, "e");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    const hubTables = `CREATE TABLE endpoints (id TEXT PRIMARY KEY, revoked_at INTEGER);
      CREATE TABLE agent_tokens (id TEXT PRIMARY KEY, revoked_at INTEGER);`;
    db(join(backups, "upd-5", "hub.db"), `${hubTables}
      INSERT INTO endpoints VALUES ('phone-b', NULL); INSERT INTO agent_tokens VALUES ('tok-a', NULL);`);
    db(paths.hub, `${hubTables}
      INSERT INTO endpoints VALUES ('phone-b', 9); INSERT INTO agent_tokens VALUES ('tok-a', 9);`);
    new RevocationJournal(join(dirname(paths.hub), "revoked.log")).append({ kind: "endpoint", id: "phone-b", at: 9 });
    db(join(backups, "upd-5", "fleet.db"), "CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER); INSERT INTO nodes VALUES ('node-a', NULL);");
    db(paths.fleet, "CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER); INSERT INTO nodes VALUES ('node-a', 9);");
    new RevocationJournal(join(dirname(paths.fleet), "revoked.log")).append({ kind: "node", id: "node-a", at: 9 });
    const r = new SqliteRevocations({ paths, backups });
    expect(r.droppedBy("upd-5", "hub")).toEqual(["agent_tokens:tok-a"]);
    expect(r.droppedBy("upd-5", "fleet")).toEqual([]);
  });
});
