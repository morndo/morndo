// The hub's database: WAL with synchronous=NORMAL (fleet core §16.4), on its first open and after. better-sqlite3's own
// build default gives the same (SQLITE_DEFAULT_WAL_SYNCHRONOUS=1); the Store sets it, so a FULL there would show here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the hub's database", () => {
  it("runs WAL with synchronous=NORMAL on its first open and after", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    dirs.push(dir);
    for (let i = 0; i < 2; i++) {
      const s = new Store(dir);
      expect(s.db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(s.db.pragma("synchronous", { simple: true })).toBe(1);          // 1 = NORMAL
      s.close();
    }
  });
});
