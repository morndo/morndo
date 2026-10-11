// The intake window (spec §6, issue #21): hook events of every connection that arrive within 25 ms of the first share
// one commit, synced once; each connection is acknowledged its own stream's mark only once that commit is on the disk
// (another connection to fleet.db sees the rows when the ack is sent); a turn's events are never split, and a steady
// stream is still committed every 25 ms; one connection's failing events roll back alone; a failed commit acknowledges
// no one; a cancelled connection's events are never stored.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { fleetTransactions, openFleetDb, synced } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import type { IntakeConn } from "../src/application/hook-sink.ts";
import { IntakeWindow, type Intake } from "../src/application/intake-window.ts";
import { quiet } from "./helpers/fleet.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { tempDir } from "./helpers/temp.ts";
import { until } from "./helpers/until.ts";

const ALL: Subscriber = { name: "kira", url: "http://127.0.0.1:1/hooks", paths: ["/cc", "/hook/stop"] };
const ev = (node: string, streamId: string, seq: number): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node, window: "api", body: { seq } });

function setup(o: { windowMs?: number; intake?: (real: HookIntake) => Intake; tx?: (db: Database.Database) => ReturnType<typeof fleetTransactions> } = {}) {
  const path = join(tempDir(), "fleet.db");
  const db = openFleetDb(path);
  const syncs = watchSyncs(db);
  const real = new HookIntake({ store: new OutboxStore(db), subscribers: [ALL], audit: new Audit(db) });
  const window = new IntakeWindow({
    intake: o.intake ? o.intake(real) : real, tx: o.tx ? o.tx(db) : fleetTransactions(db), log: quiet, ...(o.windowMs === undefined ? {} : { windowMs: o.windowMs }),
  });
  const reader = new Database(path, { readonly: true });                             // sees only what is committed
  const committed = () => (reader.prepare("SELECT node, stream_id, seq FROM outbox ORDER BY id").all() as { node: string; stream_id: string; seq: number }[])
    .map(r => `${r.node}/${r.stream_id}:${r.seq}`);
  const said: string[] = [];
  const conn = (node: string, streamId: string): IntakeConn => ({
    node, streamId,
    acked: seq => said.push(`acked ${node}/${streamId}:${seq} (${committed().filter(c => c.startsWith(`${node}/${streamId}:`)).length} committed)`),
    failed: () => said.push(`failed ${node}/${streamId}`),
  });
  return { db, syncs, window, committed, said, conn, close: () => { reader.close(); db.close(); } };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("the intake window", () => {
  it("events of two nodes within 25 ms share one commit, synced once, and each is acknowledged its own mark after it", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const mac = t.window.open(t.conn("mac", "s2"));
    pc.add(ev("pc", "s1", 1));
    mac.add(ev("mac", "s2", 1));
    await sleep(5);
    pc.add(ev("pc", "s1", 2));                                                       // later, in the same window
    await until(() => t.said.length === 2);
    expect(t.syncs).toEqual(FULL_THEN_NORMAL);                                       // negative control: windowMs 0 commits twice
    expect(t.said).toEqual(["acked pc/s1:2 (2 committed)", "acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["pc/s1:1", "pc/s1:2", "mac/s2:1"]);
    t.close();
  });

  it("closes 25 ms after its first event however many follow, and never splits one turn's events", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const start = performance.now();
    for (let seq = 1; seq <= 300; seq++) pc.add(ev("pc", "s1", seq));                // one turn: one commit
    await until(() => t.said.length === 1);
    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
    expect(t.said).toEqual(["acked pc/s1:300 (300 committed)"]);
    for (let seq = 301; seq <= 320; seq++) { pc.add(ev("pc", "s1", seq)); await sleep(5); }   // a steady stream for ~100 ms
    await until(() => t.said.at(-1)?.startsWith("acked pc/s1:320") === true);
    expect(t.syncs.length / 2).toBeGreaterThanOrEqual(3);                              // committed every 25 ms, not held open
    t.close();
  });

  it("with windowMs 0 the window is one event-loop turn", async () => {
    const t = setup({ windowMs: 0 });
    const pc = t.window.open(t.conn("pc", "s1"));
    pc.add(ev("pc", "s1", 1));
    pc.add(ev("pc", "s1", 2));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(t.said).toEqual(["acked pc/s1:2 (2 committed)"]);
    t.close();
  });

  it("a cancelled connection's events are never stored nor acknowledged; the others' are", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const mac = t.window.open(t.conn("mac", "s2"));
    pc.add(ev("pc", "s1", 1));
    mac.add(ev("mac", "s2", 1));
    pc.cancel();                                                                      // the fleet closed pc's connection
    await until(() => t.said.length > 0);
    await sleep(40);
    expect(t.said).toEqual(["acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["mac/s2:1"]);
    t.close();
  });

  it("one connection's events that fail roll back alone: it is told, the others commit and are acknowledged", async () => {
    const t = setup({
      intake: real => ({
        known: (n, s) => real.known(n, s),
        store: (n, s, events) => { const r = real.store(n, s, events); if (s === "bad") throw new Error("fleet.db refused it"); return r; },
      }),
    });
    t.window.open(t.conn("pc", "bad")).add(ev("pc", "bad", 1));
    t.window.open(t.conn("mac", "s2")).add(ev("mac", "s2", 1));
    await until(() => t.said.length === 2);
    expect(t.said).toEqual(["failed pc/bad", "acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["mac/s2:1"]);                                     // negative control: no savepoint keeps pc/bad:1
    expect(t.syncs).toEqual(FULL_THEN_NORMAL);
    t.close();
  });

  it("a commit that fails as a whole (its sync) stores nothing and acknowledges no one", async () => {
    const t = setup({
      tx: db => ({
        synced: fn => synced(db, () => db.transaction(() => { fn(); throw new Error("disk I/O error"); }).immediate()),
        savepoint: fn => db.transaction(fn)(),
      }),
    });
    t.window.open(t.conn("pc", "s1")).add(ev("pc", "s1", 1));
    t.window.open(t.conn("mac", "s2")).add(ev("mac", "s2", 1));
    await until(() => t.said.length === 2);
    expect(t.said).toEqual(["failed pc/s1", "failed mac/s2"]);
    expect(t.committed()).toEqual([]);
    expect(t.db.pragma("synchronous", { simple: true })).toBe(1);
    t.close();
  });

  it("stop() commits what the window holds at once", () => {
    const t = setup();
    t.window.open(t.conn("pc", "s1")).add(ev("pc", "s1", 1));
    t.window.stop();
    expect(t.said).toEqual(["acked pc/s1:1 (1 committed)"]);
    t.close();
  });
});
