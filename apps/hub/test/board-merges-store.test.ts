// The board's merge records (B11): one row per recorded merge of a task's PR, kept beside the tasks so done can be
// held until the merge is live on every node, and the override when it was accepted anyway. Real Store in a temp dir,
// synthetic repos, shas and lanes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MergeRecord } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-merges-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const merge = (o: Partial<MergeRecord> = {}): MergeRecord => ({ repo: "morndo/morndo", sha: "abc1234", at: 100, by: "manager", override: null, ...o });

describe("board merges (migration 24)", () => {
  it("saves and reads a task's merges, ordered by time then sha; the same record again is ignored", () => {
    const store = new Store(tempDir());
    const first = merge({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", at: 100 });
    const later = merge({ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", at: 200 });
    const sameTime = merge({ sha: "ccccccccccccccccccccccccccccccccccccccc", at: 200 });
    store.saveMerge("T-1", first);
    store.saveMerge("T-1", { ...first, by: "someone-else", at: 999 });   // a replayed record: the first stands
    store.saveMerge("T-1", later);
    store.saveMerge("T-1", sameTime);
    expect(store.mergesOf("T-1")).toEqual([first, later, sameTime]);      // by at, then sha
    expect(store.mergesOf("T-2")).toEqual([]);
    store.close();
  });

  it("allMerges groups every task's merges in one query", () => {
    const store = new Store(tempDir());
    const a = merge({ sha: "1111111", at: 100 });
    const b = merge({ sha: "2222222", at: 200 });
    const other = merge({ repo: "acme/other", sha: "3333333", at: 300 });
    store.saveMerge("T-1", a);
    store.saveMerge("T-1", b);
    store.saveMerge("T-2", other);
    const all = store.allMerges();
    expect([...all.keys()]).toEqual(["T-1", "T-2"]);
    expect(all.get("T-1")).toEqual([a, b]);
    expect(all.get("T-2")).toEqual([other]);
    store.close();
  });

  it("an override lands on the task's morndo rows without one, and leaves other repos and set rows alone", () => {
    const store = new Store(tempDir());
    const mine = merge({ sha: "1111111", at: 100 });
    const upper = merge({ repo: "Morndo/Morndo", sha: "2222222", at: 100 });
    const other = merge({ repo: "acme/other", sha: "3333333", at: 100 });
    const already = merge({ sha: "4444444", at: 100, override: "kept" });
    store.saveMerge("T-1", mine);
    store.saveMerge("T-1", upper);
    store.saveMerge("T-1", other);
    store.saveMerge("T-1", already);
    store.overrideMerges("T-1", "pc rebuilds overnight");
    expect(store.mergesOf("T-1")).toEqual([
      { ...mine, override: "pc rebuilds overnight" },
      { ...upper, override: "pc rebuilds overnight" },
      other,
      already,
    ]);
    // a task with no merges, and one whose rows are all overridden: nothing to do, nothing breaks
    store.overrideMerges("T-2", "why");
    expect(store.mergesOf("T-2")).toEqual([]);
    store.close();
  });

  it("deleteMerge removes one row only", () => {
    const store = new Store(tempDir());
    const mine = merge({ sha: "1111111", at: 100 });
    const otherRepo = merge({ repo: "acme/other", sha: "2222222", at: 100 });
    store.saveMerge("T-1", mine);
    store.saveMerge("T-1", otherRepo);
    store.saveMerge("T-2", merge({ sha: "3333333", at: 100 }));
    store.deleteMerge("T-1", "MORNDO/MORNDO", "1111111");              // the repo matches without regard to case
    expect(store.mergesOf("T-1")).toEqual([otherRepo]);
    expect(store.mergesOf("T-2")).toHaveLength(1);                      // another task's row stays
    store.deleteMerge("T-1", "morndo/morndo", "1111111");               // nothing left to delete: no error
    expect(store.mergesOf("T-1")).toEqual([otherRepo]);
    store.close();
  });
});
