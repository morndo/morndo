// The per-node token bucket (the hub's pattern): a full bucket's capacity at once, then refills continuously; on the
// monotonic clock, so a wall-clock jump changes nothing (Review Focus 4).
import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/adapters/rate-limit.ts";

describe("RateLimiter", () => {
  it("lets the capacity through at once, then one token per refill interval, per key", () => {
    let t = 1000;
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 2 }, () => t);
    expect([rl.take("pc"), rl.take("pc"), rl.take("pc"), rl.take("pc")]).toEqual([true, true, true, false]);
    expect(rl.take("mac")).toBe(true);                                               // another key, its own bucket
    t += 500;
    expect([rl.take("pc"), rl.take("pc")]).toEqual([true, false]);
    t += 10_000;
    expect([rl.take("pc"), rl.take("pc"), rl.take("pc"), rl.take("pc")]).toEqual([true, true, true, false]);   // never above capacity
  });

  it("uses the monotonic clock by default: a wall-clock jump neither refills nor drains", () => {
    vi.useFakeTimers({ toFake: ["Date"] });                                          // only the wall clock is faked
    try {
      const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0.001 });
      expect(rl.take("pc")).toBe(true);
      vi.setSystemTime(Date.now() + 3_600_000);                                        // an NTP step or a laptop resume
      expect(rl.take("pc")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("refuses a bad configuration", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(/bad rate limit/);
  });
});
