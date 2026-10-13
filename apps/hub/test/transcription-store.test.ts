// Migration 20. 18 is manager_deliveries (fleet clients) and 19 is decision briefs; those lines merge first.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("transcription store", () => {
  it("migration 20 adds transcriptions after 18 and 19, and a second run changes nothing", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(MIGRATIONS.at(-1)?.version).toBe(20);
    expect(MIGRATIONS[17]?.name).toMatch(/manager_deliveries/);
    expect(MIGRATIONS[18]?.name).toMatch(/decision brief/i);
    expect(MIGRATIONS[19]?.name).toMatch(/transcription/);
    const dir = mkdtempSync(join(tmpdir(), "morndo-tx-"));
    dirs.push(dir);
    const db = new Database(join(dir, "morndo.db"));
    expect(migrate(db, MIGRATIONS.slice(0, 19))).toEqual({ from: 0, to: 19 });
    expect(migrate(db)).toEqual({ from: 19, to: 20 });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name);
    expect(tables).toContain("transcriptions");
    expect(tables).toContain("manager_deliveries");
    expect(tables).toContain("decision_briefs");
    expect(() => MIGRATIONS[19]?.up(db)).not.toThrow();
    db.close();
  });
});
