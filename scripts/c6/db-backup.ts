// SQLite helpers for backup.sh and restore.sh (node:sqlite), run with node --no-warnings:
//   db-backup.ts backup <src> <dest>   online copy, then PRAGMA quick_check on the copy; prints the copy's schema signature
//   db-backup.ts signature <path>      prints the schema signature: sha256 of select type,name,sql from sqlite_master
import { createHash } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";

function signature(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("select type,name,sql from sqlite_master order by 1,2").all() as { type: string; name: string; sql: string | null }[];
    const h = createHash("sha256");
    for (const r of rows) h.update(`${r.type}\u0000${r.name}\u0000${r.sql ?? ""}\n`);
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
