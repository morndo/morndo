// The open sequence the fleet service and the connections store share. An existing file is read before anything is
// written, so a newer schema or a file that is not SQLite is refused as it was. The file is created with "a", which
// does not truncate, so two first openers cannot empty it. better-sqlite3 then gets WAL and the caller's synchronous
// level. https://www.sqlite.org/pragma.html#pragma_synchronous read 2026-10-06, the same note fleet's open keeps.
import Database from "better-sqlite3";
import { chmodSync, closeSync, openSync, statSync } from "node:fs";
import { errno } from "./errno.ts";
import { schemaFloor } from "./migrate.ts";

export class DatabaseUnreadable extends Error {
  constructor(message: string) { super(message); this.name = "DatabaseUnreadable"; }
}

export class DatabaseBusy extends Error {
  readonly retryable = true;
  constructor(message: string) { super(message); this.name = "DatabaseBusy"; }
}

const UNREADABLE = new Set(["SQLITE_NOTADB", "SQLITE_CORRUPT"]);

function readable(path: string, error: unknown): unknown {
  const code = errno(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return new DatabaseBusy(`${path} is busy; retry`);
  if (UNREADABLE.has(code)) {
    return new DatabaseUnreadable(`${path} is not a SQLite database (or is damaged); move it away to start an empty one, or restore a backup`);
  }
  return error;
}

function privateDbFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try { chmodSync(file, 0o600); } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }
}

function refuseBeforeWriting(path: string, knownVersion: number, refuseNewer: (found: number, known: number) => Error): void {
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size === 0) return;
  let opened: Database.Database | null = null;
  try {
    opened = new Database(path, { readonly: true, fileMustExist: true });
    const found = opened.pragma("user_version", { simple: true }) as number;
    // The floor, not the version, refuses (§11.1): a newer database whose breaking migrations this program also knows
    // opens as it is; one whose floor is above it is refused before anything is written to it.
    if (schemaFloor(opened, found) > knownVersion) throw refuseNewer(found, knownVersion);
  } catch (error) {
    throw readable(path, error);
  } finally {
    opened?.close();
  }
}

export function openPrivateDb(path: string, options: {
  synchronous: "FULL" | "NORMAL";
  timeout?: number;
  foreignKeys?: boolean;
  knownVersion: number;
  refuseNewer: (found: number, known: number) => Error;
  migrate: (db: Database.Database) => void;
}): Database.Database {
  refuseBeforeWriting(path, options.knownVersion, options.refuseNewer);
  closeSync(openSync(path, "a", 0o600));
  privateDbFiles(path);
  const db = new Database(path, { timeout: options.timeout ?? 5000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma(`synchronous = ${options.synchronous}`);
    if (options.foreignKeys) db.pragma("foreign_keys = ON");
    options.migrate(db);
    privateDbFiles(path);
  } catch (error) {
    db.close();
    throw readable(path, error);
  }
  return db;
}
