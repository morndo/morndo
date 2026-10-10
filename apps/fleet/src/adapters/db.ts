// Opens fleet.db: WAL, and synchronous=FULL, because a hook event is acknowledged to its node only after its outbox row
// commits (spec 5.6), and in WAL mode NORMAL may lose the last commits on a power cut
// (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-06). Unlike the node agent's (§16.4), what this
// database would lose is not lost with it: on a control plane apart from its nodes, a node deletes an event once the
// fleet has acknowledged it, while its lanes run on. Only on this machine's own disk (assertLocalDisk: WAL needs it).
// The service and its console commands both open it; better-sqlite3 waits up to 5 s on a lock by default.
// The open itself (create without truncating, refuse a newer or unreadable file before writing, 0600, close on
// failure) is openPrivateDb, shared with the connections store.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertLocalDisk, openPrivateDb } from "@morndo/service-kit";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./migrations.ts";

export { DatabaseUnreadable } from "@morndo/service-kit";

export function openFleetDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertLocalDisk(dirname(path));
  return openPrivateDb(path, {
    synchronous: "FULL",
    foreignKeys: true,
    knownVersion: MIGRATIONS.length,
    refuseNewer: (found, known) => new DatabaseFromFuture(found, known),
    migrate,
  });
}
