// The SQLite backup adapter's contract (design §4.6 Backup, §11.3, §11.4): a copy of a database another connection
// is still writing, proven before anything relies on it (quick_check ok, the schema read from the copy), kept
// private (0600 in a 0700 directory); a restore that puts the checked copy back and never leaves a stale -wal/-shm
// beside it. better-sqlite3's backup restarts when the source is written meanwhile, so a busy writer is the case,
// not the exception (§11.1, the connections store's rule).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databasePaths } from "../src/adapters/paths.ts";
import { SqliteBackup } from "../src/adapters/backup-sqlite.ts";
import { Store } from "../../hub/src/adapters/store.ts";

let scratch = "";

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const MANIFEST_FREE_ROW = "row-";            // made-up data: nothing here names anything real

// One world per case: a home with its four database paths, a hub database under WAL with three committed rows at
// user_version 5, and the backup adapter over a private backups directory.
const world = () => {
  const home = mkdtempSync(join(scratch, "home-"));
  const paths = databasePaths(home, {});
  mkdirSync(dirname(paths.hub), { recursive: true });
  const writer = new Database(paths.hub);
  writer.pragma("journal_mode = WAL");
  writer.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY, v TEXT)");
  const insert = writer.prepare(`INSERT INTO rows (v) VALUES (?)`);
  for (let i = 1; i <= 3; i++) insert.run(`${MANIFEST_FREE_ROW}${i}`);
  writer.pragma("user_version = 5");
  writeFloor(writer, 3);
  const backups = join(home, "state", "backups");
  return { home, paths, writer, backups, backup: new SqliteBackup({ paths, backups }) };
};

const rowsOf = (path: string): { count: number; check: string; version: number } => {
  const db = new Database(path, { readonly: true });
  try {
    return {
      count: (db.prepare("SELECT count(*) c FROM rows").get() as { c: number }).c,
      check: (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check,
      version: db.pragma("user_version", { simple: true }) as number,
    };
  } finally {
    db.close();
  }
};

const MODE = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe("SqliteBackup (§11.3, §11.4)", () => {
  it("takes a backup while another connection holds the database: ok, the committed rows, the schema read", async () => {
    const w = world();
    try {
      // a busy writer: a write transaction open and uncommitted while the backup runs
      w.writer.exec("BEGIN IMMEDIATE");
      w.writer.prepare("INSERT INTO rows (v) VALUES ('uncommitted')").run();
      const taken = await w.backup.take("u-1", "hub");
      w.writer.exec("ROLLBACK");
      expect(taken).toEqual({ ok: true, schema: 5 });
      const copy = rowsOf(join(w.backups, "u-1", "hub.db"));
      expect(copy).toEqual({ count: 3, check: "ok", version: 5 });   // the snapshot, not the uncommitted row
    } finally {
      w.writer.close();
    }
  });

  it("a source that is not a database answers ok:false, and nothing is left behind", async () => {
    const w = world();
    try {
      mkdirSync(dirname(w.paths.fleet), { recursive: true });
      writeFileSync(w.paths.fleet, "this is not an SQLite database at all, only text in its place");
      const taken = await w.backup.take("u-1", "fleet");
      expect(taken.ok).toBe(false);
      if (!taken.ok) expect(taken.reason).toMatch(/fleet/);
      expect(w.backup.has("u-1", "fleet")).toBe(false);
    } finally {
      w.writer.close();
    }
  });

  it("restores over a stale -wal and -shm: the database becomes the backup's rows, and opens cleanly", async () => {
    const w = world();
    try {
      expect((await w.backup.take("u-1", "hub")).ok).toBe(true);
      // two more rows land after the backup, their -wal/-shm stashed aside the way a crash would leave them
      w.writer.prepare("INSERT INTO rows (v) VALUES ('after the backup')").run();
      w.writer.prepare("INSERT INTO rows (v) VALUES ('after the backup too')").run();
      copyFileSync(`${w.paths.hub}-wal`, join(w.home, "stale-wal"));
      copyFileSync(`${w.paths.hub}-shm`, join(w.home, "stale-shm"));
      w.writer.close();                                              // a clean close checkpoints the wal away
      copyFileSync(join(w.home, "stale-wal"), `${w.paths.hub}-wal`);
      copyFileSync(join(w.home, "stale-shm"), `${w.paths.hub}-shm`);

      w.backup.restore("u-1", "hub");
      expect(existsSync(`${w.paths.hub}-wal`)).toBe(false);          // §11.4: a stale -wal would corrupt the restored view
      expect(existsSync(`${w.paths.hub}-shm`)).toBe(false);
      expect(rowsOf(w.paths.hub)).toEqual({ count: 3, check: "ok", version: 5 });
    } finally {
      try { w.writer.close(); } catch { /* closed by the case */ }
    }
  });

  it("a restored hub database is a new store, even back on the inode it had (RL10, §11.5)", async () => {
    // The hub's own store, as it runs: a store id tied to morndo.db. Backed up, then restored, the hub's next open
    // must answer as another store, whatever inode the rename leaves the file on.
    const home = mkdtempSync(join(scratch, "home-"));
    const paths = databasePaths(home, {});
    let hub = new Store(dirname(paths.hub));
    const before = hub.storeId;
    hub.close();
    const backup = new SqliteBackup({ paths, backups: join(home, "state", "backups") });
    expect((await backup.take("u-1", "hub")).ok).toBe(true);
    backup.restore("u-1", "hub");
    expect(existsSync(`${paths.hub}-wal`)).toBe(false);
    const restored = new Database(paths.hub, { readonly: true });
    try {
      expect(restored.prepare("SELECT count(*) AS n FROM hub_store").get()).toEqual({ n: 0 });
      expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
    } finally { restored.close(); }
    hub = new Store(dirname(paths.hub));
    try { expect(hub.storeId).not.toBe(before); } finally { hub.close(); }
  });

  it("a database that does not exist yet is backed up as absent, and restoring that removes what was made since", async () => {
    // A machine that never made a connections store: the update's plan still covers it (§11.3, a missing database is
    // the nothing it is). Its Backup is "absent", and going back puts the absence back: the Version that never had
    // the file starts without it, whatever the newer one wrote.
    const home = mkdtempSync(join(scratch, "home-"));
    const paths = databasePaths(home, {});
    const backup = new SqliteBackup({ paths, backups: join(home, "state", "backups") });
    expect(existsSync(paths.connections)).toBe(false);
    expect(await backup.take("u-1", "connections")).toEqual({ ok: true, schema: 0 });
    expect(backup.has("u-1", "connections")).toBe(true);
    expect(backup.has("u-2", "connections")).toBe(false);
    mkdirSync(dirname(paths.connections), { recursive: true });
    const made = new Database(paths.connections);               // the newer Version makes it, and writes
    made.exec("CREATE TABLE secrets (id TEXT)");
    made.close();
    writeFileSync(`${paths.connections}-wal`, "frames of a database that is going away");
    backup.restore("u-1", "connections");
    expect(existsSync(paths.connections)).toBe(false);
    expect(existsSync(`${paths.connections}-wal`)).toBe(false);
    expect(existsSync(`${paths.connections}-shm`)).toBe(false);
  });

  it("has() answers per update id and database; prune keeps only the named ids", async () => {
    const w = world();
    try {
      expect((await w.backup.take("u-1", "hub")).ok).toBe(true);
      expect((await w.backup.take("u-2", "hub")).ok).toBe(true);
      expect(w.backup.has("u-1", "hub")).toBe(true);
      expect(w.backup.has("u-2", "hub")).toBe(true);
      expect(w.backup.has("u-9", "hub")).toBe(false);
      w.backup.prune(["u-1"]);
      expect(w.backup.has("u-1", "hub")).toBe(true);
      expect(w.backup.has("u-2", "hub")).toBe(false);                // the last three committed Updates, kept (§11.3)
    } finally {
      w.writer.close();
    }
  });

  it("the copy is 0600 inside a 0700 directory (§11.3)", async () => {
    const w = world();
    try {
      expect((await w.backup.take("u-1", "hub")).ok).toBe(true);
      expect(MODE(join(w.backups, "u-1", "hub.db"))).toBe("600");
      expect(MODE(join(w.backups, "u-1"))).toBe("700");
    } finally {
      w.writer.close();
    }
  });
});
