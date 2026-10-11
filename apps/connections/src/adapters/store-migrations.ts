// Schema for the connections directory (with its events) and the routing policy (ADR-0008 A1, design section 5).
// The store has no service that could be stopped for an update — its helper runs whenever an agent CLI needs a key —
// so its migrations are additive forever (ADR-0019 §11): the floor stays at 0 and any version's store opens.
import type Database from "better-sqlite3";
import { emptyDirectory, emptyPolicy } from "@morndo/domain";
import { migrate as runMigrations, type Migration } from "@morndo/service-kit";

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this store knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "connections directory, events and routing policy",
    compat: "additive",
    up: db => {
      db.exec(`
        CREATE TABLE cas (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
        CREATE TABLE directory (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
        CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO cas (id, version) VALUES (1, 0)").run();
      db.prepare("INSERT INTO directory (id, body) VALUES (1, ?)").run(JSON.stringify(emptyDirectory()));
      db.prepare("INSERT INTO policy (id, body) VALUES (1, ?)").run(JSON.stringify(emptyPolicy()));
    },
  },
];

export function migrate(db: Database.Database): { from: number; to: number } {
  return runMigrations(db, MIGRATIONS, (found, known) => new DatabaseFromFuture(found, known));
}
