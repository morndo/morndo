// A delivery round (every tick, 1 s, and again after every stored batch) finds each stream's first pending event by an
// index seek per stream (B6 EF2). It grouped every pending row of the subscriber instead: 129 ms a round at a
// 50,000-event backlog (a subscriber down for a while), over half the event loop at 3 events/s, delaying every op,
// ping and file transfer the service handles. fleet.db is filled with plain SQL in the shapes the intake writes: 50,000
// pending rows over three streams, not due for 5 minutes, so the round starts nothing and only reads.
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker } from "../src/application/delivery.ts";
import { quiet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

const BACKLOG = 50_000;

describe("a delivery round at a full backlog", () => {
  it("reads each stream's head by an index seek, not by grouping every pending row", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const insO = db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES (?, ?, ?, '/hook/stop', ?, 0)");
    const insD = db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, 'kira', 'pending', 3, ?, NULL)");
    const hwm = db.prepare("INSERT INTO stream_hwm (node, stream_id, seq) VALUES (?, ?, ?)");
    const body = JSON.stringify({ pad: "x".repeat(600) });
    const later = Date.now() + 300_000;
    db.transaction(() => {
      for (let i = 0; i < BACKLOG; i++) insD.run(Number(insO.run(["pc", "studio", "cp"][i % 3], "s1", Math.floor(i / 3) + 1, body).lastInsertRowid), later);
      for (const node of ["pc", "studio", "cp"]) hwm.run(node, "s1", Math.ceil(BACKLOG / 3));
    })();
    const store = new OutboxStore(db);
    const subscribers = [{ name: "kira", url: "http://127.0.0.1:9/never", paths: ["/hook/stop" as const] }];
    const worker = new DeliveryWorker({ store, subscribers, audit: new Audit(db), log: quiet, tickMs: 60_000 });
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      expect(worker.runOnce()).toBe(0);                                 // nothing due
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(20);                                   // the grouping took 100-250 ms here
    db.close();
  }, 60_000);

  it("walks a stream's delivered rows kept for 24 h once, not every round: later rounds seek from the stream's floor", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const insO = db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES ('pc', 's1', ?, '/sl', '{}', 0)");
    const insD = db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, 'kira', 'delivered', 0, 0, 1)");
    db.transaction(() => {
      for (let seq = 1; seq <= 200_000; seq++) insD.run(Number(insO.run(seq).lastInsertRowid));
      db.prepare("INSERT INTO stream_hwm (node, stream_id, seq) VALUES ('pc', 's1', 200000)").run();
    })();
    const subscribers = [{ name: "kira", url: "http://127.0.0.1:9/never", paths: ["/sl" as const] }];
    const worker = new DeliveryWorker({ store: new OutboxStore(db), subscribers, audit: new Audit(db), log: quiet, tickMs: 60_000 });
    expect(worker.runOnce()).toBe(0);                                   // the first round walks the kept rows once
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      expect(worker.runOnce()).toBe(0);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(5);                                    // a walk of the kept rows takes 40-60 ms here
    db.close();
  }, 60_000);
});
