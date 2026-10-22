// The Revocations adapter (RL10): which ids a restore of an update's Backup would bring back — with the revocation
// journals subtracted, what the service re-applies at its start is no longer dropped.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { RevocationJournal } from "@morndo/service-kit";
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
    const r = new SqliteRevocations({ paths, backups, releases: join(home, "releases") });
    expect(r.droppedBy("upd-1", "hub", "0.1.0")).toEqual(["agent_tokens:tok-a", "endpoints:phone-b"]);
    expect(r.droppedBy("upd-1", "fleet", "0.1.0")).toEqual(["nodes:node-a"]);
  });

  it("finds nothing without a backup, for a database with no revocations, or a schema without the tables", () => {
    const home = join(scratch, "b");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    db(paths.hub, "CREATE TABLE lanes (id TEXT);");
    db(join(backups, "upd-2", "hub.db"), "CREATE TABLE lanes (id TEXT);");
    const r = new SqliteRevocations({ paths, backups, releases: join(home, "releases") });
    expect(r.droppedBy("upd-2", "hub", "0.1.0")).toEqual([]);
    expect(r.droppedBy("upd-missing", "hub", "0.1.0")).toEqual([]);
    expect(r.droppedBy("upd-2", "node", "0.1.0")).toEqual([]);
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
    const r = new SqliteRevocations({ paths, backups, releases: join(home, "releases") });
    expect(r.droppedBy("upd-3", "connections", "0.1.0")).toEqual(["secret_versions:vendor-key#1", "secrets:vendor-key"]);
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
    const r = new SqliteRevocations({ paths, backups, releases: join(home, "releases") });
    expect(r.droppedBy("upd-4", "connections", "0.1.0")).toEqual(["directory:vendor-a"]);
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
    const fleetTable = "CREATE TABLE nodes (name TEXT PRIMARY KEY, revoked_at INTEGER, enrolment TEXT);";
    db(join(backups, "upd-5", "fleet.db"), `${fleetTable} INSERT INTO nodes VALUES ('node-a', NULL, 'en-1'), ('node-b', NULL, 'en-2');`);
    db(paths.fleet, `${fleetTable} INSERT INTO nodes VALUES ('node-a', 9, 'en-1'), ('node-b', 9, 'en-3');`);
    const fleetJournal = new RevocationJournal(join(dirname(paths.fleet), "revoked.log"));
    fleetJournal.append({ kind: "node", id: "node-a", enrolment: "en-1", at: 9 });
    // node-b was revoked as en-1 long ago, joined again (en-2, the backup's), and that enrolment's revocation (it
    // is revoked live as en-3 after a third join) is not journaled: the old entry must not cover what the backup holds
    fleetJournal.append({ kind: "node", id: "node-b", enrolment: "en-1", at: 2 });
    const releases = join(home, "releases");
    // the Version going back in applies journals: its tree has each service's applier
    for (const f of ["app/apps/hub/src/application/revocations.ts", "app/apps/fleet/src/application/revocations.ts"]) {
      mkdirSync(dirname(join(releases, "0.1.0", f)), { recursive: true });
      writeFileSync(join(releases, "0.1.0", f), "// applies the journal\n");
    }
    mkdirSync(join(releases, "0.0.9", "app"), { recursive: true });   // one from before the journals
    const r = new SqliteRevocations({ paths, backups, releases });
    expect(r.droppedBy("upd-5", "hub", "0.1.0")).toEqual(["agent_tokens:tok-a"]);
    expect(r.droppedBy("upd-5", "fleet", "0.1.0")).toEqual(["nodes:node-b"]);
    // rolling back to a Version that applies no journal: the journal excuses nothing
    expect(r.droppedBy("upd-5", "hub", "0.0.9")).toEqual(["agent_tokens:tok-a", "endpoints:phone-b"]);
    expect(r.droppedBy("upd-5", "fleet", "0.0.9")).toEqual(["nodes:node-a", "nodes:node-b"]);
  });

  it("against a Backup of a database that did not exist, every revocation made since would be dropped", async () => {
    const home = join(scratch, "absent");
    const paths = databasePaths(home, {});
    const backups = join(home, "backups");
    expect(await new SqliteBackup({ paths, backups }).take("upd-9", "connections")).toEqual({ ok: true, schema: 0 });
    db(paths.connections, `CREATE TABLE secrets (reference TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO secrets VALUES ('vendor-key', 'revoked'), ('other-key', 'active');`);
    expect(new SqliteRevocations({ paths, backups, releases: join(home, "releases") }).droppedBy("upd-9", "connections", "0.1.0"))
      .toEqual(["secrets:vendor-key"]);
  });
});
