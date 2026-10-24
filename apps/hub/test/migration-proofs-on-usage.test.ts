// Proof of work (board_proofs, migration 28) landing on top of usage detection (migrations 26 and 27). Both ancestors
// claimed 26; usage keeps 26 and 27 and board_proofs takes 28. Every way a database can reach the combined schema must
// end at the same shape with its rows kept: from the release before both (25), from the usage stack alone (27), and
// from nothing. Real SQLite files in a temp dir, synthetic names.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "../src/adapters/migrations.ts";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-proofs-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const version = (db: Database.Database) => db.pragma("user_version", { simple: true }) as number;
const upTo = (n: number) => MIGRATIONS.filter(m => m.version <= n);
// Every object's own SQL, so a missing column or index shows, not only a missing table.
const shape = (db: Database.Database) =>
  (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; sql: string | null }[])
    .map(r => `${r.type} ${r.name}: ${(r.sql ?? "").replace(/\s+/g, " ")}`);
const floor = (db: Database.Database) => db.prepare("SELECT * FROM _morndo_schema").all();

describe("board_proofs (28) on top of usage (26, 27)", () => {
  it("the list runs 1 to 28 with usage at 26 and 27 and board_proofs at 28, no number twice", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    expect(MIGRATIONS.find(m => m.version === 26)?.name).toMatch(/^usage \(S2\)/);
    expect(MIGRATIONS.find(m => m.version === 27)?.name).toMatch(/^usage \(S3\)/);
    expect(MIGRATIONS.find(m => m.version === 28)?.name).toMatch(/^board_proofs/);
  });

  it("a database written by today's build (25) migrates to 28 and keeps its rows", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, upTo(25));
    db.prepare("INSERT INTO board_merges (key, repo, sha, at, by) VALUES ('T-1', 'o/r', 'abc1234', 5, 'lane-a')").run();
    expect(version(db)).toBe(25);
    expect(migrate(db)).toEqual({ from: 25, to: 28 });
    expect(version(db)).toBe(28);
    expect(db.prepare("SELECT key, sha FROM board_merges").all()).toEqual([{ key: "T-1", sha: "abc1234" }]);
    for (const t of ["usage_sources", "usage_notices", "usage_watch", "usage_seats", "lane_accounts", "usage_pool_seats", "board_proofs"]) {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t).toBeDefined();
    }
    expect((db.prepare("PRAGMA table_info(agent_tokens)").all() as { name: string }[]).map(c => c.name)).toContain("scopes");
    db.close();
  });

  it("a database written by the usage stack alone (27) migrates to 28 and keeps its usage rows", () => {
    const db = new Database(join(tempDir(), "morndo.db"));
    migrate(db, upTo(27));
    db.prepare("INSERT INTO usage_seats (account, body) VALUES ('acct-a', '{\"plan\":\"x\"}')").run();
    db.prepare("INSERT INTO lane_accounts (node, lane, account, at, source) VALUES ('n1', 'lane-a', 'acct-a', 7, 'start')").run();
    db.prepare("INSERT INTO agent_tokens (id, name, role, secret_hash, scopes, created_at) VALUES ('t1', 'pool', 'worker', 'h1', 'usage-pool', 1)").run();
    expect(version(db)).toBe(27);
    expect(migrate(db)).toEqual({ from: 27, to: 28 });
    expect(db.prepare("SELECT account, body FROM usage_seats").all()).toEqual([{ account: "acct-a", body: "{\"plan\":\"x\"}" }]);
    expect(db.prepare("SELECT lane, source FROM lane_accounts").all()).toEqual([{ lane: "lane-a", source: "start" }]);
    expect(db.prepare("SELECT scopes FROM agent_tokens").all()).toEqual([{ scopes: "usage-pool" }]);
    expect(db.prepare("SELECT count(*) AS n FROM board_proofs").get()).toEqual({ n: 0 });
    db.close();
  });

  it("both upgrade paths and a fresh database end with the same schema and the same floor", () => {
    const fresh = new Database(join(tempDir(), "fresh.db"));
    migrate(fresh);
    const fromToday = new Database(join(tempDir(), "today.db"));
    migrate(fromToday, upTo(25));
    migrate(fromToday);
    const fromUsage = new Database(join(tempDir(), "usage.db"));
    migrate(fromUsage, upTo(27));
    migrate(fromUsage);
    expect(shape(fromToday)).toEqual(shape(fresh));
    expect(shape(fromUsage)).toEqual(shape(fresh));
    expect(floor(fromToday)).toEqual(floor(fresh));
    expect(floor(fromUsage)).toEqual(floor(fresh));
    for (const d of [fresh, fromToday, fromUsage]) d.close();
  });

  it("the Store opens a database at 25 and one at 27 and answers proof reads on both", () => {
    for (const at of [25, 27]) {
      const dir = tempDir();
      const raw = new Database(join(dir, "morndo.db"));
      migrate(raw, upTo(at));
      raw.close();
      const store = new Store(dir);
      store.seedProofs("T-1", 1, ["o/r@abc1234:ci"], 100);
      expect(store.proofResultsOf("T-1", 1), `from ${at}`).toEqual([{ ref: "o/r@abc1234:ci", state: "pending", detail: null, checkedAt: 100 }]);
      store.db.close();
    }
  });
});
