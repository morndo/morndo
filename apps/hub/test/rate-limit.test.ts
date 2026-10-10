// The token bucket (ADR-0008, A6; design reference: Signal-Server limits/ and validate_rate_limit.lua): per key, a
// capacity that refills continuously; a refusal says how long to wait, rounded up to whole seconds.
import { describe, expect, it } from "vitest";
import { RateLimiter, takeAll } from "../src/adapters/rate-limit.ts";

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };

describe("RateLimiter", () => {
  it("lets a full bucket's capacity through at once, then refuses with the wait", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 0.5 }, c.now);
    expect([rl.take("a"), rl.take("a"), rl.take("a")].every(r => r.ok)).toBe(true);
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSeconds: 2 });          // one token takes 2 s
  });
  it("refills continuously, never above capacity", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, c.now);
    rl.take("a"); rl.take("a");
    c.tick(1000);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    c.tick(60_000);                                                            // a minute idle: full again, not 60
    expect([rl.take("a"), rl.take("a"), rl.take("a")].map(r => r.ok)).toEqual([true, true, false]);
  });
  it("rounds the wait up to whole seconds, never down to an early retry", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1 / 1.2 }, c.now);   // a token every 1.2 s
    rl.take("a");
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSeconds: 2 });          // Signal's mapper would say 1
    c.tick(1150);
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSeconds: 1 });          // 50 ms left: still at least 1
  });
  it("keeps keys apart", () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0.01 }, clock().now);
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    expect(rl.take("b").ok).toBe(true);
  });
  it("forgets keys whose bucket is full again, so idle callers cost nothing", () => {
    const c = clock();
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, c.now);
    for (let i = 0; i < 100; i++) rl.take(`k${i}`);
    expect(rl.size).toBe(100);
    c.tick(1000);
    rl.prune();
    expect(rl.size).toBe(0);
  });
  it("refuses a bad configuration", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow();
  });
  it("takeAll charges every bucket only when all have room: a refusal by one spends nothing of the others (review L6)", () => {
    const c = clock();
    const caller = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, c.now);
    const global = new RateLimiter({ capacity: 1, refillPerSecond: 0.5 }, c.now);
    expect(takeAll([[caller, "owner"], [global, "all"]])).toEqual({ ok: true });
    expect(takeAll([[caller, "owner"], [global, "all"]])).toEqual({ ok: false, retryAfterSeconds: 2 });   // the global one says no
    expect(takeAll([[caller, "owner"], [global, "all"]])).toEqual({ ok: false, retryAfterSeconds: 2 });
    c.tick(2000);
    expect(takeAll([[caller, "owner"], [global, "all"]])).toEqual({ ok: true });                          // the owner's own bucket wasn't spent
  });
});
