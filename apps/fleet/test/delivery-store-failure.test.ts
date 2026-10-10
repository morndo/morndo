// The outcome of a delivery that fleet.db can't record (busy, or full: SQLITE_BUSY and SQLITE_FULL are both possible)
// holds that stream back for an exponential wait, kept in memory (B6 V39). Before, the promise's finally read the
// still-pending row and started it again at once: the same event POSTed in a tight loop (over 1,500 times in 500 ms
// against a real full disk), its attempts never counted, never dead-lettered. The failure here is a real SQLITE_BUSY:
// another connection holds fleet.db's write lock and the service's connection doesn't wait for it (busy_timeout 0).
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { createLogger } from "../src/adapters/log.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (seq: number): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: { seq } });

describe("an outcome write fleet.db refuses", () => {
  it("holds the stream back with an exponential wait instead of POSTing the same event again at once; delivered once writes work", async () => {
    const path = join(tempDir(), "fleet.db");
    const db = openFleetDb(path);
    const store = new OutboxStore(db);
    const audit = new Audit(db);
    const lines: string[] = [];
    const log = createLogger({ level: "debug", sink: l => { lines.push(l); } });
    const kira = await startSubscriber(() => 200);
    const subscribers = [{ name: "kira", url: kira.url, paths: ["/hook/stop" as const] }];
    new HookIntake({ store, subscribers, audit }).accept("pc", "s1", [ev(1)]);
    db.pragma("busy_timeout = 0");
    const worker = new DeliveryWorker({ store, subscribers, audit, log, tickMs: 10, backoff: { baseMs: 100, maxMs: 1000 }, random: () => 1 });
    const locker = new Database(path);
    try {
      worker.start();                                                    // the first POST is in flight
      locker.exec("BEGIN IMMEDIATE");                                   // its outcome write will meet the lock
      await new Promise(r => setTimeout(r, 500));
      const during = kira.received.length;
      expect(during).toBeGreaterThanOrEqual(1);
      expect(during).toBeLessThanOrEqual(4);                             // 0, +100, +300 ms: not hundreds
      expect(lines.some(l => l.includes("delivering to kira failed") && l.includes("waits"))).toBe(true);
      locker.exec("ROLLBACK");
      await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 1 }), { timeout: 5000 });
      expect(new Set(kira.received.map(r => r.key))).toEqual(new Set(["pc:s1:1"]));
    } finally {
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      await worker.stop();
      db.close();
    }
  });
});
