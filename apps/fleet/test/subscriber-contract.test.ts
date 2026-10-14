// The hook bus's side of the subscriber contract (fleet clients spec §6): how an answer is classified, and
// subscriber_lagging when a subscriber's oldest undelivered event is older than 60 s, once per episode: a subscriber
// that keeps answering 503 (the contract broken: a refusal for a reason of its own) holds its stream, loses nothing,
// and raises one alert until it catches up.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker, outcomeOf } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { quiet } from "./helpers/fleet.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (seq: number, streamId = "s1"): HookEvent => ({ streamId, seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: { seq } });

describe("the subscriber contract, the bus's side", () => {
  it("classifies every answer: 2xx delivered, a 4xx other than 408 and 429 dead, everything else tried again", () => {
    const cases: [number | null, string][] = [
      [200, "delivered"], [202, "delivered"], [204, "delivered"], [299, "delivered"],
      [400, "dead"], [404, "dead"], [410, "dead"], [499, "dead"],
      [408, "retry"], [429, "retry"], [500, "retry"], [503, "retry"], [302, "retry"], [101, "retry"], [null, "retry"],
    ];
    for (const [status, outcome] of cases) expect(outcomeOf(status), String(status)).toBe(outcome);
  });

  it("a subscriber that keeps refusing raises subscriber_lagging once its oldest event is 60 s old, once per episode, and loses nothing", async () => {
    let offset = 0;                                                                    // a clock that runs, and jumps when a test says so
    const now = () => Date.now() + offset;
    let refuse = true;
    const kira = await startSubscriber(() => (refuse ? 503 : 200));
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const store = new OutboxStore(db);
    const audit = new Audit(db);
    const subscribers: Subscriber[] = [{ name: "kira", url: kira.url, paths: ["/hook/stop"] }];
    const worker = new DeliveryWorker({ store, subscribers, audit, log: quiet, backoff: { baseMs: 5, maxMs: 20 }, random: () => 1, tickMs: 10, now });
    const intake = new HookIntake({ store, subscribers, audit, now, onStored: () => worker.kick() });
    worker.start();
    intake.accept("pc", "s1", [ev(1), ev(2)]);
    intake.accept("pc", "s2", [ev(1, "s2")]);                                         // a second stream waits as well
    const lagging = () => audit.of("alert.subscriber_lagging").map(a => [a.node, a.detail]);
    offset += LIMITS.subscriberLagMs - 1000;
    await new Promise(r => setTimeout(r, 50));
    expect(lagging()).toEqual([]);                                                    // 59 s: not yet
    offset += 2000;
    await vi.waitFor(() => expect(lagging()).toHaveLength(1));                       // the worker's own tick checks (every 10 ms here)
    await new Promise(r => setTimeout(r, 50));                                        // more ticks: still one
    expect(lagging()).toEqual([["pc", { subscriber: "kira", oldestAgeMs: expect.any(Number), streams: 2 }]]);
    expect((lagging()[0]?.[1] as { oldestAgeMs?: number } | undefined)?.oldestAgeMs).toBeGreaterThan(LIMITS.subscriberLagMs);
    expect(kira.received.filter(r => r.body.streamId === "s1").every(r => r.body.seq === 1)).toBe(true);   // 2 waits behind the refused 1
    refuse = false;                                                                    // it catches up: the episode ends
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 3 }));
    await new Promise(r => setTimeout(r, 30));
    refuse = true;
    intake.accept("pc", "s1", [ev(3)]);
    offset += LIMITS.subscriberLagMs + 1000;
    await vi.waitFor(() => expect(lagging()).toHaveLength(2));                       // negative control: no episode ends, one
    expect(lagging().map(([, d]) => (d as { streams: number }).streams)).toEqual([2, 1]);
    await worker.stop();
    db.close();
  });
});
