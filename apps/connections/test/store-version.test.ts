// version() is the number load() reports, read on its own. A store with no version row fails the same way load does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { emptyDirectory, emptyPolicy } from "@morndo/domain";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";

describe("SqliteStore.version", () => {
  let dir = "";
  const open: SqliteStore[] = [];
  afterEach(() => {
    for (const store of open) store.close();
    open.length = 0;
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("reads the version load reports, and a store with no version row fails the same way", () => {
    dir = mkdtempSync(join(tmpdir(), "morndo-store-"));
    const file = join(dir, "connections.db");
    const store = new SqliteStore(file);
    open.push(store);
    expect(store.version()).toBe(0);
    expect(store.version()).toBe(store.load().version);
    expect(store.save(emptyDirectory(), emptyPolicy(), store.version())).toBe(true);
    expect(store.version()).toBe(1);
    expect(store.version()).toBe(store.load().version);
    store.close();
    open.pop();
    const raw = new Database(file);
    raw.prepare("DELETE FROM cas").run();
    raw.close();
    const again = new SqliteStore(file);
    open.push(again);
    expect(() => again.version()).toThrow(/store is empty/);
    expect(() => again.load()).toThrow(/store is empty/);
  });
});
