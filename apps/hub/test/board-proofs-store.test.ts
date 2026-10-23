// The board's proof results (B14, ADR-0035): one row per reference of a brief, its state as the hub read it, kept in
// rows of their own so a re-check never touches the task or its events. Real Store in a temp dir, synthetic repos,
// shas and lanes.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-proofs-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const pending = (ref: string, checkedAt: number) => ({ ref, state: "pending", detail: null, checkedAt });

describe("board proofs (migration 26)", () => {
  it("migration 26 adds board_proofs to a database at 25 and leaves the older tables alone", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, MIGRATIONS.filter(m => m.version <= 25));       // a hub of the release before
    expect(version(db)).toBe(25);
    const before = tables(db);
    migrate(db);                                                // the newer hub opens it as it is
    expect(version(db)).toBe(26);
    expect(tables(db)).toEqual([...before, "board_proofs"].sort());
    const info = db.prepare("PRAGMA table_info(board_proofs)").all() as { name: string; pk: number }[];
    expect(info.map(c => c.name)).toEqual(["key", "brief_rev", "ref", "state", "detail", "checked_at"]);
    expect(info.filter(c => c.pk > 0).map(c => c.name)).toEqual(["key", "brief_rev", "ref"]);
    const m26 = MIGRATIONS.find(m => m.version === 26);         // guarded: the table is there already
    expect(m26).toBeDefined();
    expect(() => m26?.up(db)).not.toThrow();
    expect(() => m26?.up(db)).not.toThrow();
    db.close();
  });

  it("seedProofs writes one pending row per ref and a row that exists stands", () => {
    const store = new Store(tempDir());
    store.seedProofs("T-1", 4, ["morndo/morndo@3e9d1a7:ci,lint", "morndo/morndo#42@3e9d1a7"], 100);
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      pending("morndo/morndo#42@3e9d1a7", 100),                 // ordered by ref
      pending("morndo/morndo@3e9d1a7:ci,lint", 100),
    ]);
    store.saveProofResult("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: 200 });
    store.seedProofs("T-1", 4, ["morndo/morndo#42@3e9d1a7", "morndo/morndo@3e9d1a7:ci,lint"], 300);   // a replayed seed
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: 200 },   // the row stands
      pending("morndo/morndo@3e9d1a7:ci,lint", 100),
    ]);
    store.close();
  });

  it("saveProofResult upserts and proofResultsOf orders by ref", () => {
    const store = new Store(tempDir());
    store.seedProofs("T-1", 4, ["morndo/morndo#42@3e9d1a7", "morndo/morndo#43@abcdef1", "morndo/morndo@3e9d1a7:ci,lint"], 100);
    store.saveProofResult("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: 200 });
    store.saveProofResult("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "red", detail: "ci: lint failed", checkedAt: 300 });   // the upsert: one row, the later check
    store.saveProofResult("T-1", 4, { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "unfetchable", detail: "no route to the forge", checkedAt: 400 });
    expect(store.proofResultsOf("T-1", 4)).toEqual([
      { ref: "morndo/morndo#42@3e9d1a7", state: "red", detail: "ci: lint failed", checkedAt: 300 },
      pending("morndo/morndo#43@abcdef1", 100),
      { ref: "morndo/morndo@3e9d1a7:ci,lint", state: "unfetchable", detail: "no route to the forge", checkedAt: 400 },
    ]);
    store.close();
  });

  it("rows of two briefs of one task, and of two tasks, are kept apart", () => {
    const store = new Store(tempDir());
    store.seedProofs("T-1", 4, ["morndo/morndo#42@3e9d1a7"], 100);
    store.seedProofs("T-1", 7, ["morndo/morndo#42@3e9d1a7"], 200);   // a second round of work, a new brief
    store.seedProofs("T-2", 3, ["morndo/morndo#42@3e9d1a7"], 300);
    store.saveProofResult("T-1", 4, { ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: 400 });
    store.saveProofResult("T-1", 7, { ref: "morndo/morndo#42@3e9d1a7", state: "mismatch", detail: "head moved to 98765ab", checkedAt: 500 });
    store.saveProofResult("T-2", 3, { ref: "morndo/morndo#42@3e9d1a7", state: "missing", detail: "no such check", checkedAt: 600 });
    expect(store.proofResultsOf("T-1", 4)).toEqual([{ ref: "morndo/morndo#42@3e9d1a7", state: "green", detail: null, checkedAt: 400 }]);
    expect(store.proofResultsOf("T-1", 7)).toEqual([{ ref: "morndo/morndo#42@3e9d1a7", state: "mismatch", detail: "head moved to 98765ab", checkedAt: 500 }]);
    expect(store.proofResultsOf("T-2", 3)).toEqual([{ ref: "morndo/morndo#42@3e9d1a7", state: "missing", detail: "no such check", checkedAt: 600 }]);
    expect(store.proofResultsOf("T-1", 5)).toEqual([]);        // a rev nothing was ever seeded at
    store.close();
  });

  it("a row with a state this build does not know reads as unfetchable", () => {
    const store = new Store(tempDir());
    store.seedProofs("T-1", 4, ["morndo/morndo#42@3e9d1a7"], 100);
    store.db.prepare("UPDATE board_proofs SET state = 'fromthefuture' WHERE key = 'T-1'").run();   // a newer hub wrote it
    expect(store.proofResultsOf("T-1", 4)).toEqual([{ ref: "morndo/morndo#42@3e9d1a7", state: "unfetchable", detail: "unknown state", checkedAt: 100 }]);
    store.close();
  });
});
