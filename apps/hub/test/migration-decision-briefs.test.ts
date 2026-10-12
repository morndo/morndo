// decision_briefs must not reuse migration 18: that number is manager_deliveries on the fleet-clients line (PR #34).
// A database already at 18 has that table and must still gain decision_briefs. Numbers stay unique and contiguous.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-migrate-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);

describe("the decision-brief migration", () => {
  it("numbers are unique and each is one more than the one before", () => {
    const versions = MIGRATIONS.map(m => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    versions.forEach((v, i) => expect(v).toBe(i + 1));
  });

  it("a database already at 18, with manager_deliveries, gets decision_briefs", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.slice(0, 17));
    db.exec(`CREATE TABLE manager_deliveries (
      delivery_id TEXT PRIMARY KEY, kind TEXT NOT NULL, endpoint_id TEXT NOT NULL,
      session_id TEXT NOT NULL, request_id TEXT NOT NULL, queued_at INTEGER NOT NULL,
      state TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    db.pragma("user_version = 18");
    expect(migrate(db)).toEqual({ from: 18, to: 19 });
    expect(tables(db)).toEqual(expect.arrayContaining(["manager_deliveries", "decision_briefs"]));
  });
});
