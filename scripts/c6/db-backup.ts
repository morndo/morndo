// One online copy of a SQLite database (node:sqlite backup()): node --no-warnings db-backup.ts <src> <dest>
import { backup, DatabaseSync } from "node:sqlite";

const [src, dest] = process.argv.slice(2);
if (src === undefined || dest === undefined) {
  process.stderr.write("usage: db-backup.ts <src> <dest>\n");
  process.exit(2);
}
const db = new DatabaseSync(src);
try { await backup(db, dest); } finally { db.close(); }
