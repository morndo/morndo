// One SQLite file for the directory, its events and the routing policy. save lands only when the version still matches.
import Database from "better-sqlite3";
import { chmodSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assertLocalDisk, openPrivateDb } from "@morndo/service-kit";
import type { Directory, Policy } from "@morndo/domain";
import type { ConnectionStore } from "../application/ports.ts";
import { FileRefused, assertPrivate, ensurePrivateDir, refuseBareHome, writePrivate } from "./file-mode.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./store-migrations.ts";

const STORE_DIR = "morndo-connections";
const STORE_MARK = ".morndo-store";

function recognisedStoreDir(dir: string): boolean {
  return basename(dir) === STORE_DIR || existsSync(join(dir, STORE_MARK));
}

// Shared with secrets-sqlite.ts, which opens the same file.
export function adoptStoreDir(dir: string, uid: number): void {
  let mode: number;
  let owner: number;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return;
    mode = st.mode & 0o777;
    owner = st.uid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (owner !== uid) throw new FileRefused("owner", dir);
  if ((mode & ~0o700) === 0) return;
  if (!recognisedStoreDir(dir)) throw new FileRefused("mode", dir);
  console.warn(`tightening ${dir} to 0700; it was looser than a private directory`);
  chmodSync(dir, 0o700);
}

export function markStoreDir(dir: string, uid: number): void {
  const marker = join(dir, STORE_MARK);
  if (existsSync(marker)) return;
  writePrivate(marker, new TextEncoder().encode("morndo-connections\n"), uid);
}

type StoreHooks = {
  afterVersion?: () => void;
  afterOpen?: (db: Database.Database) => void;
};

export class SqliteStore implements ConnectionStore {
  readonly #db: Database.Database;
  readonly #readVersion: Database.Statement;
  readonly #readDirectory: Database.Statement;
  readonly #readPolicy: Database.Statement;
  readonly #bump: Database.Statement;
  readonly #writeDirectory: Database.Statement;
  readonly #writePolicy: Database.Statement;
  #closed = false;
  readonly #hooks: StoreHooks;

  constructor(path: string, uid?: number, hooks?: StoreHooks) {
    this.#hooks = hooks ?? {};
    const owner = uid ?? process.getuid?.() ?? -1;
    const dir = dirname(path);
    refuseBareHome(path);
    assertLocalDisk(dir);
    adoptStoreDir(dir, owner);
    ensurePrivateDir(dir, owner);
    markStoreDir(dir, owner);
    assertPrivate(path, "file", owner);
    this.#db = openPrivateDb(path, {
      synchronous: "NORMAL",
      knownVersion: MIGRATIONS.length,
      refuseNewer: (found, known) => new DatabaseFromFuture(found, known),
      migrate: db => {
        this.#hooks.afterOpen?.(db);
        migrate(db);
      },
    });
    this.#readVersion = this.#db.prepare("SELECT version FROM cas WHERE id = 1");
    this.#readDirectory = this.#db.prepare("SELECT body FROM directory WHERE id = 1");
    this.#readPolicy = this.#db.prepare("SELECT body FROM policy WHERE id = 1");
    this.#bump = this.#db.prepare("UPDATE cas SET version = ? WHERE id = 1 AND version = ?");
    this.#writeDirectory = this.#db.prepare("UPDATE directory SET body = ? WHERE id = 1");
    this.#writePolicy = this.#db.prepare("UPDATE policy SET body = ? WHERE id = 1");
  }

  load(): { directory: Directory; policy: Policy; version: number } {
    return this.#db.transaction(() => {
      const version = this.#readVersion.get() as { version: number } | undefined;
      this.#hooks.afterVersion?.();
      const directory = this.#readDirectory.get() as { body: string } | undefined;
      const policy = this.#readPolicy.get() as { body: string } | undefined;
      if (!version || !directory || !policy) throw new Error("store is empty");
      return { directory: JSON.parse(directory.body) as Directory, policy: JSON.parse(policy.body) as Policy, version: version.version };
    })();
  }

  save(directory: Directory, policy: Policy, version: number): boolean {
    const directoryBody = JSON.stringify(directory);
    const policyBody = JSON.stringify(policy);
    return this.#db.transaction(() => {
      const changed = this.#bump.run(version + 1, version);
      if (changed.changes !== 1) return false;
      this.#writeDirectory.run(directoryBody);
      this.#writePolicy.run(policyBody);
      return true;
    }).immediate();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
