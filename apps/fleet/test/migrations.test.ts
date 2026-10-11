// fleet.db's numbered migrations (Global Constraints: in the style of the hub's): a fresh database gets every table,
// WAL, synchronous=NORMAL and fullfsync (fleet clients spec §6: only the intake, joins, revocations and epochs are
// synced, db-sync.test.ts); a database from a newer fleet service is refused and left untouched.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb } from "../src/adapters/db.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate, type Migration } from "../src/adapters/migrations.ts";
import { tempDir } from "./helpers/temp.ts";

const LATEST = MIGRATIONS.length;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const columns = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

describe("fleet.db migrations", () => {
  it("a fresh database gets every table, WAL, synchronous=NORMAL, fullfsync and foreign keys", () => {
    const db = openFleetDb(join(tempDir(), "data", "fleet.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(tables(db)).toEqual([
      "audit", "dead_letters", "deliveries", "hook_unrouted", "job_alert_since", "job_alerts", "job_routes", "job_unnoticed", "jobs", "join_codes",
      "lane_deliveries", "lane_events", "lanes", "nodes", "outbox", "sticky_lanes", "store_seqs", "stream_hwm",
    ]);
    expect(columns(db, "job_unnoticed")).toEqual(["node", "id"]);
    expect(columns(db, "job_alerts")).toEqual(["node", "id"]);
    expect(columns(db, "job_alert_since")).toEqual(["at"]);
    expect(columns(db, "job_routes")).toEqual(["notice_id", "node", "job_id", "dest_node"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job_routes'").all()).toContainEqual({ name: "job_routes_job" });
    expect(columns(db, "jobs")).toEqual(["node", "id", "lane", "name", "class", "state", "outcome", "exit_code", "duration_sec", "notify", "task", "notice", "at", "tail", "position", "reason", "error", "ended", "notice_dest", "node_notice"]);
    expect(columns(db, "nodes")).toEqual(["name", "public_key", "created_at", "revoked_at", "last_seen_at", "last_source", "agent_version", "conn_epoch"]);
    expect(columns(db, "join_codes")).toEqual(["hash", "node", "expires_at", "used_at"]);
    expect(columns(db, "stream_hwm")).toEqual(["node", "stream_id", "seq"]);
    expect(columns(db, "lanes")).toEqual(["name", "node", "worker_id", "registered_at", "conflict"]);
    expect(columns(db, "outbox")).toEqual(["id", "node", "stream_id", "seq", "path", "body", "created_at"]);
    expect(columns(db, "deliveries")).toEqual(["outbox_id", "subscriber", "state", "attempts", "next_at", "delivered_at"]);
    expect(columns(db, "audit")).toEqual(["seq", "at", "actor", "action", "node", "detail"]);
    expect(columns(db, "hook_unrouted")).toEqual(["path", "count", "latest_at"]);
    expect(columns(db, "store_seqs")).toEqual(["node", "store", "seq", "at"]);
    expect(columns(db, "lane_deliveries")).toEqual(["id", "node", "target", "state", "body", "updated_at", "alerted"]);
    expect(columns(db, "sticky_lanes")).toEqual(["name", "node", "at"]);
    expect(columns(db, "lane_events")).toEqual(["seq", "node", "window", "lane", "session_id", "event", "at", "body", "to_manager", "delivery_id"]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(1);                      // 1 = NORMAL: a commit isn't synced unless synced()
    expect(db.pragma("fullfsync", { simple: true })).toBe(1);                        // macOS's full flush for what is synced
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(migrate(db)).toEqual({ from: LATEST, to: LATEST });
    db.close();
  });

  it("a version 1 database (before hook_unrouted) is migrated to the latest, keeping its rows", () => {
    const path = join(tempDir(), "fleet.db");
    const old = new Database(path);
    migrate(old, MIGRATIONS.slice(0, 1));
    old.prepare("INSERT INTO nodes (name, public_key, created_at) VALUES ('pc', 'k', 1)").run();
    old.close();
    const db = openFleetDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(db.prepare("SELECT name FROM nodes").all()).toEqual([{ name: "pc" }]);
    expect(tables(db)).toContain("hook_unrouted");
    db.close();
  });

  it("a version 2 database (before store_seqs) is migrated to the latest, keeping its rows; migration 3 run again changes nothing", () => {
    const path = join(tempDir(), "fleet.db");
    const old = new Database(path);
    migrate(old, MIGRATIONS.slice(0, 2));
    old.prepare("INSERT INTO hook_unrouted (path, count, latest_at) VALUES ('/notify', 2, 1)").run();
    old.close();
    const db = openFleetDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(db.prepare("SELECT path, count FROM hook_unrouted").all()).toEqual([{ path: "/notify", count: 2 }]);
    expect(tables(db)).toContain("store_seqs");
    expect(() => MIGRATIONS[2]?.up(db)).not.toThrow();                               // guarded: the table is there already
    db.close();
  });

  it("a version 14 database (the jobs' tables, before the fleet clients') is migrated to the latest, keeping its rows; migration 15 run again changes nothing", () => {
    const path = join(tempDir(), "fleet.db");
    const old = new Database(path);
    migrate(old, MIGRATIONS.slice(0, 14));
    old.prepare("INSERT INTO lanes (name, node, worker_id, registered_at, conflict) VALUES ('manager', 'pc', 'pc.3fa2c1d0.1', 1, 0)").run();
    old.close();
    const db = openFleetDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(db.prepare("SELECT name, node FROM lanes").all()).toEqual([{ name: "manager", node: "pc" }]);
    expect(tables(db)).toEqual(expect.arrayContaining(["lane_deliveries", "lane_events", "sticky_lanes"]));
    expect(() => MIGRATIONS[14]?.up(db)).not.toThrow();                              // guarded: IF NOT EXISTS
    db.close();
  });

  it("lane_events takes to_manager 0, 1 or NULL, and nothing else", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const insert = db.prepare("INSERT INTO lane_events (node, window, lane, event, at, body, to_manager) VALUES ('pc', 'api', 'api', 'finished', 1, '{}', ?)");
    for (const v of [0, 1, null]) expect(() => insert.run(v)).not.toThrow();
    expect(() => insert.run(2)).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("numbers migrations 1, 2, 3 … with no gaps", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("refuses a database from a newer fleet service, and leaves it untouched", () => {
    const path = join(tempDir(), "fleet.db");
    const db = new Database(path);
    db.exec("CREATE TABLE future_thing (x)");
    db.pragma(`user_version = ${LATEST + 3}`);
    db.close();
    expect(() => openFleetDb(path)).toThrow(DatabaseFromFuture);
    const again = new Database(path);
    expect(again.pragma("user_version", { simple: true })).toBe(LATEST + 3);
    expect(tables(again)).toEqual(["future_thing"]);
    again.close();
  });

  it("a failing migration rolls back the whole run", () => {
    const db = new Database(join(tempDir(), "fleet.db"));
    const failing: Migration[] = [...MIGRATIONS, { version: LATEST + 1, name: "fails", up: d => { d.exec("CREATE TABLE half (x)"); throw new Error("boom"); } }];
    expect(() => migrate(db, failing)).toThrow(/boom/);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(tables(db)).toEqual([]);
    db.close();
  });
});
