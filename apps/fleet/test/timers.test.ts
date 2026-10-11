// The fleet's timers that touch fleet.db never take the service down (final review M4, Task 13 review): a busy or full
// database makes one round fail, logged, and the next round works. Before the fix such a throw escaped a setInterval or
// a promise's finally, an uncaught exception that ends the process (crash.ts exits 1) and drops every node.
// The delivery loop gets errors with SQLITE_BUSY's code from its store; the liveness sweep gets a real SQLITE_BUSY from
// a second connection that holds fleet.db's write lock.
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { createLogger } from "../src/adapters/log.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker, type Post } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { until } from "./helpers/until.ts";

const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
const ev = (seq: number): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: { seq } });
function capture() {
  const lines: string[] = [];
  return { lines, log: createLogger({ level: "debug", sink: line => { lines.push(line); } }) };
}

// Whatever escapes to the process: an uncaught exception or an unhandled rejection (the real service exits on either).
let escaped: unknown[] = [];
const onEscape = (e: unknown) => { escaped.push(e); };
beforeEach(() => { escaped = []; process.on("uncaughtException", onEscape); process.on("unhandledRejection", onEscape); });
afterEach(() => { process.off("uncaughtException", onEscape); process.off("unhandledRejection", onEscape); });

describe("the hook bus's delivery loop", () => {
  it("a store that throws in a tick or after a delivery is logged; nothing escapes, and the next tick delivers", async () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const real = new OutboxStore(db);
    const fail = { heads: 1, next: 1 };
    // The real store, but its first heads() (a tick's read) and first next() (after a delivery) throw SQLITE_BUSY.
    const store = new Proxy(real, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function") return v;
        if (prop === "heads" || prop === "next") {
          return (...args: unknown[]) => { if (fail[prop] > 0) { fail[prop]--; throw busy(); } return (v as (...a: unknown[]) => unknown).apply(target, args); };
        }
        return (v as (...a: unknown[]) => unknown).bind(target);
      },
    });
    const posted: number[] = [];
    const post: Post = async (_url, body) => { posted.push((JSON.parse(body) as { seq: number }).seq); return 200; };
    const subscribers = [{ name: "kira", url: "http://127.0.0.1:9/h", paths: ["/hook/stop" as const] }];
    const { log, lines } = capture();
    const audit = new Audit(db);
    const worker = new DeliveryWorker({ store, subscribers, audit, log, post, tickMs: 20 });
    new HookIntake({ store: real, subscribers, audit }).accept("pc", "s1", [ev(1), ev(2), ev(3)]);
    worker.start();                                                                  // its first tick throws
    try {
      await vi.waitFor(() => expect(real.states("kira")).toEqual({ delivered: 3 }), { timeout: 5000 });
      expect(posted).toEqual([1, 2, 3]);                                             // in order, each once
      expect(fail).toEqual({ heads: 0, next: 0 });
      expect(lines.filter(l => l.includes("SQLITE_BUSY") || l.includes("database is locked")).length).toBeGreaterThanOrEqual(2);
      expect(escaped).toEqual([]);
    } finally { await worker.stop(); db.close(); }
  });
});

describe("the liveness sweep", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a write lock held elsewhere (SQLITE_BUSY) is logged; every node stays online and is still pinged, nothing escapes, and last seen moves on afterwards", async () => {
    // The sweeps run when the test says, each ping answered before the next, as in liveness.test.ts: on real 50 ms
    // timers a busy event loop let a sweep run before the last pong was read, and the node went stale.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { log, lines } = capture();
    const fleet = await startTestFleet({ log });
    await fleet.online("pc");
    const mac = await fleet.online("mac");                                           // swept after pc
    const pongs = vi.spyOn(fleet.connections, "pong");
    const sweep = async () => {
      const answered = pongs.mock.calls.length + 2;
      vi.advanceTimersByTime(LIMITS.pingMs);
      await until(() => pongs.mock.calls.length === answered);                     // both nodes answered its ping
    };
    fleet.db.pragma("busy_timeout = 0");                                             // a lock fails at once instead of in 5 s
    const locker = new Database(fleet.config.dbPath);
    locker.exec("BEGIN IMMEDIATE");                                                  // another writer holds fleet.db
    try {
      await sweep();
      expect(lines.some(l => l.includes("database is locked"))).toBe(true);
      const before = fleet.nodes.active("pc")?.lastSeenAt ?? 0;
      let macPings = 0;
      mac.ws?.on("ping", () => { macPings++; });
      for (let i = 0; i < 3; i++) await sweep();                                     // several sweeps under the lock
      expect(fleet.connections.status("pc")).toBe("online");
      expect(fleet.connections.status("mac")).toBe("online");
      // pc's last-seen write failing is that node's alone: the sweep goes on to ping mac (the follow-up's control).
      expect(macPings).toBeGreaterThan(0);
      expect(lines.filter(l => l.includes("liveness sweep failed"))).toEqual([]);
      expect(escaped).toEqual([]);
      locker.exec("ROLLBACK");
      await sweep();                                                                 // the next sweep writes again
      expect(fleet.nodes.active("pc")?.lastSeenAt ?? 0).toBeGreaterThan(before);
      expect(fleet.connections.status("pc")).toBe("online");
      expect(escaped).toEqual([]);
    } finally { if (locker.inTransaction) locker.exec("ROLLBACK"); locker.close(); }
  });
});

describe("a refusal fleet.db can't audit", () => {
  it("still closes with its own code (4403 for an unknown node, not 1011), logged, nothing escapes", async () => {
    const { log, lines } = capture();
    const fleet = await startTestFleet({ log });
    fleet.db.pragma("busy_timeout = 0");
    const locker = new Database(fleet.config.dbPath);
    locker.exec("BEGIN IMMEDIATE");
    try {
      expect(await fleet.agent({ node: "stranger" }).connect()).toMatchObject({ ok: false, closed: { code: 4403 } });
      expect(lines.some(l => l.includes("could not audit a refused connection"))).toBe(true);
      expect(escaped).toEqual([]);
    } finally { if (locker.inTransaction) locker.exec("ROLLBACK"); locker.close(); }
  });
});
