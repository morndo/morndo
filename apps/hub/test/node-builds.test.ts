// The nodes' builds (B11): the fleet's node listing on an interval, kept as the last one that answered, so a node that
// reports nothing for a while still counts with its last build. A fake source and fake timers; synthetic commits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeBuilds } from "../src/application/node-builds.ts";

type Listing = { name: string; commit?: string | null }[];
const sha = (c: string) => c.repeat(40);

describe("the nodes' builds (B11)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the fleet's node listing: the commit each node reports, or the last one it did", async () => {
    let listing: Listing = [{ name: "pc", commit: sha("a") }, { name: "srv01" }];
    const builds = new NodeBuilds({ source: async () => listing });
    await builds.refresh();
    expect(builds.list()).toEqual([{ node: "pc", commit: sha("a") }, { node: "srv01", commit: null }]);
    // srv01 reports one; pc goes quiet: its last build still counts
    listing = [{ name: "pc", commit: null }, { name: "srv01", commit: sha("b") }];
    await builds.refresh();
    expect(builds.list()).toEqual([{ node: "pc", commit: sha("a") }, { node: "srv01", commit: sha("b") }]);
    // a node the listing no longer names is forgotten, whole: back again, it starts from what it says
    listing = [{ name: "srv01", commit: sha("b") }];
    await builds.refresh();
    expect(builds.list()).toEqual([{ node: "srv01", commit: sha("b") }]);
    listing = [{ name: "pc" }];
    await builds.refresh();
    expect(builds.list()).toEqual([{ node: "pc", commit: null }]);
  });

  it("a commit that isn't 40 lowercase hex is no commit", async () => {
    const builds = new NodeBuilds({
      source: async () => [{ name: "pc", commit: "XYZ12345" }, { name: "srv01", commit: "a".repeat(41) }, { name: "hub", commit: 7 as unknown as string }],
    });
    await builds.refresh();
    expect(builds.list()).toEqual([{ node: "pc", commit: null }, { node: "srv01", commit: null }, { node: "hub", commit: null }]);
  });

  it("a failed listing keeps the last list and warns once per streak, never throwing", async () => {
    const warnings: string[] = [];
    let fail = false;
    const builds = new NodeBuilds({
      source: async () => { if (fail) throw new Error("the fleet is down"); return [{ name: "pc", commit: sha("c") }]; },
      log: { warn: m => warnings.push(m) },
    });
    await builds.refresh();
    fail = true;
    await expect(builds.refresh()).resolves.toBeUndefined();
    await expect(builds.refresh()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);                                  // once per streak
    expect(builds.list()).toEqual([{ node: "pc", commit: sha("c") }]); // the last list stands
    fail = false;
    await builds.refresh();
    fail = true;
    await builds.refresh();
    expect(warnings).toHaveLength(2);                                  // a new streak warns again
  });

  it("start() refreshes now and then on an interval; stop() ends it", async () => {
    let calls = 0;
    let listing: Listing = [];
    const builds = new NodeBuilds({ everyMs: 15_000, source: async () => { calls++; return listing; } });
    builds.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);                                             // the first refresh is now
    expect(builds.list()).toEqual([]);
    listing = [{ name: "pc", commit: sha("d") }];
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(2);
    expect(builds.list()).toEqual([{ node: "pc", commit: sha("d") }]);
    builds.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);                                             // no refresh after stop
  });
});
