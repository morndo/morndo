// Two connects must not share one seen buffer. Events that arrive during either GET stay in that read's merge.
import { describe, expect, it } from "vitest";
import { JobResync } from "../src/application/job-resync.ts";

describe("one job resync at a time", () => {
  it("merges events into every list read that was already in flight", async () => {
    const sync = new JobResync<string>();
    let releaseA!: (list: string) => void;
    let releaseB!: (list: string) => void;
    const merges: { list: string; seen: string[] }[] = [];
    const first = sync.run(() => new Promise<string>(resolve => { releaseA = resolve; }), (list, seen) => { merges.push({ list, seen: [...seen] }); });
    const second = sync.run(() => new Promise<string>(resolve => { releaseB = resolve; }), (list, seen) => { merges.push({ list, seen: [...seen] }); });
    expect(sync.listing).toBe(true);
    await Promise.resolve();
    sync.note("exited");
    releaseA("old-list");
    await first;
    expect(sync.listing).toBe(true);
    expect(merges).toEqual([{ list: "old-list", seen: ["exited"] }]);
    await Promise.resolve();
    sync.note("later");
    releaseB("next-list");
    await second;
    expect(merges[1]).toEqual({ list: "next-list", seen: ["exited", "later"] });
    expect(sync.listing).toBe(false);
    sync.note("after");
    expect(sync.listing).toBe(false);
  });
});
