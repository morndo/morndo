// Two-phase done keys (spec §5.3 "Idempotency") on a real agent database.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { durably, type WalSync } from "../src/db/wal-sync.ts";
import { DoneKeys, EFFECT_FIELDS, argsHash, stableJson } from "../src/ops/done-keys.ts";
import { tempHome } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function keys(now?: () => number, o: { disabled?: boolean } = {}) {
  return keysOn(now, o).keys;
}
function keysOn(now?: () => number, o: { disabled?: boolean; walSync?: WalSync } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  return { keys: new DoneKeys(adb.db, now, o), adb };
}
const storedSeq = (adb: AgentDb) => (adb.db.prepare("SELECT seq FROM store_seq").get() as { seq: number }).seq;

describe("done keys", () => {
  it("hash arguments alike whatever their key order", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(argsHash("pane.send", { text: "hi", workerId: "pc.0a1b2c3d.1" })).toBe(argsHash("pane.send", { workerId: "pc.0a1b2c3d.1", text: "hi" }));
    expect(argsHash("pane.send", { text: "hi" })).not.toBe(argsHash("pane.send", { text: "ho" }));
  });
  it("hash only what decides the effect: never the expectation (plan Contracts, \"Behaviour the agent and the fleet agree on\")", () => {
    const W = "pc.0a1b2c3d.1";
    const send = (o: Record<string, unknown>) => argsHash("pane.send", { workerId: W, text: "hi", expect: { server: "0a1b2c3d", window: "api" }, ...o });
    expect(send({ expect: { server: "0a1b2c3d", window: "api", sessionId: "3f0c1d2e-1111-4222-8333-444455556666" } })).toBe(send({}));
    expect(send({ text: "ho" })).not.toBe(send({}));
    expect(send({ workerId: "pc.0a1b2c3d.2" })).not.toBe(send({}));
    expect(argsHash("lane.start", { name: "a", cwd: "/w" })).not.toBe(argsHash("lane.start", { name: "a", cwd: "/w", account: "acct" }));
    expect(argsHash("file.put", { upload: "u", offset: 0, bytes: "AA==", final: false, name: "a" })).toBe(argsHash("file.put", { upload: "u", offset: 0, bytes: "AA==", final: false, name: "b" }));
    expect(argsHash("file.put", { upload: "u", offset: 0 })).not.toBe(argsHash("file.put", { upload: "u", offset: 4 }));
    expect(EFFECT_FIELDS["pane.send"]).toEqual(["workerId", "text"]);
  });
  it("go none → started → done, and a done key keeps its outcome", async () => {
    const k = keys();
    const h = argsHash("pane.send", { text: "x" });
    expect(k.lookup("hub:a", h)).toEqual({ state: "none" });
    expect(k.status("hub:a")).toEqual({ state: "unknown" });
    expect(await k.start("hub:a", h)).toBe(true);
    expect(k.lookup("hub:a", h)).toEqual({ state: "started" });
    expect(k.status("hub:a")).toEqual({ state: "started" });
    k.finish("hub:a", { problem: null, typedAt: 5 });
    expect(k.lookup("hub:a", h)).toEqual({ state: "done", outcome: { problem: null, typedAt: 5 } });
    expect(k.status("hub:a")).toEqual({ state: "done", outcome: { problem: null, typedAt: 5 } });
  });
  it("release a started key (a refusal before the side effect) but never a done one", async () => {
    const k = keys();
    await k.start("hub:b", "h");
    k.release("hub:b");
    expect(k.status("hub:b")).toEqual({ state: "unknown" });
    await k.start("hub:c", "h");
    k.finish("hub:c", { ok: true });
    k.release("hub:c");
    expect(k.status("hub:c")).toMatchObject({ state: "done" });
  });
  it("tell a key reused with other arguments", async () => {
    const k = keys();
    await k.start("hub:d", "one");
    expect(k.lookup("hub:d", "two")).toEqual({ state: "mismatch" });
    expect(await k.start("hub:d", "one")).toBe(false);                     // already recorded
  });
  it("record and consult nothing when disabled (the noDoneKeys test hook)", async () => {
    const k = keys(undefined, { disabled: true });
    expect(await k.start("hub:x", "h")).toBe(true);
    expect(await k.start("hub:x", "h")).toBe(true);                       // nothing was recorded: it starts again
    expect(k.lookup("hub:x", "h")).toEqual({ state: "none" });
    expect(k.lookup("hub:x", "other")).toEqual({ state: "none" });   // not even a mismatch
    k.finish("hub:x", { ok: true });
    expect(k.status("hub:x")).toEqual({ state: "unknown" });
  });
  it("count every keyed op started in the store sequence, committed with its started row, never lowered (final review I2)", async () => {
    const { keys: k, adb } = keysOn();
    expect(k.seq()).toBe(0);
    expect(await k.start("hub:a", "h")).toBe(true);
    expect(await k.start("hub:b", "h")).toBe(true);
    expect([k.seq(), storedSeq(adb)]).toEqual([2, 2]);
    expect(await k.start("hub:a", "h")).toBe(false);                       // already recorded: not started again, not counted
    k.finish("hub:a", { ok: true });
    k.release("hub:b");                                               // a refusal after started: the count stays
    expect(k.prune()).toBe(0);
    expect([k.seq(), storedSeq(adb)]).toEqual([2, 2]);
    expect(new DoneKeys(adb.db).seq()).toBe(2);                       // read back as stored (an agent restarted)
  });
  it("commit the started row and the store sequence together: one that can't be counted isn't written", async () => {
    const { keys: k, adb } = keysOn();
    adb.db.exec("CREATE TRIGGER no_count BEFORE UPDATE ON store_seq BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(k.start("hub:a", "h")).rejects.toThrow(/disk full/);
    expect(k.status("hub:a")).toEqual({ state: "unknown" });          // the started row went with it
    expect([k.seq(), storedSeq(adb)]).toEqual([0, 0]);
    adb.db.exec("DROP TRIGGER no_count");
    expect(await k.start("hub:a", "h")).toBe(true);
    expect([k.seq(), storedSeq(adb)]).toEqual([1, 1]);
  });
  it("count nothing when disabled (the noDoneKeys test hook)", async () => {
    const { keys: k, adb } = keysOn(undefined, { disabled: true });
    await k.start("hub:x", "h");
    expect([k.seq(), storedSeq(adb)]).toEqual([0, 0]);
  });
  it("are pruned after 7 days", async () => {
    let now = 1_000_000_000_000;
    const k = keys(() => now);
    await k.start("hub:old", "h");
    now += 7 * 24 * 3_600_000 + 1;
    await k.start("hub:new", "h");
    expect(k.prune()).toBe(1);
    expect(k.status("hub:old")).toEqual({ state: "unknown" });
    expect(k.status("hub:new")).toEqual({ state: "started" });
  });
});

// Spec §16.4: `started` is the one commit made durable — an ordinary NORMAL commit, then the WAL's sync off the event
// loop (db/wal-sync.ts), the same durability synchronous=FULL gave there. The database's own setting never moves off
// NORMAL (db/open.ts), so the hooks and `done` never wait for a sync, and finish, release and prune never sync at all.
describe("the started commit, made durable", () => {
  // What the store asks of the connection: any change of the synchronous setting (there must be none), in order.
  const watch = (adb: AgentDb) => {
    const seen: string[] = [];
    const pragma = adb.db.pragma.bind(adb.db);
    adb.db.pragma = ((source: string, options?: { simple?: boolean }) => {
      if (/^synchronous\s*=/.test(source)) seen.push(source);
      return pragma(source, options as never);
    }) as typeof adb.db.pragma;
    return seen;
  };
  it("commits at NORMAL, then syncs the WAL; finish and release never sync, and the setting never moves", async () => {
    const syncs: string[] = [];
    const { keys, adb } = keysOn(undefined, { walSync: async () => { syncs.push("sync"); } });
    const seen = watch(adb);
    expect(await keys.start("hub:a", "h")).toBe(true);
    expect(seen).toEqual([]);                                  // the commit ran at NORMAL: no switch, ever
    expect(syncs).toEqual(["sync"]);
    keys.finish("hub:a", { ok: true });
    expect(await keys.start("hub:b", "h")).toBe(true);
    keys.release("hub:b");
    expect(syncs).toEqual(["sync", "sync"]);                   // only the starts
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);
  });
  it("a start that found its key still answers false through its sync; one whose commit failed never reaches one", async () => {
    let syncs = 0;
    const { keys, adb } = keysOn(undefined, { walSync: async () => { syncs += 1; } });
    expect(await keys.start("hub:a", "h")).toBe(true);
    expect(await keys.start("hub:a", "h")).toBe(false);        // already recorded: uncertain, not started again
    expect(syncs).toBe(1);                                     // another attempt's row: not this call's to sync
    adb.db.exec("DROP TABLE store_seq");                       // the transaction now fails part way
    await expect(keys.start("hub:c", "h")).rejects.toThrow();
    expect(syncs).toBe(1);                                     // a commit that threw never reaches the sync
    expect(adb.db.prepare("SELECT key FROM done_keys WHERE key = 'hub:c'").get()).toBeUndefined();   // rolled back
  });
  it("a sync that fails after the commit takes the started row back; the count it reports never moved", async () => {
    let failing = true;
    const { keys, adb } = keysOn(undefined, { walSync: async () => { if (failing) throw new Error("the disk went away"); } });
    await expect(keys.start("hub:a", "h")).rejects.toThrow(/the disk went away/);
    expect(keys.status("hub:a")).toEqual({ state: "unknown" }); // not durable: it must not stand as started
    // The stored count stays one up (it is never lowered: a start in flight beside this one may hold the next number);
    // what answers carry never counted the row that was taken back.
    expect([keys.seq(), storedSeq(adb)]).toEqual([0, 1]);
    failing = false;
    expect(await keys.start("hub:a", "h")).toBe(true);          // a retry starts again
    expect([keys.seq(), storedSeq(adb)]).toEqual([2, 2]);
  });
  it("two starts whose syncs finish out of order never lower the sequence", async () => {
    const gates: (() => void)[] = [];                          // each sync lands only when its gate opens
    const { keys, adb } = keysOn(undefined, { walSync: () => new Promise<void>(resolve => { gates.push(resolve); }) });
    const first = keys.start("hub:a", "h");
    const second = keys.start("hub:b", "h");
    gates[1]?.();                                              // the second's sync lands first
    expect(await second).toBe(true);
    expect(keys.seq()).toBe(2);
    gates[0]?.();                                              // the first's, committed earlier, lands now
    expect(await first).toBe(true);
    expect([keys.seq(), storedSeq(adb)]).toEqual([2, 2]);      // never back to 1
  });
});

describe("durably, misused", () => {
  it("refuses to run inside another transaction, and leaves that one as it was", async () => {
    const { adb } = keysOn();
    adb.db.exec("BEGIN");
    await expect(durably(adb.db, async () => {}, () => 1)).rejects.toThrow("can't be nested");
    expect(adb.db.inTransaction).toBe(true);                   // the outer transaction is left as it was
    adb.db.exec("ROLLBACK");
    expect(adb.db.inTransaction).toBe(false);
    expect(adb.db.pragma("synchronous", { simple: true })).toBe(1);
  });
});
