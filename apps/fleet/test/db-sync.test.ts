// The fleet core's §16.4 rule in fleet.db (fleet clients spec §6, issue #21): the database runs synchronous=NORMAL, with
// macOS's full flush for what is synced, and only what must outlive the machine is committed under FULL, each as its own
// transaction: a join and a revocation (a node's key), a node's next connection epoch (a fencing token), and the intake
// (intake-window.test.ts). Issuing a code, `seen` and the source are not synced.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb, synced } from "../src/adapters/db.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { newKey } from "./helpers/fake-agent.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { tempDir } from "./helpers/temp.ts";


describe("fleet.db's commits (spec §6)", () => {
  it("runs NORMAL, with fullfsync", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.pragma("fullfsync", { simple: true })).toBe(1);
    db.close();
  });

  it("synced() runs its transaction under FULL and the connection is NORMAL after it, committed or failed", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const seen = watchSyncs(db);
    expect(synced(db, () => db.transaction(() => db.prepare("INSERT INTO sticky_lanes (name, node, at) VALUES ('m', 'pc', 1)").run().changes)())).toBe(1);
    expect(seen).toEqual(FULL_THEN_NORMAL);
    expect(() => synced(db, () => db.transaction(() => { db.prepare("INSERT INTO sticky_lanes (name, node, at) VALUES ('n', 'pc', 1)").run(); throw new Error("boom"); })())).toThrow("boom");
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sticky_lanes").all()).toEqual([{ name: "m" }]);   // the failed one rolled back
    db.close();
  });

  it("synced() refuses to run inside another transaction, and leaves that one as it was", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const outer = db.transaction(() => synced(db, () => 1));
    expect(() => outer()).toThrow("can't be nested");
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });

  it("a join, a revocation and a new connection epoch are synced; a code, `seen` and the source are not", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const nodes = new NodesStore(db);
    const seen = watchSyncs(db);
    const issued = nodes.issueCode("pc");
    if (!issued.ok) throw new Error("no code");
    expect(seen).toEqual([]);                                                        // a lost code is issued again
    expect(nodes.redeem(issued.code, "pc", newKey().publicKey)).toEqual({ ok: true, node: "pc" });
    expect(seen).toEqual(FULL_THEN_NORMAL);
    expect(nodes.nextEpoch("pc")).toBe(1);
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    nodes.seen("pc", "agent/1");
    nodes.recordSource("pc", "100.64.0.7");
    expect(seen).toHaveLength(4);
    expect(nodes.revoke("pc")).toBe(true);
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });
});
