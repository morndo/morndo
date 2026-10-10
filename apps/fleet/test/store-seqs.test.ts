// The highest store sequence per (node, store) the fleet keeps in fleet.db (fleet core §5.2, §5.3; the fix wave's
// follow-up): raised by every answer that carries one, never lowered, kept across a restart, and a write that fleet.db
// refuses (another writer's lock) is logged and left for the next answer, never thrown into an agent's session.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb } from "../src/adapters/db.ts";
import { createLogger } from "../src/adapters/log.ts";
import { StoreSeqsStore } from "../src/adapters/store-seqs.ts";
import { tempDir } from "./helpers/temp.ts";

describe("store sequences in fleet.db", () => {
  it("keep the highest per node and store, never lower it, and read back after a restart", () => {
    const path = join(tempDir(), "fleet.db");
    const db = openFleetDb(path);
    const s = new StoreSeqsStore(db, { now: () => 5 });
    expect(s.highest("pc", "s1")).toBeNull();
    s.saw("pc", "s1", 3);
    s.saw("pc", "s1", 7);
    s.saw("pc", "s1", 4);                                          // lower: kept at 7
    s.saw("mac", "s1", 1);                                         // another node's store of that id: its own row
    s.saw("pc", "s2", 0);
    expect([s.highest("pc", "s1"), s.highest("mac", "s1"), s.highest("pc", "s2")]).toEqual([7, 1, 0]);
    db.close();
    const again = openFleetDb(path);                               // the fleet restarted
    const t = new StoreSeqsStore(again);
    expect(t.highest("pc", "s1")).toBe(7);
    expect(again.prepare("SELECT node, store, seq, at FROM store_seqs ORDER BY node, store").all()).toEqual([
      { node: "mac", store: "s1", seq: 1, at: 5 }, { node: "pc", store: "s1", seq: 7, at: 5 }, { node: "pc", store: "s2", seq: 0, at: 5 },
    ]);
    again.close();
  });

  it("a write fleet.db refuses (SQLITE_BUSY) is logged, nothing is thrown, and the next answer writes it", () => {
    const path = join(tempDir(), "fleet.db");
    const db = openFleetDb(path);
    db.pragma("busy_timeout = 0");
    const lines: string[] = [];
    const s = new StoreSeqsStore(db, { log: createLogger({ level: "debug", sink: l => { lines.push(l); } }) });
    const locker = new Database(path);
    locker.exec("BEGIN IMMEDIATE");
    try {
      expect(() => s.saw("pc", "s1", 2)).not.toThrow();
      expect(lines.some(l => l.includes("database is locked"))).toBe(true);
    } finally { locker.exec("ROLLBACK"); locker.close(); }
    s.saw("pc", "s1", 2);
    expect(new StoreSeqsStore(db).highest("pc", "s1")).toBe(2);
    db.close();
  });

  // The residual round: the read before a write (a cache miss) failing is logged too, and the value taken as unknown, so
  // the write still goes (it never lowers what is kept); a throw from saw() would close the agent's session with 1011.
  it("a read fleet.db refuses is logged, nothing is thrown, and the sequence is still written", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    let failReads = true;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (failReads && sql.trimStart().startsWith("SELECT")) throw new Error("disk I/O error");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const lines: string[] = [];
    const s = new StoreSeqsStore(flaky, { log: createLogger({ level: "debug", sink: l => { lines.push(l); } }) });
    db.prepare("INSERT INTO store_seqs (node, store, seq, at) VALUES ('pc', 's2', 9, 1)").run();
    expect(() => s.saw("pc", "s1", 3)).not.toThrow();
    expect(() => s.saw("pc", "s2", 4)).not.toThrow();                            // lower than what fleet.db keeps
    expect(lines.filter(l => l.includes("disk I/O error"))).toHaveLength(2);
    failReads = false;
    expect([s.highest("pc", "s1"), s.highest("pc", "s2")]).toEqual([3, 9]);     // written; never lowered, nor remembered lower
    expect(new StoreSeqsStore(db).highest("pc", "s1")).toBe(3);                    // in fleet.db
    db.close();
  });
});
