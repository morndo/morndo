// SQLite helpers for backup.sh and restore.sh (node:sqlite), run with node --no-warnings:
//   db-backup.ts backup <src> <dest>   online copy, then PRAGMA quick_check on the copy; prints the copy's schema signature
//   db-backup.ts signature <path>      prints the schema signature: sha256 of sqlite_master (type,name,sql), PRAGMA user_version and the rows of every *migrat* table
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
    // A migration may also change data the old code reads: the contents of every migrations table count.
    const tables = db.prepare("select name from sqlite_master where type = 'table' and name like '%migrat%' order by name").all() as { name: string }[];
    const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? Buffer.from(x).toString("hex") : x));
    for (const t of tables) {
      const q = `"${t.name.replaceAll('"', '""')}"`;
      let data: unknown[];
      try { data = db.prepare(`select * from ${q} order by rowid`).all(); } catch { data = db.prepare(`select * from ${q}`).all(); }
      h.update(`table\u0000${t.name}\n`);
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
