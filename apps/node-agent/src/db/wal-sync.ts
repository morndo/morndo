// The disk sync behind every commit that must outlive its machine (a done key's `started`, a fresh delivery, a job's
// terminal row). In WAL mode, FULL differs from NORMAL only by "an additional sync operation of the WAL file ... after
// each transaction commit" (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-29), and one sync of
// the WAL keeps every commit appended before it too. So the commit runs as an ordinary NORMAL one and the `-wal` file
// is synced after it — through FileHandle.sync(), which runs on libuv's thread pool, not on the event loop. better-sqlite3
// is synchronous, so the old way (synchronous = FULL inside SQLite) held the agent's only thread in the fsync: on the
// owner's saturated disk that was 43 s of a 90 s window, one stall over 12 s, and the fleet's pings went unanswered
// while nothing else could run (T-532). The same flush, the same durability, off the loop.
// On darwin libuv's fsync is fcntl(F_FULLFSYNC) (falling back to F_BARRIERFSYNC, then fsync; libuv src/unix/fs.c,
// 1.52.1), which matches the fullfsync = ON this database asks SQLite for (db/open.ts).
import type Database from "better-sqlite3";
import { open } from "node:fs/promises";

export type WalSync = () => Promise<void>;

// Syncs the database's WAL file. Each call opens its own handle: SQLite may reset or truncate the WAL between calls,
// and a fresh open always names the live file.
export function walSyncOf(db: Database.Database): WalSync {
  if (db.memory) return async () => {};                        // nothing on a disk: nothing to sync
  return async () => {
    const fh = await open(`${db.name}-wal`, "r+");
    try { await fh.sync(); } finally { await fh.close(); }
  };
}

// One transaction committed at NORMAL, then the WAL synced: together the durability of synchronous = FULL, with the
// sync off the event loop. If the sync fails the commit itself stands; the caller decides what to undo.
export async function durably<T>(db: Database.Database, sync: WalSync, transaction: () => T): Promise<T> {
  if (db.inTransaction) throw new Error("durably() runs its own transaction; it can't be nested in another");
  const out = transaction();
  await sync();
  return out;
}
