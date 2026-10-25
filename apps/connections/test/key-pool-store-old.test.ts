// A pool or a grant saved by an earlier build has no `grants`, `seen` or `lent` (ADR-0037, slices 1 and 2). It loads with them empty, so a run in flight
// across an upgrade is not stopped by a missing field, and the store waits a moment for a lock instead of failing at once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyPool, noteLent, noteSeen, type Actor, type KeyPool } from "@morndo/domain";
import { MemoryKeyPoolStore } from "../src/application/index.ts";
import { SqliteKeyPoolStore } from "../src/adapters/key-pool-store-sqlite.ts";
import { SqliteStore, openConnectionsDb } from "../src/adapters/store-sqlite.ts";

const who: Actor = { kind: "principal", command: "c1" };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "morndo-old-grants-"));
  dirs.push(dir);
  return join(dir, "connections.db");
};
const made = ((): KeyPool => {
  const result = createKeyPool({ name: "p", runtime: "r", vendor: "v" }, { connections: [], pools: [], deleted: [] }, who, 1);
  if (!result.ok) throw new Error("pool");
  return result.value;
})();
const grant = {
  id: "gl1", member: "k1", lease: "l1", holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null },
  request: { role: "run", entry: "m", workspacePath: "/w", limit: 8, reserve: 1, margin: 0 }, window: { calls: 1, windowStart: 1 }, previous: null,
};
// The body an earlier build saved: no `grants` at all (slice 1), or a grant with no `seen` and no `lent`.
const oldBody = (withGrant: boolean, name = "p"): string => {
  const body: Record<string, unknown> = {
    ...made, name, members: [{ credential: "k1", joined: 1, health: { state: "active" }, since: 1, lastChange: 1, nextCheck: null, organization: null }],
  };
  delete body.grants;
  if (withGrant) body.grants = [grant];
  return JSON.stringify(body);
};

describe("an older saved pool", () => {
  it("SQLite: a pool with no grants loads with none, and a grant with no seen or lent loads with both empty", () => {
    const path = file();
    const store = new SqliteKeyPoolStore(path);
    const db = new Database(path);
    db.prepare("INSERT INTO key_pool (name, version, body) VALUES (?, 1, ?)").run("old", oldBody(false, "old"));
    db.prepare("INSERT INTO key_pool (name, version, body) VALUES (?, 1, ?)").run("oldg", oldBody(true, "oldg"));
    db.close();
    expect(store.load("old").pool?.grants).toEqual([]);
    const loaded = store.load("oldg").pool;
    expect(loaded?.grants[0]).toMatchObject({ id: "gl1", seen: [], lent: [] });
    if (!loaded) throw new Error("no pool");
    const next = noteSeen(noteLent(loaded, "gl1", "k1"), "gl1", "s", "k1");
    expect(next.grants[0]).toMatchObject({ lent: ["k1"], seen: [{ session: "s", member: "k1" }] });
    store.close();
  });

  it("the in-memory store of the tests normalises the same way", () => {
    const store = new MemoryKeyPoolStore();
    const body = JSON.parse(oldBody(true, "oldm")) as KeyPool;
    expect(store.save(body, 0)).toBe(true);
    expect(store.load("oldm").pool?.grants[0]).toMatchObject({ seen: [], lent: [] });
  });
});

describe("the store waits for a lock", () => {
  it("every adapter that opens the connections database sets a busy timeout of at least a second", () => {
    const path = file();
    const db = openConnectionsDb(path);
    expect(db.pragma("busy_timeout", { simple: true }) as number).toBeGreaterThanOrEqual(1000);
    db.close();
    const store = new SqliteStore(path);
    store.close();
  });
});
