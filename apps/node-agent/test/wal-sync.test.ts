// T-532: the WAL sync itself, against a real database on disk (the other tests hand the stores a sync of their own).
// walSyncOf syncs the live -wal file and, once, its directory; one sync runs at a time and a caller that comes while one
// runs gets the next; a failure reaches its callers and the one after it starts afresh. bounded() gives every sync a
// deadline: a disk that never answers fails the callers, and while that sync is still out no new one is started.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAgentDb } from "../src/db/open.ts";
import { bounded, SyncTimeout, walSyncOf } from "../src/db/wal-sync.ts";

// Every FileHandle.sync() goes through here: what was synced, in order, and a way to hold the next one.
const fs = vi.hoisted(() => ({ synced: [] as string[], hold: null as Promise<void> | null, fail: null as Error | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (...args) => {
    const fh = await real.open(...args);
    const sync = fh.sync.bind(fh);
    fh.sync = async () => {
      fs.synced.push(String(args[0]));
      if (fs.hold) await fs.hold;
      if (fs.fail) throw fs.fail;
      await sync();
    };
    return fh;
  };
  return { ...real, open };
});

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  fs.synced.length = 0; fs.hold = null; fs.fail = null;
});
function agentDb() {
  const dir = mkdtempSync(join(tmpdir(), "wal-sync-"));
  dirs.push(dir);
  const adb = openAgentDb(join(dir, "agent.db"));
  closers.push(() => adb.close());
  adb.db.exec("CREATE TABLE IF NOT EXISTS t (x TEXT)");
  adb.db.prepare("INSERT INTO t VALUES (?)").run("a commit");
  return { adb, dir, path: join(dir, "agent.db") };
}

describe("walSyncOf, on a real database (T-532)", () => {
  it("syncs the -wal file, and the directory the first time only", async () => {
    const { adb, dir, path } = agentDb();
    const sync = walSyncOf(adb.db);
    await sync();
    await sync();
    expect(fs.synced).toEqual([`${path}-wal`, dir, `${path}-wal`]);
  });

  it("runs one sync at a time: callers that come while one runs share the next", async () => {
    const { adb } = agentDb();
    const sync = walSyncOf(adb.db);
    await sync();                                                     // the directory's one sync is done
    fs.synced.length = 0;
    let letGo = () => {};
    fs.hold = new Promise<void>(resolve => { letGo = resolve; });
    const calls = [sync(), sync(), sync(), sync()];
    await new Promise(r => setTimeout(r, 20));
    expect(fs.synced).toHaveLength(1);                                // the first runs; the rest wait for the next
    fs.hold = null;
    letGo();
    await Promise.all(calls);
    expect(fs.synced).toHaveLength(2);                                // the first, and one next for the other three
  });

  it("passes a failed sync to its callers, and the next call syncs afresh", async () => {
    const { adb } = agentDb();
    const sync = walSyncOf(adb.db);
    fs.fail = new Error("EIO");
    await expect(sync()).rejects.toThrow("EIO");
    fs.fail = null;
    await expect(sync()).resolves.toBeUndefined();
  });

  it("rejects when the database has no WAL file: nothing to make durable is not durable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wal-sync-"));
    dirs.push(dir);
    const db = new Database(join(dir, "plain.db"));                   // rollback journal: no -wal
    closers.push(() => db.close());
    db.exec("CREATE TABLE t (x)");
    await expect(walSyncOf(db)()).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bounded (T-532)", () => {
  it("fails a sync the disk never finishes, and starts no other one while it is out", async () => {
    let finish = () => {};
    let started = 0;
    const sync = bounded(() => { started += 1; return new Promise<void>(resolve => { finish = resolve; }); }, 200);
    const t0 = Date.now();
    await expect(sync()).rejects.toBeInstanceOf(SyncTimeout);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    await expect(sync()).rejects.toBeInstanceOf(SyncTimeout);        // at once: the stuck one still holds a thread
    expect(started).toBe(1);
    finish();                                                         // the disk answers at last
    await new Promise(r => setTimeout(r, 0));
    const after = sync();                                             // a new sync may start again
    expect(started).toBe(2);
    finish();
    await expect(after).resolves.toBeUndefined();
  });

  it("passes a sync that ends in time, and its errors, through as they are", async () => {
    await expect(bounded(async () => {}, 200)()).resolves.toBeUndefined();
    await expect(bounded(async () => { throw new Error("EIO"); }, 200)()).rejects.toThrow("EIO");
  });
});
