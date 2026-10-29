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
import { dirname } from "node:path";

export type WalSync = () => Promise<void>;

// How long a sync may take before its callers are failed (T-532 saw single stalls of over 12 s on a saturated disk).
export const WAL_SYNC_TIMEOUT_MS = 30_000;

export class SyncTimeout extends Error {
  constructor(ms: number) { super(`the disk did not finish a sync within ${Math.round(ms / 1000)} s`); this.name = "SyncTimeout"; }
}

// Syncs the database's WAL file. Each sync opens its own handle: SQLite may reset or truncate the WAL between calls,
// and a fresh open always names the live file. The first one also syncs the directory, as SQLite does for a WAL it has
// just created (os_unix.c, the directory sync of a new journal): the agent's WAL is made anew after each clean close.
// One sync runs at a time. A call while one runs waits for the next, which covers its commit and every other made
// meanwhile: on a stalled disk the syncs cannot take every thread of libuv's pool (4), which the agent's other file
// work and the DNS lookup of a reconnect also need.
export function walSyncOf(db: Database.Database): WalSync {
  if (db.memory) return async () => {};                        // nothing on a disk: nothing to sync
  const wal = `${db.name}-wal`;
  let dirSynced = false;
  const once = async () => {
    const fh = await open(wal, "r+");
    try { await fh.sync(); } finally { await fh.close(); }
    if (!dirSynced) {
      const dir = await open(dirname(wal), "r");
      try { await dir.sync(); } finally { await dir.close(); }
      dirSynced = true;
    }
  };
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  const run = (): Promise<void> => {
    const p: Promise<void> = once().finally(() => { if (running === p) running = null; });
    running = p;
    return p;
  };
  return () => {
    if (running === null) return run();
    // The running sync may have begun before this caller's commit: it gets the next one, shared with every caller
    // that comes while this one runs.
    next ??= running.then(() => undefined, () => undefined).then(() => { next = null; return run(); });
    return next;
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


// A deadline for every sync. One the disk does not finish in `ms` fails its caller with SyncTimeout, which each store
// treats as a failed sync (its row is taken back, the answer says executed "no"), so no queue, flight or updater waits
// for ever. The fsync itself cannot be cancelled and keeps its libuv thread; while it is still out, every new call
// fails at once rather than start another, so a hung disk holds one thread, not the whole pool. Once it ends, syncs
// run again. A timed-out sync that lands later made durable a row its caller had already taken back: the take-back is
// a later commit, so the disk ends as the caller answered (executed "no"), unless a power loss falls between the two,
// when the row stands as `started` and a retry is answered uncertain, never run twice. Accepted (review).
export function bounded(sync: WalSync, ms: number): WalSync {
  let stuck: Promise<void> | null = null;
  return () => {
    if (stuck !== null) return Promise.reject(new SyncTimeout(ms));
    const run = sync();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const settled: Promise<void> = run.then(() => undefined, () => undefined).then(() => { if (stuck === settled) stuck = null; });
        stuck = settled;
        reject(new SyncTimeout(ms));
      }, ms);
      run.then(() => { clearTimeout(timer); resolve(); }, (e: unknown) => { clearTimeout(timer); reject(e); });
    });
  };
}

// What a store uses when it is handed none: its database's WAL sync, with the deadline.
export const durableSyncOf = (db: Database.Database): WalSync => bounded(walSyncOf(db), WAL_SYNC_TIMEOUT_MS);
