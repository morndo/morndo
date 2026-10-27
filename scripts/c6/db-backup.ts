// SQLite helpers for backup.sh and restore.sh (node:sqlite), run with node --no-warnings:
//   db-backup.ts backup <src> <dest>   online copy, then PRAGMA quick_check on the copy; prints the copy's schema signature
//   db-backup.ts signature <path>      prints the schema signature: sha256 of sqlite_master (type,name,sql), PRAGMA user_version
//                                      and the rows of the table _morndo_schema
// The signature counts exactly the migration record: the schema itself (sqlite_master), SQLite's PRAGMA user_version, and
// the rows of _morndo_schema, the one-row compat-floor table the shared migration runner writes (packages/service-kit/src/
// migrate.ts, ADR-0019). It does NOT count the rows of any other table that merely has "migrat" in its name: a lock, a
// last-run time or a history table changes while the system runs and would make an ordinary run look like a migration.
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";

function signature(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const h = createHash("sha256");
    const rows = db.prepare("select type,name,sql from sqlite_master order by 1,2").all() as { type: string; name: string; sql: string | null }[];
    for (const r of rows) h.update(`${r.type}\u0000${r.name}\u0000${r.sql ?? ""}\n`);
    const uv = db.prepare("PRAGMA user_version").get() as { user_version: number };
    h.update(`user_version\u0000${uv.user_version}\n`);
    // The compat floor a migration may move without changing any table: the rows of _morndo_schema (only that table).
    const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x));
    if (db.prepare("select 1 from sqlite_master where type = 'table' and name = '_morndo_schema'").get() !== undefined) {
      let data: unknown[];
      try { data = db.prepare("select * from _morndo_schema order by rowid").all(); } catch { data = db.prepare("select * from _morndo_schema").all(); }
      h.update("table\u0000_morndo_schema\n");
      for (const row of data) h.update(`${json(row)}\n`);
    }
    return h.digest("hex");
  } finally { db.close(); }
}

const [mode, a, b] = process.argv.slice(2);
if (mode === "backup" && a !== undefined && b !== undefined) {
  const db = new DatabaseSync(a);
  try { await backup(db, b); } finally { db.close(); }
  const copy = new DatabaseSync(b, { readOnly: true });
  try {
    const row = copy.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (row.quick_check !== "ok") { process.stderr.write(`db-backup.ts: quick_check of ${b} says: ${row.quick_check}\n`); process.exit(1); }
  } finally { copy.close(); }
  process.stdout.write(`${signature(b)}\n`);
} else if (mode === "signature" && a !== undefined) {
  process.stdout.write(`${signature(a)}\n`);
} else {
  process.stderr.write("usage: db-backup.ts backup <src> <dest> | signature <path>\n");
  process.exit(2);
}
