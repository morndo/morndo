// Hook delivery (spec 5.6): a JSON POST per subscriber with Idempotency-Key <node>:<streamId>:<seq>; seq order per
// stream; exponential backoff on 408, 429, 5xx and no answer; any other 4xx or the 20th failure is a dead letter while
// the other subscribers continue, with one alert per subscriber episode; removed subscribers' rows go; rows go 24 h
// after delivery.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker, type Post } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { quiet } from "./helpers/fleet.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (streamId: string, seq: number, path: HookEvent["path"] = "/hook/stop"): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path, node: "pc", window: "api", body: { seq } });
const FAST = { baseMs: 5, maxMs: 40 };

function bus(subscribers: Subscriber[], o: { post?: Post; now?: () => number; db?: ReturnType<typeof openFleetDb> } = {}) {
  const db = o.db ?? openFleetDb(join(tempDir(), "fleet.db"));
  const store = new OutboxStore(db);
  const audit = new Audit(db);
  const worker = new DeliveryWorker({ store, subscribers, audit, log: quiet, backoff: FAST, random: () => 1, tickMs: 10, ...(o.post ? { post: o.post } : {}), ...(o.now ? { now: o.now } : {}) });
  const intake = new HookIntake({ store, subscribers, audit, onStored: () => worker.kick(), ...(o.now ? { now: o.now } : {}) });
  return { db, store, audit, worker, intake };
}
const sub = (name: string, url: string): Subscriber => ({ name, url, paths: ["/cc", "/hook/stop"] });

describe("hook delivery", () => {
  it("POSTs each event as JSON with its idempotency key, and marks it delivered", async () => {
    const kira = await startSubscriber();
    const { intake, worker, store } = bus([sub("kira", kira.url)]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 2, "/cc")]);
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 2 }));
    expect(kira.received.map(r => [r.key, r.contentType, r.body.seq, r.body.path])).toEqual([
      ["pc:s1:1", "application/json", 1, "/hook/stop"], ["pc:s1:2", "application/json", 2, "/cc"],
    ]);
    expect(kira.received[0]?.body).toEqual(ev("s1", 1));
    await worker.stop();
  });

  it("keeps seq order per stream through retries: 3 waits until 2 is delivered", async () => {
    const kira = await startSubscriber((r, attempt) => (r.body.seq === 2 && attempt < 3 ? 503 : 200));
    const { intake, worker, store } = bus([sub("kira", kira.url)]);
    worker.start();
    intake.accept("pc", "s1", [1, 2, 3, 4].map(n => ev("s1", n)));
    intake.accept("pc", "s2", [1, 2].map(n => ev("s2", n)));
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 6 }));
    const order = kira.received.filter(r => r.body.streamId === "s1").map(r => r.body.seq);
    expect(order).toEqual([1, 2, 2, 2, 3, 4]);                                        // never 3 before the last 2
    await worker.stop();
  });

  it("a 400 is a dead letter with an alert at once; that subscriber's next event and the other subscriber continue", async () => {
    const picky = await startSubscriber(r => (r.body.seq === 2 ? 400 : 200));
    const other = await startSubscriber();
    const { intake, worker, store, audit } = bus([sub("picky", picky.url), sub("other", other.url)]);
    worker.start();
    intake.accept("pc", "s1", [1, 2, 3].map(n => ev("s1", n)));
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ delivered: 2, dead: 1 }));
    await vi.waitFor(() => expect(store.states("other")).toEqual({ delivered: 3 }));
    expect(picky.received.filter(r => r.body.seq === 2)).toHaveLength(1);              // never retried
    expect(store.deadLetters("picky").map(d => [d.seq, d.reason, d.attempts])).toEqual([[2, "HTTP 400", 1]]);
    expect(audit.of("alert.dead_letter").map(a => a.detail)).toEqual([expect.objectContaining({ subscriber: "picky", seq: 2, reason: "HTTP 400" })]);
    await worker.stop();
  });

  it("one dead_letter alert per subscriber episode: the first dead letter after a successful delivery raises the next one", async () => {
    const picky = await startSubscriber(r => ([2, 3, 4, 6].includes(r.body.seq) ? 400 : 200));
    const { intake, worker, store, audit } = bus([sub("picky", picky.url)]);
    worker.start();
    intake.accept("pc", "s1", [2, 3, 4].map(n => ev("s1", n)));                       // three dead letters in a row
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ dead: 3 }));
    expect(audit.of("alert.dead_letter").map(a => a.detail.seq)).toEqual([2]);       // negative control: one per dead letter gives 3
    intake.accept("pc", "s1", [5, 6].map(n => ev("s1", n)));                          // 5 is delivered, so 6 starts a new episode
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ dead: 4, delivered: 1 }));
    expect(audit.of("alert.dead_letter").map(a => a.detail.seq)).toEqual([2, 6]);
    expect(store.deadLetters("picky").map(d => d.seq)).toEqual([2, 3, 4, 6]);        // every dead letter is kept
    await worker.stop();
  });

  it("retries 408, 429, 5xx and no answer; the 20th failure is a dead letter", async () => {
    const statuses = [408, 429, 500, 503];
    const flaky = await startSubscriber((_r, attempt) => statuses[attempt - 1] ?? 200);
    const down = await startSubscriber(() => 503);
    const { intake, worker, store } = bus([sub("flaky", flaky.url), sub("down", down.url), sub("gone", "http://127.0.0.1:9/hooks")]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1)]);
    await vi.waitFor(() => expect(store.states("flaky")).toEqual({ delivered: 1 }));
    await vi.waitFor(() => expect(store.states("down")).toEqual({ dead: 1 }), { timeout: 10_000 });
    await vi.waitFor(() => expect(store.states("gone")).toEqual({ dead: 1 }), { timeout: 10_000 });
    expect(down.received).toHaveLength(LIMITS.deadLetterAttempts);
    expect(store.deadLetters("down")[0]).toMatchObject({ reason: "HTTP 503", attempts: 20 });
    expect(store.deadLetters("gone")[0]?.reason).toMatch(/^no answer/);
    await worker.stop();
  });

  it("a retry time beyond the longest backoff (a clock that jumped back) is due at once", async () => {
    let now = 1_800_000_000_000;
    const kira = await startSubscriber();
    const { intake, worker, store } = bus([sub("kira", kira.url)], { now: () => now });
    intake.accept("pc", "s1", [ev("s1", 1)]);
    const d = store.next("kira", "pc", "s1");
    store.retry(d?.outboxId ?? 0, "kira", 1, now + 30);                               // due in 30 ms: not yet
    expect(worker.runOnce()).toBe(0);
    now -= 3_600_000;                                                                  // the clock steps back an hour
    expect(worker.runOnce()).toBe(1);
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 1 }));
    await worker.stop();
  });

  it("a subscriber removed from the config has its rows deleted on start", async () => {
    const kira = await startSubscriber(() => 503);
    const first = bus([sub("kira", kira.url), sub("old", "http://127.0.0.1:9/hooks")]);
    first.intake.accept("pc", "s1", [ev("s1", 1)]);
    expect(first.store.states("old")).toEqual({ pending: 1 });
    const after = bus([sub("kira", kira.url)], { db: first.db });
    after.worker.start();
    expect(after.store.states("old")).toEqual({});
    expect(after.audit.of("subscriber.removed").map(a => a.detail)).toEqual([{ rows: 1 }]);
    await after.worker.stop();
  });

  it("deletes an event 24 h after its last delivery, and never one still pending", async () => {
    let now = 1_800_000_000_000;
    const kira = await startSubscriber();
    const { intake, worker, store, db } = bus([sub("kira", kira.url), sub("down", "http://127.0.0.1:9/hooks")], { now: () => now });
    intake.accept("pc", "s1", [ev("s1", 1)]);
    intake.accept("pc", "s2", [ev("s2", 1, "/sl")]);                                   // nobody takes /sl: never stored
    const d = store.next("kira", "pc", "s1");
    store.delivered(d?.outboxId ?? 0, "kira", now);
    now += LIMITS.outboxKeepMs + 1;
    worker.gc();
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });    // "down" still has it pending
    const dd = store.next("down", "pc", "s1");
    if (!dd) throw new Error("no delivery for down");
    store.deadLetter(dd, "HTTP 410", 1, now);
    now += LIMITS.outboxKeepMs + 1;
    worker.gc();
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    await worker.stop();
  });

  it("stopping aborts a delivery in flight and leaves it pending for the next start", async () => {
    let release: (s: number) => void = () => {};
    const slow = await startSubscriber(() => new Promise<number>(r => { release = r; }));
    const { intake, worker, store } = bus([sub("slow", slow.url)]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1)]);
    await vi.waitFor(() => expect(slow.received).toHaveLength(1));
    await worker.stop();
    release(200);
    expect(store.states("slow")).toEqual({ pending: 1 });
  });
});
