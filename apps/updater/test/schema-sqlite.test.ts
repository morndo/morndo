// The SchemaInspector adapter's contract (design §4.6, §6.2 step 1, §11.1): each service's database opened
// read-only, its user_version and its schema floor read from the database itself — never a write, not even a
// WAL frame, so an idle database's bytes and mtime are unchanged after the read. A database a newer service
// wrote is read as it is; the plan compares it against the Manifest, and the refusal is the apply's decision.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databasePaths } from "../src/adapters/paths.ts";
import { SqliteSchemas } from "../src/adapters/schema-sqlite.ts";

let scratch = "";

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

// A hub database at user_version 5 — a newer service's shape, not the updater's own — with the floor row that
// service's runner would have written.
const hubAt = (version: number, floor: number): string => {
  const home = mkdtempSync(join(scratch, "home-"));
  const path = databasePaths(home, {}).hub;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma(`user_version = ${version}`);
  if (floor !== version) writeFloor(db, floor);
  db.close();
  return path;
};

describe("SqliteSchemas (§11.1)", () => {
  it("reads { schema, floor } from a database a newer service wrote", () => {
    const path = hubAt(5, 3);
    const schemas = new SqliteSchemas({ paths: { hub: path, fleet: path, node: path, connections: path } });
    expect(schemas.read("hub")).toEqual({ schema: 5, floor: 3 });
  });

  it("a database with no floor row counts the floor as its version (the fail-safe of §11.1)", () => {
    const path = hubAt(5, 5);
    const schemas = new SqliteSchemas({ paths: { hub: path, fleet: path, node: path, connections: path } });
    expect(schemas.read("hub")).toEqual({ schema: 5, floor: 5 });
  });

  it("a role whose database is not on this machine reads as null", () => {
    const home = mkdtempSync(join(scratch, "home-"));
    const schemas = new SqliteSchemas({ paths: databasePaths(home, {}) });
    expect(schemas.read("hub")).toBeNull();
    expect(schemas.read("fleet")).toBeNull();
    expect(schemas.read("node")).toBeNull();
    expect(schemas.read("connections")).toBeNull();
  });

  it("reads without touching the file: the bytes and the mtime are unchanged", () => {
    const path = hubAt(5, 3);
    const before = { bytes: readFileSync(path), stat: statSync(path) };
    const schemas = new SqliteSchemas({ paths: { hub: path, fleet: path, node: path, connections: path } });
    expect(schemas.read("hub")).toEqual({ schema: 5, floor: 3 });
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    const after = statSync(path);
    expect(after.size).toBe(before.stat.size);
    expect(after.mtimeMs).toBe(before.stat.mtimeMs);
  });
});

describe("databasePaths", () => {
  it("the four databases at their services' own paths, overridable by the environment", () => {
    const home = "/srv/upd-example";                          // made-up home: nothing here exists
    expect(databasePaths(home, {})).toEqual({
      hub: "/srv/upd-example/.local/share/morndo/morndo.db",
      fleet: "/srv/upd-example/.local/share/morndo-fleet/fleet.db",
      node: "/srv/upd-example/.local/state/morndo-node/agent.db",
      connections: "/srv/upd-example/.config/morndo-connections/connections.db",
    });
    expect(databasePaths(home, { MORNDO_HOME: "/srv/upd-hub", MORNDO_CONNECTIONS_HOME: "/srv/upd-conn" }))
      .toMatchObject({ hub: "/srv/upd-hub/morndo.db", connections: "/srv/upd-conn/connections.db" });
    // an override set but empty is not an override (the hold path's rule, service-kit/src/hold.ts)
    expect(databasePaths(home, { MORNDO_HOME: "" }).hub).toBe("/srv/upd-example/.local/share/morndo/morndo.db");
    expect(() => databasePaths("relative/home", {})).toThrow(/absolute/);
  });
});
