// The Revocations adapter (RL10 before the journals): which ids a restore of an update's Backup would bring back.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
});
