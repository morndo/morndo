// Opens fleet.db: WAL with synchronous=NORMAL, and the fleet core's §16.4 rule for what is synced (fleet clients spec
// §6; issue #21). A commit is synced to the disk only when what it guards must outlive the machine:
// - synced (`synced()`, synchronous=FULL for that one transaction): the intake that precedes acknowledging hook events to
//   a node, lane events included (the node deletes its copy once acknowledged, and on a control plane apart from its
//   nodes those nodes' lanes run on: application/intake-window.ts); a join, a revocation (a node's key, given or taken),
//   and a node's next connection epoch (a fencing token that must only grow, across a power loss too);
// - not synced: the delivered marks of the hook bus and of the manager's lane events (a lost mark means one more
//   delivery, which the receiver skips by its key or id), the deliveries' mirror, sticky lane names, the audit, alerts.
// "WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability. A transaction committed in
// WAL mode with synchronous=NORMAL might roll back following a power loss or system crash"; with FULL "an additional sync
// operation of the WAL file happens after each transaction commit" (https://www.sqlite.org/pragma.html#pragma_synchronous,
// read 2026-10-08). On macOS a plain fsync() leaves the data in the drive's cache; F_FULLFSYNC flushes it ("Only Mac OS X
// supports F_FULLFSYNC"; with the fullfsync flag set "the F_FULLFSYNC syncing method is used for all sync operations and
// the checkpoint_fullfsync setting is irrelevant", https://www.sqlite.org/pragma.html#pragma_fullfsync, read 2026-10-08).
// Elsewhere it does nothing. Only on this machine's own disk (assertLocalDisk: WAL needs it).
// The service and its console commands both open it; better-sqlite3 waits up to 5 s on a lock by default.
// The open itself (create without truncating, refuse a newer or unreadable file before writing, 0600, close on
// failure) is openPrivateDb, shared with the connections store.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertLocalDisk, openPrivateDb } from "@morndo/service-kit";
import type { Transactions } from "../application/hook-sink.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./migrations.ts";

export { DatabaseUnreadable } from "@morndo/service-kit";

export function openFleetDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertLocalDisk(dirname(path));
  return openPrivateDb(path, {
    synchronous: "NORMAL",
    foreignKeys: true,
    knownVersion: MIGRATIONS.length,
    refuseNewer: (found, known) => new DatabaseFromFuture(found, known),
    migrate: database => {
      database.pragma("fullfsync = ON");                // macOS: synced commits reach the disk, not its cache (above)
      migrate(database);
    },
  });
}

// Runs one transaction with synchronous=FULL, then sets the connection back to NORMAL (as the agent's done keys do,
// apps/node-agent/src/ops/done-keys.ts). Its own transaction only: SQLite refuses to change the setting inside one ("Safety
// level may not be changed inside a transaction"). A transaction left open (a rollback that failed) keeps FULL, slower but
// safe, rather than hiding the error behind the setting's.
export function synced<T>(db: Database.Database, transaction: () => T): T {
  if (db.inTransaction) throw new Error("synced() runs its own transaction; it can't be nested in another");
  db.pragma("synchronous = FULL");
  try { return transaction(); } finally { if (!db.inTransaction) db.pragma("synchronous = NORMAL"); }
}

// fleet.db's transactions for the intake (application/intake-window.ts): one IMMEDIATE transaction synced to the disk,
// and a savepoint inside it, so one connection's events that fail roll back alone.
export function fleetTransactions(db: Database.Database): Transactions {
  return {
    synced: fn => synced(db, () => db.transaction(fn).immediate()),
    savepoint: fn => db.transaction(fn)(),
  };
}
