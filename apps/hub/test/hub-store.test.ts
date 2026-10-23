// The hub's store id (RL10, updates design §11.5, amending S5): the database file carries a store, renewed whenever the
// file's inode isn't the one recorded with it (a copy renamed over the file, as a restore does §11.4), so a Command the
// old store typed can never be typed again as though nothing happened. Every API answer names the store in Morndo-Store,
// so a device can stamp each Command with the store it saw before its first attempt (steering-store-stamp.test.ts).
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { log } from "../src/adapters/log.ts";
import { Store } from "../src/adapters/store.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-hub-store-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("the store id of the hub's database file", () => {
  it("a new database gets a store, and the same file keeps it across a reopen", () => {
    const first = new Store(dir);
    expect(first.storeId).toMatch(UUID);
    const id = first.storeId;
    first.close();
    const again = new Store(dir);
    expect(again.storeId).toBe(id);
    again.close();
  });

  it("a database made before the store row (a hub from before this migration) gets one on its next open, with no warning", () => {
    const db = new Database(join(dir, "morndo.db"));
    expect(migrate(db, MIGRATIONS.slice(0, 23)).to).toBe(23);
    db.close();
    const warned = vi.spyOn(log, "warn");
    const opened = new Store(dir);
    expect(opened.storeId).toMatch(UUID);
    expect(warned).not.toHaveBeenCalled();
    opened.close();
  });

  // A restore is exactly this (§11.4): the Backup's checked copy renamed over morndo.db, its -wal and -shm gone. The
  // copy lands under another inode, so it holds sends that belong to another file: a new store, before anything uses it.
  it("a copy renamed over the file starts a new store, and says so once", () => {
    const first = new Store(dir);
    const was = first.storeId;
    first.close();
    const backup = join(dir, "backup.db");                        // the Backup (§11.3): a copy of it, checked
    copyFileSync(join(dir, "morndo.db"), backup);
    rmSync(join(dir, "morndo.db"), { force: true });
    rmSync(join(dir, "morndo.db-wal"), { force: true });          // deleted before the rename, as a restore does
    rmSync(join(dir, "morndo.db-shm"), { force: true });
    renameSync(backup, join(dir, "morndo.db"));                   // a new inode
    const warned = vi.spyOn(log, "warn");
    const restored = new Store(dir);
    expect(restored.storeId).toMatch(UUID);
    expect(restored.storeId).not.toBe(was);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining("morndo.db is not the file this database was made in"));
    restored.close();
    // The renewed store is the file's now: the next open keeps it, in silence.
    const settled = new Store(dir);
    expect(settled.storeId).toBe(restored.storeId);
    settled.close();
  });
});

describe("every answer names the store (Morndo-Store)", () => {
  let hub: InProcessHub;
  afterEach(async () => { await hub.close(); });

  it("an ordinary answer and an error answer both carry the hub's store id", async () => {
    hub = await startInProcessHub();
    const health = await fetch(`${hub.base}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("morndo-store")).toBe(hub.store.storeId);
    const cookie = await hub.cookie();
    const error = await hub.post("/api/no-such-route", {}, { cookie: `__Host-morndo=${cookie}` });
    expect(error.status).toBe(404);
    expect(error.headers.get("morndo-store")).toBe(hub.store.storeId);
  });
});
