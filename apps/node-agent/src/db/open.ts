// The agent's own SQLite database (spec §6): done keys, the hook stream, the relay's file copies and background jobs, with this agent
// as the only writer. The file and its -wal and -shm are 0600 in a 0700 directory: hook bodies are kept here until the
// fleet has them.
// - WAL with synchronous=NORMAL (fleet core §16.4): a commit is not synced to the disk, so no hook waits for one.
//   "WAL mode is safe from corruption with synchronous=NORMAL"; it "might roll back following a power loss or system
//   crash", while "Transactions are durable across application crashes regardless of the synchronous setting"
//   (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-08). The one exception is a done key's
//   `started`, committed with FULL before its side effect (ops/done-keys.ts `synced`), with macOS's full flush: a retry
//   may go to another pane than the first attempt typed into, so no pane check can stand in for it. A hook the machine takes back came from a
//   lane that went down with it. Only on this machine's own disk (assertLocalDisk): WAL needs it.
// - Nothing is written before the schema version is known. The open itself (create without truncating, refuse a
//   newer or unreadable file before writing, 0600, close on failure) is openPrivateDb, shared with fleet and connections.
//   A file that isn't SQLite is DatabaseUnreadable from that helper. `journal_mode = WAL` alone would rewrite the header.
// - The store is tied to the database file (final review I2): with the stream id, meta keeps the file's identity, its
//   (device, inode), and compares the inode alone. A file opened under another inode was copied or restored (cp, a
//   backup put back, a move to another file system), so it holds done keys and a stream that belong to another file:
//   the database starts a new stream, so a new store, before anything uses it. A send in doubt then reads `unknown` from
//   another store, which can't vouch for its key, and stays uncertain (fail safe). Without hook traffic since the copy,
//   the fleet's ackSeq (agent.ts) can't tell; this can. The device number is kept for the log only: WSL2's distro disk,
//   btrfs subvolumes and external volumes can come back under another one (attach order), and comparing it started a
//   new store, with sends in doubt stuck uncertain and hook events sent twice, at such a start (the residual round).
//   Residual, not detected here: a block-level clone of a VM or a disk image keeps the inode, and so does a copy written
//   over the same file in place (cp onto the existing agent.db), or a restore that gets the freed inode number back
//   (file systems that reuse them, such as ext4, may). Those are caught by the store sequence instead: the fleet's
//   welcome says the highest storeSeq it saw from this store (storeSeqSeen), and a database behind it starts a new store
//   before running anything (agent.ts), while the hub keeps the storeSeq with a send in doubt. The cost of a false
//   alarm (a move across file systems): a new store, the safe direction. A database made before the identity was
//   recorded gets it recorded on its next open, as the original.
//   The events the copy still holds go out again under the new stream: at least once, never lost.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { assertLocalDisk, openPrivateDb } from "@morndo/service-kit";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./migrations.ts";

export { DatabaseUnreadable } from "@morndo/service-kit";

// copied: this open found the file under another identity than the one recorded, and started a new stream (I2).
export type AgentDb = { db: Database.Database; streamId: string; copied: boolean; close(): void };

// A new hook stream for this database, stored at once (spec §5.4). The agent does this when the fleet has accepted more
// of the stream than this database ever wrote: a database restored from a backup, whose next seqs the fleet would take
// for duplicates (Task 9, agent.ts). Its stream id is also the store id every `res` carries, so a caller asking about a
// key the restored database lost sees another store.
export function rotateStreamId(db: Database.Database): string {
  const id = randomUUID();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'streamId'").run(id);
  return id;
}

// The database file's identity, (device, inode), as the meta row keeps it. BigInt stats: an inode can pass 2^53.
function fileIdentity(path: string): string {
  const st = statSync(path, { bigint: true });
  return `${st.dev}:${st.ino}`;
}
// The inode of a recorded identity ("<device>:<inode>"): the part compared.
const inodeOf = (identity: string): string => identity.slice(identity.lastIndexOf(":") + 1);

// The stream id this file answers for: the stored one, or, when the file's inode isn't the one recorded with it, a new
// one stored with the new identity in one transaction. A database without an identity yet gets this one; one whose
// device number alone changed keeps its stream and gets the new identity recorded.
function streamOfThisFile(db: Database.Database, path: string): { streamId: string; copied: boolean } {
  const identity = fileIdentity(path);
  return db.transaction(() => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'streamId'").get() as { value: string } | undefined;
    if (!row) throw new Error(`${path} has no streamId`);
    const recorded = db.prepare("SELECT value FROM meta WHERE key = 'fileId'").get() as { value: string } | undefined;
    if (recorded?.value === identity) return { streamId: row.value, copied: false };
    db.prepare("INSERT INTO meta (key, value) VALUES ('fileId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(identity);
    if (recorded === undefined || inodeOf(recorded.value) === inodeOf(identity)) return { streamId: row.value, copied: false };
    return { streamId: rotateStreamId(db), copied: true };
  }).immediate();
}

export function openAgentDb(path: string): AgentDb {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertLocalDisk(dirname(path));
  const db = openPrivateDb(path, {
    synchronous: "NORMAL",
    knownVersion: MIGRATIONS.length,
    refuseNewer: (found, known) => new DatabaseFromFuture(found, known),
    migrate: database => {
      // On macOS a plain fsync() leaves the data in the drive's cache; F_FULLFSYNC flushes it ("Only Mac OS X supports
      // F_FULLFSYNC", https://www.sqlite.org/pragma.html#pragma_fullfsync, read 2026-10-08). Under NORMAL it costs only the
      // synced `started` and checkpoints. Elsewhere it does nothing.
      database.pragma("fullfsync = ON");
      migrate(database);
    },
  });
  try {
    const { streamId, copied } = streamOfThisFile(db, path);
    return { db, streamId, copied, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
