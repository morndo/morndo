// The Backup adapter (design §4.6, §11.3, §11.4): a service's database copied through SQLite's own online
// backup API (better-sqlite3's db.backup,
// https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options, read 2026-10-21)
// — it restarts when another connection writes the source meanwhile, so a busy writer is the case, not the
// exception. The source is opened read-only (the service's database is copied, never touched), and the copy is
// proven before anything relies on it: quick_check must answer ok, and the schema the copy holds is read from
// the copy itself. A restore (§11.4) copies the checked backup beside the database, syncs it, removes a stale
// -wal/-shm that would corrupt the restored view, and renames the copy over the database.
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { DatabaseName } from "@morndo/domain";
import type { DatabasePaths } from "./paths.ts";
import type { Backup, BackupResult } from "../application/ports.ts";

export class SqliteBackup implements Backup {
  readonly #paths: DatabasePaths;
  readonly #backups: string;

  constructor(o: { paths: DatabasePaths; backups: string }) {
    this.#paths = o.paths;
    this.#backups = o.backups;
  }

  private file(updateId: string, db: DatabaseName): string {
    return join(this.#backups, updateId, `${db}.db`);
  }

  async take(updateId: string, db: DatabaseName): Promise<BackupResult> {
    const dir = join(this.#backups, updateId);
    const dest = this.file(updateId, db);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);                       // recursive mkdir keeps a mode it finds, not the one asked for
      const source = new Database(this.#paths[db], { readonly: true, fileMustExist: true });
      try {
        await source.backup(dest);                 // §11.3: the online backup API, restartable under a live writer
      } finally {
        source.close();
      }
      // the copy is proven from the copy: quick_check ok, and the schema it holds, read back (§11.3)
      const copy = new Database(dest, { readonly: true });
      try {
        const check = (copy.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
        if (check !== "ok") return { ok: false, reason: `${db}: quick_check answered ${JSON.stringify(check)}` };
        const schema = copy.pragma("user_version", { simple: true }) as number;
        chmodSync(dest, 0o600);                    // §11.3: private to its owner
        const fd = openSync(dest, "r+");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        const dirFd = openSync(dir, "r");
        try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        return { ok: true, schema };
      } finally {
        copy.close();
      }
    } catch (error) {
      rmSync(dest, { force: true });               // a partial copy is never left to be trusted
      return { ok: false, reason: `${db}: ${(error as Error).message}` };
    }
  }

  has(updateId: string, db: DatabaseName): boolean {
    return existsSync(this.file(updateId, db));
  }

  // §11.4: the checked backup goes back in, whole. The -wal/-shm beside the target are stale the moment the
  // main file is replaced — frames for a database that no longer exists — so they go first, then the rename.
  restore(updateId: string, db: DatabaseName): void {
    const backup = this.file(updateId, db);
    const target = this.#paths[db];
    const beside = `${target}.restore`;
    copyFileSync(backup, beside);
    const fd = openSync(beside, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    renameSync(beside, target);
    const dirFd = openSync(dirname(target), "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  prune(keep: readonly string[]): void {
    let entries;
    try {
      entries = readdirSync(this.#backups, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;   // never a backup taken: nothing to keep
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (keep.includes(entry.name)) continue;
      rmSync(join(this.#backups, entry.name), { recursive: true, force: true });
    }
  }
}
