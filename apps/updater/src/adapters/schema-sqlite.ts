// The SchemaInspector adapter (design §4.6, §11.1): each service's database opened read-only — SQLite's
// user_version and the floor row read from the database itself, never a write, not even a WAL frame, so an
// idle database's bytes and mtime come out exactly as they went in. A database a newer service wrote is read
// as it is; comparing it against the Manifest's declared schemas is the apply's decision, not this reader's.
import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { schemaFloor } from "@morndo/service-kit";
import type { DatabaseName, DbState } from "@morndo/domain";
import type { DatabasePaths } from "./paths.ts";
import type { SchemaInspector } from "../application/ports.ts";

export class SqliteSchemas implements SchemaInspector {
  readonly #paths: DatabasePaths;

  constructor(o: { paths: DatabasePaths }) {
    this.#paths = o.paths;
  }

  read(name: DatabaseName): DbState | null {
    const path = this.#paths[name];
    try {
      statSync(path);
    } catch (error) {
      // a role whose database is not on this machine: nothing to read, not a failure (§6.2 step 1)
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const version = db.pragma("user_version", { simple: true }) as number;
      return { schema: version, floor: schemaFloor(db, version) };
    } finally {
      db.close();
    }
  }
}
