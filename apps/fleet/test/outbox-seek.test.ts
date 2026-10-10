// After each delivery the worker reads the stream's next pending event (B6 EF1). Delivered rows stay in the outbox for
// 24 h (spec 5.6), and the read walked every one of them in seq order before it found the next pending one: 117 ms
// a read at 432,000 kept rows (5 events/s for a day), half the event loop at 5 events/s. It now seeks from the seq the
// worker just finished, a range on the outbox's (node, stream_id, seq) index (https://www.sqlite.org/optoverview.html:
// "The right-most column that is used can employ inequalities").
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { quiet } from "./helpers/fleet.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const KEPT = 200_000;
const ev = (seq: number): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: { seq } });

describe("the next pending event of a stream", () => {
  it("is found from the seq just finished without walking the stream's delivered rows kept for 24 h", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const insO = db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES ('pc', 's1', ?, '/sl', '{}', 0)");
    const insD = db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, 'kira', ?, 0, 0, ?)");
    db.transaction(() => {
      for (let seq = 1; seq <= KEPT + 1; seq++) insD.run(Number(insO.run(seq).lastInsertRowid), seq <= KEPT ? "delivered" : "pending", seq <= KEPT ? 1 : null);
    })();
    const store = new OutboxStore(db);
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t = performance.now();
      expect(store.next("kira", "pc", "s1", KEPT)?.seq).toBe(KEPT + 1);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[7]).toBeLessThan(5);                                    // the walk took 40-60 ms here
    expect(store.next("kira", "pc", "s1")?.seq).toBe(KEPT + 1);         // from the start: the same answer
    db.close();
  }, 60_000);

  it("is asked for from the seq the worker just finished", async () => {
    const kira = await startSubscriber(() => 200);
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const real = new OutboxStore(db);
    const asked: unknown[][] = [];
    const store = new Proxy(real, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function") return v;
        if (prop === "next") return (...a: unknown[]) => { asked.push(a); return (v as (...x: unknown[]) => unknown).apply(target, a); };
        return (v as (...x: unknown[]) => unknown).bind(target);
      },
    });
    const subscribers = [{ name: "kira", url: kira.url, paths: ["/hook/stop" as const] }];
    const audit = new Audit(db);
    new HookIntake({ store: real, subscribers, audit }).accept("pc", "s1", [ev(1), ev(2), ev(3)]);
    const worker = new DeliveryWorker({ store, subscribers, audit, log: quiet, tickMs: 60_000 });
    worker.start();
    try {
      await vi.waitFor(() => expect(real.states("kira")).toEqual({ delivered: 3 }), { timeout: 5000 });
      await vi.waitFor(() => expect(asked.length).toBe(3));
      expect(asked.map(a => a[3])).toEqual([1, 2, 3]);
    } finally { await worker.stop(); db.close(); }
  });
});
