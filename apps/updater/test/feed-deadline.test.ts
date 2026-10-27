// The install-time check gets one budget (§10.3): every fetch it makes is given what is left of it, and none starts
// after it ran out, so a key walk of many documents cannot add up to more than the budget.
import { describe, expect, it } from "vitest";
import { DeadlineFeed } from "../src/adapters/feed-deadline.ts";
import { FetchFailed, type ReleaseFeed } from "../src/application/ports.ts";
import { FakeFeed } from "./helpers/fakes.ts";

describe("DeadlineFeed", () => {
  it("opens the feed with what is left of the budget for each fetch, and refuses once nothing is left", async () => {
    let now = 1_000;
    const limits: number[] = [];
    const inner = new FakeFeed();
    const feed = new DeadlineFeed({
      until: 1_000 + 60_000,
      now: () => now,
      open: (limitMs): ReleaseFeed => { limits.push(limitMs); return inner; },
    });
    await feed.keySet(2);
    now += 45_000;
    await feed.keySet(3);
    expect(limits).toEqual([60_000, 15_000]);
    now += 15_000;
    await expect(feed.keySet(4)).rejects.toMatchObject({ name: "FetchFailed", reason: "timeout" });
    await expect(feed.channel("stable")).rejects.toBeInstanceOf(FetchFailed);
    await expect(feed.manifest("https://feed.example.invalid/m.json", 10)).rejects.toBeInstanceOf(FetchFailed);
    expect(inner.calls.keySets).toEqual([2, 3]);       // nothing reached the host after the budget ran out
    expect(inner.calls.channels).toEqual([]);
  });
});
