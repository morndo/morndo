// The key pool's store (ADR-0037): one versioned row per pool in the Connections database, saved only on the version it was
// read at, a tombstone for a deleted pool so its name is never reused (KP1), and migration 4 additive.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyPool, type Actor, type KeyPool } from "@morndo/domain";
import { SqliteKeyPoolStore } from "../src/adapters/key-pool-store-sqlite.ts";
import { MIGRATIONS, migrate } from "../src/adapters/store-migrations.ts";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";

const who: Actor = { kind: "principal", command: "c1" };
const T = 1_700_000_000_000;
const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "morndo-keypool-store-"));
  dirs.push(dir);
  return join(dir, "connections.db");
}
function store(path: string): SqliteKeyPoolStore {
  const s = new SqliteKeyPoolStore(path);
  open.push(s);
  return s;
}
function pool(name = "p"): KeyPool {
  const made = createKeyPool({ name, runtime: "r", vendor: "v" }, { connections: [], pools: [], deleted: [] }, who, T);
  if (!made.ok) throw new Error("pool");
  return made.value;
}

describe("key-pool-store-sqlite", () => {
  it("has no pool and version 0 for a name it never saw, and lists nothing", () => {
    const s = store(file());
    expect(s.load("p")).toEqual({ pool: null, version: 0 });
    expect(s.names()).toEqual({ live: [], deleted: [] });
  });

  it("creates on version 0 once, and saves only on the version it read", () => {
    const s = store(file());
    expect(s.save(pool(), 0)).toBe(true);
    expect(s.save(pool(), 0)).toBe(false);                          // a second creator of the same name loses
    const read = s.load("p");
    expect(read.version).toBe(1);
    expect(read.pool).toEqual(pool());
    const changed = { ...pool(), cursor: "k1" };
    expect(s.save(changed, 1)).toBe(true);
    expect(s.save({ ...pool(), cursor: "k2" }, 1)).toBe(false);     // stale
    expect(s.load("p")).toEqual({ pool: changed, version: 2 });
  });

  it("round-trips through JSON as the domain left it, events and all", () => {
    const s = store(file());
    const made = pool();
    s.save(made, 0);
    expect(JSON.stringify(s.load("p").pool)).toBe(JSON.stringify(made));
  });

  it("lists live pools by name, and keeps a tombstone for a deleted one", () => {
    const s = store(file());
    s.save(pool("alpha"), 0);
    s.save(pool("beta"), 0);
    expect(s.names()).toEqual({ live: ["alpha", "beta"], deleted: [] });
    expect(s.tombstone("alpha", 0, T)).toBe(false);                 // stale version
    expect(s.tombstone("alpha", 1, T)).toBe(true);
    expect(s.load("alpha").pool).toBeNull();
    expect(s.load("alpha").version).toBe(2);
    expect(s.names()).toEqual({ live: ["beta"], deleted: ["alpha"] });
    expect(s.save(pool("alpha"), 0)).toBe(false);                   // the name is never reused
    expect(s.save(pool("alpha"), 2)).toBe(false);                   // nor revived on its tombstone's version
  });

  it("shares the database with the connections store, and a second open sees the same rows", () => {
    const path = file();
    const connections = new SqliteStore(path);
    open.push(connections);
    store(path).save(pool(), 0);
    expect(store(path).load("p").pool?.name).toBe("p");
    expect(connections.load().version).toBe(0);
  });
});

describe("migration 4", () => {
  it("is the last one, additive, and makes the key_pool table", () => {
    const last = MIGRATIONS.at(-1);
    expect(last?.version).toBe(4);
    expect(last?.compat).toBe("additive");
    const db = new Database(":memory:");
    open.push(db);
    migrate(db);
    const columns = db.prepare("PRAGMA table_info(key_pool)").all() as { name: string }[];
    expect(columns.map(c => c.name)).toEqual(["name", "version", "body"]);
  });

  it("a database at migration 3 (the previous release) migrates up and keeps its pool table and directory", () => {
    const db = new Database(":memory:");
    open.push(db);
    migrate(db, MIGRATIONS.slice(0, 3));
    db.prepare("INSERT INTO pool (runtime, version, body) VALUES ('codex', 1, '{}')").run();
    expect(migrate(db)).toEqual({ from: 3, to: 4 });
    expect(db.prepare("SELECT count(*) AS n FROM pool").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM key_pool").get()).toEqual({ n: 0 });
  });

  it("the previous release's tables are untouched: a build that knows only migrations 1-3 opens a database migrated to 4", () => {
    const path = file();
    store(path);                                                     // migrates to 4
    const old = new Database(path);
    open.push(old);
    const tables = (old.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map(t => t.name);
    for (const t of ["cas", "directory", "policy", "secrets", "pool"]) expect(tables).toContain(t);
    expect(() => old.prepare("SELECT version, body FROM directory, cas").all()).not.toThrow();
  });
});
